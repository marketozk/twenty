# LOG195 - Дизайн транзакционного аудита управления ключами подписи JWT (`signingKey` в `core."signingKey"`)

## Цель и границы
Закрыть транзакционный аудит жизненного цикла ключей подписи JWT в `core."signingKey"`:
- `JwtKeyManagerService.revokeSigningKey` (вызывается из `AdminPanelResolver.revokeSigningKey` -> `AdminPanelSigningKeyService.revokeSigningKey`)
- `JwtKeyManagerService.rotateCurrent` (атомарное снятие `isCurrent` / зануление `privateKey` у прежнего ключа и вставка нового ключа под одним `operationId`)
- `JwtKeyManagerService.generateAndPersistCurrent` (первичная генерация текущего ключа подписи при наличии активного рабочего пространства)
- `AdminPanelSigningKeyService.revokeSigningKey` и `AdminPanelResolver.revokeSigningKey` (проброс `auditIdentity` и имперсонации)

Вне границ `LOG195`:
- Файл `signing-key-rotation.service.ts` помечен `/* @license Enterprise */` и не изменяется; `JwtKeyManagerService.rotateCurrent()` поддерживает как явный `auditIdentity`, так и системный вызов без `auditIdentity` (из cron ротации).
- Инвалидация кэша `coreEntityCacheService.invalidate('signingKeyPublicKey', ...)` и `invalidateCurrentSigningKeyLocalCache()` выполняются строго после успешного `COMMIT`.

## Модель аудита и сокрытие криптографического материала
- Новый `CrmAuditResourceKind`: `'signingKey'` в `crm-audit.types.ts`.
- `CATALOG.signingKey` в `crm-audit-transaction-context.ts`:
  - `values: ['isCurrent', 'hasPrivateKey']`
  - `redacted: ['publicKey', 'privateKey', 'revokedAt']`
- `ADMINISTRATIVE_ACTIONS.signingKey`: `['create', 'update']`.
- `securityDescriptor`: `{ resourceKind: 'signingKey', resourceId, metadataAccess: 'currentWorkspaceAdministration' }`.
- Проекция `projectSigningKey(row)`:
  - `isCurrent`: `Boolean(row.isCurrent)`
  - `hasPrivateKey`: `row.privateKey !== null && row.privateKey !== undefined && String(row.privateKey).length > 0`
  - `publicKey`: `String(row.publicKey)` (редактируется в `redacted`)
  - `privateKey`: `row.privateKey === null || row.privateKey === undefined ? null : String(row.privateKey)` (редактируется в `redacted`, никогда не попадает в `values`)
  - `revokedAt`: `row.revokedAt === null || row.revokedAt === undefined ? null : String(row.revokedAt)` (редактируется в `redacted`)

## Транзакционные раннеры (`workspace-domain-audit.ts`)
1. `runAuditedSigningKeyRevoke`:
   - Всегда требует аутентифицированный `WorkspaceDomainAuditRequest` (fail-closed при отсутствии `auditIdentity`).
   - `SET LOCAL lock_timeout = '8s'`.
   - Блокирует `core.workspace` (`FOR NO KEY UPDATE`), проверяет `deletedAt IS NULL`, резолвит актора/имперсонацию (`resolveWorkspaceDomainOperation`).
   - Блокирует целевую строку `core."signingKey"` по `id` (`FOR UPDATE`). Если строка не найдена - передаёт `null` в `work(runner, null)`, чтобы `JwtKeyManagerService` выбросил `JwtKeyManagerException(SIGNING_KEY_NOT_FOUND)`.
   - Выполняет `work(runner, beforeRow)`.
   - Перечитывает `afterRow` (`FOR UPDATE`). Если проекция изменилась (ключ был отозван впервые) - записывает `signingKey:update` (`before`, `after`), вызывает `audit.flush()` и перепроверяет неизменность строки после `flush()`. При повторном отзыве уже отозванного ключа запись аудита не дублируется.
2. `runAuditedSigningKeyRotate`:
   - При явном `auditIdentity` или ambient-контексте работает строго fail-closed в указанном `workspaceId`.
   - При системном вызове без `auditIdentity` (например, из `SigningKeyRotationService.rotateIfDue()`) выбирает первый активный `core.workspace` (`WHERE "deletedAt" IS NULL ORDER BY "createdAt" ASC, id ASC LIMIT 1 FOR NO KEY UPDATE`) и использует системного актора (`system:jwt-key-manager:rotate-current`); если в БД ещё нет ни одного активного workspace, выполняет транзакцию ротации без строки аудита.
   - Блокирует все текущие ключи (`WHERE "isCurrent" = true ORDER BY id ASC FOR UPDATE`), выполняет `work(runner)` (деактивация прежнего ключа + вставка нового `newId`), перечитывает `[...beforeIds, newId]`, фиксирует `signingKey:update` для деактивированных ключей и `signingKey:create` для нового ключа с общим `operationId`, вызывает `audit.flush()` и перепроверяет состояние всех затронутых ключей после `flush()`.
3. `runAuditedSigningKeyBootstrapCreate`:
   - Для `generateAndPersistCurrent()`: при наличии активного workspace (или явного/ambient `auditIdentity`) атомарно фиксирует `signingKey:create` с системным актором `system:jwt-key-manager:bootstrap-current` и пост-flush проверкой; при `23505` (конкурентная вставка другим процессом) откатывает транзакцию и возвращает уже существующий текущий ключ без ложной записи аудита.
