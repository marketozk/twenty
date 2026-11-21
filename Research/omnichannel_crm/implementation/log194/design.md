# LOG194 - Дизайн транзакционного аудита лимитов использования рабочего пространства (`usageLimit` в `core."usageLimit"`)

## Цель и границы
Закрыть транзакционный аудит полного жизненного цикла (`create`, `update`, `delete`) записей лимитов использования рабочего пространства в `core."usageLimit"`:
- `UsageLimitService.create`
- `UsageLimitService.update`
- `UsageLimitService.delete`
- `UsageLimitResolver`: `createUsageLimit`, `updateUsageLimit`, `deleteUsageLimit` (проброс `context?.req` в `auditIdentity`)
- `AdminPanelUsageLimitResolver`: `createWorkspaceUsageLimit`, `updateWorkspaceUsageLimit`, `deleteWorkspaceUsageLimit` (проброс `auditIdentity` как для своего рабочего пространства, так и для серверного админа, управляющего чужим `workspaceId`)

Вне границ `LOG194`:
- Инвалидация кэша `workspaceCacheService.invalidateAndRecompute(..., ['usageLimits'])` и сброс Redis-счётчиков `dropCounter(...)` остаются строго после `COMMIT` транзакции БД (не откатываются транзакцией и не держат блокировки БД).
- Файлы с `@license Enterprise` внутри `usage-limit/` не изменяются; `workspace-domain-audit.ts` не получает никаких импортов из `usage-limit/` (нулевой риск нарушения `enterprise-dependency-baseline.json`).

## Модель аудита и проекция
- Новый `CrmAuditResourceKind`: `'usageLimit'` в `crm-audit.types.ts`.
- `CATALOG.usageLimit` в `crm-audit-transaction-context.ts`:
  - `values`: `['resourceType', 'operationType', 'spenderType', 'spenderId', 'limitKind', 'periodCount', 'periodUnit', 'unit', 'limitValue', 'burstValue', 'isInstanceOverride']`
  - `redacted`: `[]` (все поля `core."usageLimit"` являются не-PII параметрами политики квот/лимитов и UUID субъекта `spenderId` или пустой строкой `''`).
- `ADMINISTRATIVE_ACTIONS.usageLimit`: `['create', 'update', 'delete']`.
- `securityDescriptor`: `{ resourceKind: 'usageLimit', resourceId, metadataAccess: 'currentWorkspaceAdministration' }`.
- Проекция `projectUsageLimit(row)`:
  - нормализует `resourceType`, `operationType`, `spenderType`, `spenderId` (строка, `''` по умолчанию), `limitKind`, `periodCount` (число), `periodUnit`, `unit`, `limitValue` (строка канонического целого `bigint`, чтобы избежать потери точности JS `number` для больших `bigint`), `burstValue` (строка или `null`), `isInstanceOverride` (boolean).

## Транзакционные раннеры (`workspace-domain-audit.ts`)
1. `runAuditedUsageLimitCreate`:
   - `SET LOCAL lock_timeout = '8s'`.
   - Блокирует `core.workspace` (`FOR NO KEY UPDATE`), проверяет `deletedAt IS NULL`.
   - Проверяет актора/имперсонацию через `resolveWorkspaceDomainOperation(runner, request)` до записи.
   - Выполняет `work(runner)` (проверка свободности scope + вставка через `runner.manager.getRepository(UsageLimitEntity)`).
   - Перечитывает вставленную строку `core."usageLimit"` (`FOR UPDATE`), фиксирует `usageLimit:create` (`before: null`, `after: projectUsageLimit(afterRow)`), вызывает `audit.flush()` и перепроверяет неизменность строки после `flush()`.
2. `runAuditedUsageLimitUpdate`:
   - `SET LOCAL lock_timeout = '8s'`.
   - Блокирует `core.workspace` (`FOR NO KEY UPDATE`), проверяет `deletedAt IS NULL`.
   - Проверяет актора/имперсонацию через `resolveWorkspaceDomainOperation(runner, request)`.
   - Блокирует целевую строку `core."usageLimit"` по `(id, workspaceId)` с `FOR UPDATE` (снимает `beforeRow`). Если строка не найдена - передаёт `null` в `work(runner, null)`, чтобы `UsageLimitService.update` выбросил канонический `UsageLimitException(LIMIT_INVALID)`.
   - Выполняет `work(runner, beforeRow)` (проверка прав оператора/переопределений, валидация входа, проверка свободности scope и обновление через `runner.manager.getRepository(UsageLimitEntity)`).
   - Перечитывает `afterRow` (`FOR UPDATE`), если проекция изменилась - записывает `usageLimit:update` (`before`, `after`), вызывает `audit.flush()` и перепроверяет неизменность строки после `flush()`.
3. `runAuditedUsageLimitDelete`:
   - `SET LOCAL lock_timeout = '8s'`.
   - Блокирует `core.workspace` (`FOR NO KEY UPDATE`), проверяет `deletedAt IS NULL`.
   - Проверяет актора/имперсонацию через `resolveWorkspaceDomainOperation(runner, request)`.
   - Блокирует целевую строку `core."usageLimit"` по `(id, workspaceId)` с `FOR UPDATE`. Если строка не найдена - передаёт `null` в `work(runner, null)` (сервис возвращает `false`, аудит не пишется).
   - Выполняет `work(runner, beforeRow)` (проверка прав оператора/переопределений и удаление).
   - Убеждается, что строка отсутствует, записывает `usageLimit:delete` (`before`, `after: null`), вызывает `audit.flush()` и перепроверяет отсутствие строки после `flush()`.

## Пост-коммитные эффекты
- В `UsageLimitService.create`, `update`, `delete` вызовы `workspaceCacheService.invalidateAndRecompute(workspaceId, ['usageLimits'])` и `dropCounter(...)` выполняются строго после успешного `COMMIT` транзакции. При сбое транзакции или аудита кэш и счётчики не трогаются.
