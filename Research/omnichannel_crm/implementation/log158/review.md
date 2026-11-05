# LOG158 — независимое критическое ревью реализации (атомарный CRM-аудит создания, обновления и отзыва API-ключей)

Проверены `Research/omnichannel_crm/implementation/log158/design.md`, `Research/omnichannel_crm/implementation/log158/design-review.md`, `Research/omnichannel_crm/implementation/log158/test-research.md`, а также изменения и сопутствующие модули в рабочем дереве:

- `packages/twenty-server/src/engine/core-modules/crm-audit/api-key-audit.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit.types.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/role-update-audit.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/role-assignment-audit.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/role-permission-audit.ts`
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service.ts`
- `packages/twenty-server/src/engine/core-modules/api-key/services/api-key.service.ts`
- `packages/twenty-server/src/engine/core-modules/api-key/api-key.resolver.ts`
- `packages/twenty-server/src/engine/core-modules/api-key/controllers/api-key.controller.ts`
- `packages/twenty-server/src/engine/core-modules/api-key/commands/generate-api-key.command.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-api-key-lifecycle.postgres-spec.ts`

Исходные и тестовые файлы в ходе ревью не модифицировались.

---

## Вердикт

Реализация атомарного аудита жизненного цикла API-ключей (`api-key-audit.ts`, `crm-audit.types.ts`, `crm-audit-transaction-context.ts`, `role-update-audit.ts`, `role-assignment-audit.ts`, `role-permission-audit.ts`, `workspace-migration-runner.service.ts`, `api-key.service.ts`, `api-key.resolver.ts`, `api-key.controller.ts`, `generate-api-key.command.ts` и `crm-audit-api-key-lifecycle.postgres-spec.ts`) выполнена корректно, соблюдает транзакционные инварианты, проходит differential typecheck (`456/458` roots, `238/237` diagnostics, `0` новых и `0` в изменённом коде) и проверку изоляции Enterprise-зависимостей (`check_enterprise_dependencies.py` -> `"status": "pass"`, `0` нарушений).

Промежуточная правка внешнего Enterprise-теста `record-export.integration-spec.ts` откачена до исходного состояния (`HEAD`, аналогично `LOG156`), чтобы сохранить дифф строго в границах `LOG158`. Зафиксированы **2 незначительных неблокирующих замечания** в `ApiKeyService.update`.

---

## Незначительные замечания (не блокирующие)

### 1. [НЕЗНАЧИТЕЛЬНО] Ненормализованный `capturedWorkspaceId` при инвалидации кэша в `ApiKeyService.update`

- **Файл**: `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\core-modules\api-key\services\api-key.service.ts:126, 168, 173`
- **Суть**:
  В `ApiKeyService.create` (`строки 49, 87, 92`) в `this.invalidateApiKeyCache(captured.workspaceId)` передаётся UUID воркспейса, уже провалидированный и нормализованный к нижнему регистру функцией `captureApiKeyCreateInput`.
  В `ApiKeyService.update` (`строка 126`) `const capturedWorkspaceId = workspaceId;` сохраняет сырую строку до вызова `runAuditedApiKeyUpdate` (которая внутри нормализует её через `uuid(workspaceId)`). Если в `ApiKeyService.update` будет передан валидный UUID в верхнем регистре, транзакция БД выполнится с lowercase UUID, а в `invalidateApiKeyCache(capturedWorkspaceId)` уйдёт исходная строка в верхнем регистре.

### 2. [НЕЗНАЧИТЕЛЬНО] Получение `DataSource` через `this.apiKeyRepository.createQueryBuilder().connection` в `ApiKeyService.update`

- **Файл**: `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\core-modules\api-key\services\api-key.service.ts:132`
- **Суть**:
  В п. 4 `design-review.md` предполагалось инжектировать `@InjectDataSource() private readonly coreDataSource: DataSource` в `ApiKeyService`. В реализации вместо этого использовано выражение `this.apiKeyRepository.createQueryBuilder().connection`. В рантайме это работает корректно, сохраняет сигнатуру конструктора `ApiKeyService` и не нарушает изоляцию зависимостей, но на каждый вызов `update` создаёт неиспользуемый экземпляр `SelectQueryBuilder` только ради чтения ссылки `.connection`.

---

## Проверка 5 пунктов `design-review.md` и обязательных инвариантов

### 1. Атомарность вставки `core."apiKey"`, `core."roleTarget"` и записи `crm_audit."crmAuditEntry"` (Пункт 1, Уточнения 1.1 и 1.2)

- **Единая транзакция без компенсирующего `DELETE`**:
  - В `ApiKeyService.create` (`api-key.service.ts:42-96`) полностью удалён прежний трёхтранзакционный паттерн (`insertAndReturnOne` -> `roleTargetService.create` -> компенсирующий `delete`).
  - В `runAuditedApiKeyCreate` (`api-key-audit.ts:323-514`) внутри `runInCoreAuditTransaction` до запуска `await work(runner)` (`CreateRoleTargetActionHandlerService`) выполняется `INSERT INTO core."apiKey"`, благодаря чему внешний ключ `core."roleTarget"."apiKeyId" -> core."apiKey"."id"` удовлетворяется в той же транзакции, обе записи аудита (`apiKey` `create` и `roleTarget` `create`) разделяют один `operationId` и записываются единым `await audit.flush()` до `COMMIT`.
- **Уточнение 1.1 (Сверка `timestamptz` и консистентность хешей `to_jsonb` в `before` / `after`)**:
  - Скалярные поля `core."apiKey"` (`id`, `workspaceId`, `name`) и `core."roleTarget"` сверяются через `canonicalAuditJson` по снимкам `to_jsonb(k)` / `to_jsonb(t)` (`api-key-audit.ts:391-415, 430-460, 684-702`).
  - Временные метки (`expiresAt`, `revokedAt`, `createdAt`, `updatedAt`) сверяются на стороне PostgreSQL через `::timestamptz` и `IS NOT DISTINCT FROM` с полной микросекундной точностью (`api-key-audit.ts:416-428, 461-471, 704-715`).
  - В `runAuditedApiKeyUpdate` (`api-key-audit.ts:655-664, 717-728`) неизменённые поля `expiresAt` и `revokedAt` передаются в `UPDATE` как точные строковые значения из `beforeJson` (`to_jsonb(k)`), а `projectApiKeyAuditFields` вызывается исключительно на `beforeJson` и `afterJson` из `to_jsonb(k)`. Это гарантирует совпадение `auditPayloadHash` для неизменившихся полей и точный список `redactedDiff.changedFields`.
- **Уточнение 1.2 (Глубокое клонирование `Date` до первого `await` и возврат сущности из снимка)**:
  - `captureApiKeyCreateInput` (`api-key-audit.ts:136-191`) и `captureApiKeyUpdatePatch` (`api-key-audit.ts:526-586`) выполняются синхронно до первого `await`, отклоняют геттеры/сеттеры (`'get' in descriptor || 'set' in descriptor`) и неизвестные ключи через `Reflect.ownKeys`, проверяют `Number.isFinite(time)` и фиксируют даты в неизменяемые ISO-строки (`expiresAtIso`, `revokedAtIso`). Последующая мутация объекта `Date` вызывающим кодом не влияет на транзакцию.
  - `ApiKeyService.create` и `ApiKeyService.update` возвращают `this.toApiKeyEntity(persisted)` из замороженного внутри транзакции `PersistedApiKeyRow`, не выполняя неблокированный `findById` после `COMMIT`.

### 2. Отказ предмиграционной валидации в `RoleTargetService.create`, защита от обхода runner'а и взаимное исключение контекстов (Пункт 2, Уточнение 2.1)

- При отказе предмиграционной валидации в `RoleTargetService.create` (например, `canBeAssignedToApiKeys === false` в кэше) ошибка выбрасывается до входа в `WorkspaceMigrationRunnerService.executeRun`, транзакция БД не стартует и в `core."apiKey"` не вставляется ни одной строки.
- Если роль в БД конкурентно получила `"canBeAssignedToApiKeys" = false` или была удалена перед транзакцией, `runAuditedApiKeyCreate` (`api-key-audit.ts:340-358`) обнаруживает это под блокировкой `SELECT to_jsonb(r) AS row FROM core.role r WHERE "workspaceId"=$1 AND id=$2 FOR SHARE` **до** выполнения `INSERT INTO core."apiKey"`.
- В `withApiKeyCreateAudit` (`api-key-audit.ts:247-250`) после `storage.run` проверяется `!consumed.has(request) || !persisted` с выбросом `'API key create audit was not executed'`.
- Все четыре владельца контекстов (`role-update-audit.ts:368`, `role-assignment-audit.ts:178`, `role-permission-audit.ts:320`, `api-key-audit.ts:264`) регистрируют свои проверки через `registerMetadataAuditScopeCheck`, вызывают `hasConflictingMetadataAuditScope` при входе и дополнительно проверяются в `WorkspaceMigrationRunnerService.executeRun` (`workspace-migration-runner.service.ts:391-400`: `[roleAudit, assignmentAudit, permissionAudit, apiKeyCreateAudit].filter(Boolean).length > 1`).

### 3. Защита от реактивации отозванного ключа и транзакционные блокировки (Пункт 3)

- **Запрет реактивации**:
  - В `runAuditedApiKeyUpdate` (`api-key-audit.ts:623-646`) строка `core."apiKey"` читается с `FOR UPDATE`.
  - Если строка не найдена (`beforeRows.length === 0`), возвращается `null` без записи аудита и без инвалидации кэша.
  - Если `beforeJson.revokedAt !== null && beforeJson.revokedAt !== undefined` и в патче передан `revokedAt: null` (`patch.hasRevokedAt && patch.revokedAtIso === null`), до `UPDATE` и до записи аудита выбрасывается `ApiKeyAuditError(..., 'API_KEY_REVOKED')`.
  - В `ApiKeyService.update` (`api-key.service.ts:151-162`) эта ошибка преобразуется в штатный `ApiKeyException(..., ApiKeyExceptionCode.API_KEY_REVOKED)` с прежним `userFriendlyMessage`, что сохраняет контракт GraphQL (`ForbiddenError` через `apiKeyGraphqlApiExceptionHandler`) и REST (`400 API_KEY_REVOKED` через `RestApiExceptionFilter`).
  - Если для отозванного ключа `revokedAt` не передан (`patch.hasRevokedAt === false`, например переименование отозванного ключа), `nextRevokedAtParam` сохраняет `String(beforeJson.revokedAt)`, обновление проходит успешно и в `changedFields` записывается только `['name']`.
  - Если для активного ключа (`beforeJson.revokedAt === null`) передан `{ revokedAt: null }`, явный параметризованный `UPDATE` выполняется корректно (устранён старый дефект пустого `updateDataWithoutRevokedAt = {}`) и записывает аудит с `changedFields: []`.
- **Транзакционные блокировки и отсутствие дедлоков**:
  - В `runAuditedApiKeyCreate` и `runAuditedApiKeyUpdate` устанавливается `SET LOCAL lock_timeout = '8s'` и первым запросом захватывается `FOR NO KEY UPDATE` на строку `core.workspace` (`WHERE w.id = $1`), проверяя `deletedAt === null`.
  - Поскольку `runAuditedRoleDelete`, `runAuditedRoleAssignment`, `runAuditedRolePermissionUpsert`, `runAuditedApiKeyCreate` и `runAuditedApiKeyUpdate` начинаются с `FOR NO KEY UPDATE` на `core.workspace`, любые конкурентные административные операции над ролями и API-ключами одного воркспейса сериализуются на входе в транзакцию, что полностью исключает взаимные блокировки (deadlocks) при захвате `core."apiKey"` (`FOR UPDATE`) и `core."roleTarget"` (`FOR SHARE` / `FOR UPDATE`).
  - После `await audit.flush()` как в `runAuditedApiKeyCreate` (`api-key-audit.ts:499-510`), так и в `runAuditedApiKeyUpdate` (`api-key-audit.ts:731-739`) перечитываются и сверяются `core."apiKey"`, `core."roleTarget"` (а при создании — также `core.role` и `core.application`).

### 4. Изоляция графа Enterprise-зависимостей (Пункт 4)

- Запущена проверка `python -I -X utf8 scripts/omnichannel/check_enterprise_dependencies.py`:
  - Результат: `"status": "pass"`, `"violations": {}` (`34760` файлов, `136844` рёбер).
- Модуль `packages/twenty-server/src/engine/core-modules/crm-audit/api-key-audit.ts` импортирует только `node:async_hooks`, `node:crypto`, `class-validator`, `typeorm` и соседние модули `src/engine/core-modules/crm-audit/*`, не создавая рёбер к `src/engine/core-modules/api-key/*`, `src/engine/metadata-modules/*` или `twenty-shared/*`.

### 5. Инвалидация кэшей и обработка `NativeTransactionOutcomeUnknownError` (Пункт 5)

- В `WorkspaceMigrationRunnerService.executeRun` (`workspace-migration-runner.service.ts:527-541`) блок `finally` гарантированно инвалидирует `flatRoleTargetMaps` и `rolesPermissions` (а также производный `apiKeyRoleMap`) даже при потере подтверждения `COMMIT`.
- В `ApiKeyService.create` (`api-key.service.ts:77-95`) и `ApiKeyService.update` (`api-key.service.ts:146-176`) при перехвате `NativeTransactionOutcomeUnknownError` устанавливается `shouldInvalidateCache = true`, а в блоке `finally` при `caughtError !== undefined` вызов `await this.invalidateApiKeyCache(...)` обёрнут в собственный `try / catch`, чтобы сбой Redis/кэша не замаскировал и не заменил пробрасываемый `NativeTransactionOutcomeUnknownError`.

### 6. Покрытие тестами (`crm-audit-api-key-lifecycle.postgres-spec.ts`)

В `packages/twenty-server/test/fork-migration/crm-audit-api-key-lifecycle.postgres-spec.ts` реализованы 12 интеграционных тестов против реального PostgreSQL с ограниченной ролью БД (`SELECT, INSERT, UPDATE, DELETE` на `core`, только `SELECT, INSERT` на `crm_audit."crmAuditEntry"`):

1. Атомарное создание `core."apiKey"` + `core."roleTarget"` через `ApiKeyResolver.createApiKey` с общим `operationId`, резолвом `impersonatorUserWorkspaceId` в `initiator: { kind: 'coreUser' }`, проверкой `redactedDiff` и инвалидацией `apiKeyMap`.
2. Атомарное создание через REST `ApiKeyController.create` и CLI `GenerateApiKeyCommand` с системным актором `{ kind: 'system', id: 'workspace:generate-api-key' }`.
3. Отказ при `canBeAssignedToApiKeys === false` (как на этапе предмиграционной валидации, так и при конкурентном `UPDATE core.role SET "canBeAssignedToApiKeys" = false` перед `executeRun`) без появления осиротевших строк в `core."apiKey"`, `core."roleTarget"` и `crm_audit."crmAuditEntry"`.
4. Обновление через `ApiKeyResolver.updateApiKey` и `ApiKeyController.update` с точным `changedFields` (`['name']`, `['expiresAt', 'name']`) без ложных диффов `timestamptz` и возвратом `null` без аудита и без инвалидации кэша для несуществующего ключа.
5. Отзыв через `ApiKeyResolver.revokeApiKey` и `ApiKeyController.remove`, передача `{ revokedAt: null }` на активном ключе (`changedFields: []`) и переименование уже отозванного ключа (`changedFields: ['name']`, сохранение `revokedAt`).
6. Запрет реактивации отозванного ключа (`revokedAt: null` / `revokedAt: ''`) под `FOR UPDATE` с выбросом `ApiKeyExceptionCode.API_KEY_REVOKED` / `ForbiddenError` без изменения БД и без записи аудита.
7. Защита от мутации экземпляров `Date` после старта промиса до первого `await`, а также отклонение невалидных `auditIdentity` и `systemActorId` до любых обращений к кэшу или БД.
8. Сохранение `NativeTransactionOutcomeUnknownError` при потере ACK `COMMIT` в `create` и `update` с обязательным вызовом инвалидации `apiKeyMap` в `finally`, даже когда `invalidateAndRecompute` выбрасывает ошибку.
9. Полный откат `create` и `update` при модификации `core."apiKey"` триггером на `crm_audit."crmAuditEntry"` во время `audit.flush()`.
10. Взаимное исключение `withApiKeyCreateAudit` со всеми остальными metadata-audit контекстами (`withRoleUpdateAudit`, `withApiKeyRoleAssignmentAudit`, `withRolePermissionFlagUpsertAudit`) и отказ при невыполненном runner'е (`'API key create audit was not executed'`).
11. Проверка каталога и `securityDescriptor` для `apiKey` (разрешены только `create` и `update` с `metadataAccess: 'currentWorkspaceAdministration'`, отказ для `delete` и неполного дескриптора).
12. Отказ создания и обновления API-ключа при мягко удалённом воркспейсе (`core.workspace."deletedAt" IS NOT NULL`).
