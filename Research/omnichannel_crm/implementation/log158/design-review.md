# LOG158 — критическое ревью дизайна и плана тестирования (атомарный CRM-аудит создания, обновления и отзыва API-ключей)

Проверены `Research/omnichannel_crm/implementation/log158/design.md`, `Research/omnichannel_crm/implementation/log158/test-research.md`, а также исходные файлы `api-key.service.ts`, `api-key.resolver.ts`, `api-key.controller.ts`, `generate-api-key.command.ts`, `api-key-role.service.ts`, `role-target.service.ts`, `from-create-role-target-input-to-flat-role-target-to-create.util.ts`, `flat-role-target-validator.service.ts`, `create-role-target-action-handler.service.ts`, `role-update-audit.ts`, `role-assignment-audit.ts`, `role-permission-audit.ts`, `crm-audit-transaction-context.ts`, `crm-audit.types.ts`, `native-crm-audit-transaction.ts`, `run-in-core-audit-transaction.ts`, `workspace-migration-runner.service.ts`, `workspace-api-key-map-cache.service.ts`, `workspace-api-key-role-map-cache.service.ts`, `record-export.integration-spec.ts`, `api-keys.integration-spec.ts` и `scripts/omnichannel/check_enterprise_dependencies.py`.

## Вердикт

Выбранный в `design.md` Вариант 1 архитектурно корректен и полностью закрывает три оставшиеся мутационные точки жизненного цикла `core."apiKey"` (`ApiKeyService.create`, `ApiKeyService.update`, `ApiKeyService.revoke` через GraphQL, REST и CLI) в рамках единого атомарного контракта `core` / `crm_audit`.

При реализации необходимо учесть пять критических технических уточнений, выявленных при сверке с реальным кодом:

---

## Проверка ключевых инвариантов и обязательные уточнения к реализации

### 1. Атомарность вставки `core."apiKey"`, `core."roleTarget"` и записи `crm_audit."crmAuditEntry"` в `runInCoreAuditTransaction`

- **Единая транзакция без компенсирующего `DELETE`**:
  - В текущей реализации `ApiKeyService.create` (`packages/twenty-server/src/engine/core-modules/api-key/services/api-key.service.ts:41-58`) выполняет `apiKeyRepository.insertAndReturnOne` в отдельной транзакции до `roleTargetService.create`, а при ошибке пытается удалить ключ третьей транзакцией.
  - Перенос `INSERT INTO core."apiKey"` внутрь `runAuditedApiKeyCreate` (вызываемого из `WorkspaceMigrationRunnerService.executeRun` внутри `runInCoreAuditTransaction`) до вызова `await work(runner)` (`CreateRoleTargetActionHandlerService`) гарантирует, что:
    1. Внешний ключ `core."roleTarget"."apiKeyId" -> core."apiKey"."id"` (`ON DELETE CASCADE`) удовлетворён внутри той же транзакции.
    2. Оба ресурса (`apiKey` `create` и `roleTarget` `create`) получают один и тот же `operationId` и сбрасываются через единый `await audit.flush()` до `COMMIT`.
    3. При любом сбое до или во время `audit.flush()` вся транзакция откатывается целиком, не оставляя осиротевших строк в `core."apiKey"`.
- **Уточнение 1.1 (Сверка `timestamptz` и консистентность хешей `to_jsonb` в `before` / `after`)**:
  - В PostgreSQL `to_jsonb(timestamptz)` сериализует временные метки в формат вроде `"2026-01-01T00:00:00+00:00"` (без `.000` при нулевых миллисекундах или с микросекундами), который строково не совпадает с `Date.prototype.toISOString()` (`"2026-01-01T00:00:00.000Z"`).
  - Поэтому в `runAuditedApiKeyCreate` и `runAuditedApiKeyUpdate`:
    - Скалярные не-временные поля (`id`, `workspaceId`, `name`) должны сверяться через `canonicalAuditJson` по строке `SELECT to_jsonb(k) AS row FROM core."apiKey" k`.
    - Временные метки (`expiresAt`, `revokedAt`, `createdAt`, `updatedAt`) должны сверяться на уровне PostgreSQL `timestamptz`: `"expiresAt" = $3::timestamptz AND "revokedAt" IS NOT DISTINCT FROM $4::timestamptz AND "createdAt" = $5::timestamptz` (по образцу `role-update-audit.ts:1011` и `role-assignment-audit.ts:564`).
    - Для `audit.record` проекция `projectApiKeyAuditFields(row)` (`{ name, expiresAt, revokedAt }`) должна строиться исключительно из `to_jsonb(k)` снимков БД (`beforeRow` и `afterRow`). Это гарантирует, что при `update` неизменившиеся поля `expiresAt` / `revokedAt` имеют побитово одинаковое представление и одинаковый `auditPayloadHash` в `before` и `after`, и в `redactedDiff.changedFields` попадают только реально изменившиеся поля.
- **Уточнение 1.2 (Глубокое клонирование `Date` до первого `await` и возврат сущности из зафиксированного снимка)**:
  - Поскольку экземпляры `Date` в JavaScript мутабельны (`expiresAt.setFullYear(...)`), до первого `await` в `ApiKeyService.create` и `ApiKeyService.update` необходимо не только прочитать свойства входного объекта через дескрипторы, но и провалидировать `Number.isFinite(date.getTime())` и зафиксировать `expiresAt` / `revokedAt` как неизменяемые ISO-строки.
  - `ApiKeyService.create` и `ApiKeyService.update` должны конструировать возвращаемый `ApiKeyEntity` напрямую из проверенного внутри транзакции `PersistedApiKeyRow`, не выполняя дополнительный неблокированный запрос `this.findById(...)` после `COMMIT`.

### 2. Поведение при отказе предмиграционной валидации в `RoleTargetService.create`

- В `RoleTargetService.createMany` (`packages/twenty-server/src/engine/metadata-modules/role-target/services/role-target.service.ts:48-117`) до вызова `WorkspaceMigrationRunnerService.executeRun` выполняются:
  1. Разрешение `roleUniversalIdentifier` в `fromCreateRoleTargetInputToFlatRoleTargetToCreate` (выбрасывает `FlatEntityMapsException`, если `roleId` отсутствует в `flatRoleMaps`).
  2. Валидация в `FlatRoleTargetValidatorService.validateFlatRoleTargetCreation` (`validateFlatRoleTargetTargetsOnlyOneEntity`, `validateFlatRoleTargetAssignationAvailability` для `canBeAssignedToApiKeys === true`, `validateFlatRoleTargetRoleIsEntitled`). При ошибке выбрасывается `WorkspaceMigrationBuilderException` без входа в `WorkspaceMigrationRunnerService.run`.
- Так как `INSERT INTO core."apiKey"` выполняется только внутри `runAuditedApiKeyCreate`, при любой ошибке предмиграционной валидации транзакция БД не стартует и в `core."apiKey"` не вставляется ни одной строки.
- Если же кэш `flatRoleMaps` устарел и роль в БД параллельно получила `"canBeAssignedToApiKeys" = false` или была удалена, `runAuditedApiKeyCreate` обнаруживает это под блокировкой `SELECT ... FROM core.role WHERE "workspaceId" = $1 AND id = $2 FOR SHARE` **до** выполнения `INSERT INTO core."apiKey"` и откатывает транзакцию.
- **Уточнение 2.1 (Защита от обхода runner'а и взаимное исключение контекстов)**:
  - В `withApiKeyCreateAudit` после `await work()` необходимо проверить, что `consumed.has(request)` истинно и сохранён `PersistedApiKeyRow` (иначе выбрасывать ошибку `'API key create audit was not executed'`).
  - Взаимное исключение активных `AsyncLocalStorage` контекстов должно проверяться симметрично во всех четырёх владельцах (`role-update-audit.ts`, `role-assignment-audit.ts`, `role-permission-audit.ts`, `api-key-audit.ts`) и в `WorkspaceMigrationRunnerService.executeRun` (`[roleAudit, assignmentAudit, permissionAudit, apiKeyCreateAudit].filter(Boolean).length > 1`).

### 3. Защита от реактивации (`before.revokedAt !== null && patch.revokedAt === null`) под блокировкой `FOR UPDATE` и отсутствие дедлоков

- В `runAuditedApiKeyUpdate` строка `core."apiKey"` читается через `SELECT to_jsonb(k) AS row FROM core."apiKey" k WHERE id = $1 AND "workspaceId" = $2 FOR UPDATE`.
  - Если строка не найдена, транзакция возвращает `null` без записи аудита.
  - Если `before.revokedAt !== null && patch.revokedAt === null`, выбрасывается `ApiKeyAuditError('API_KEY_REVOKED')` до выполнения `UPDATE` и до записи аудита, а `ApiKeyService.update` преобразует его в `ApiKeyException(..., ApiKeyExceptionCode.API_KEY_REVOKED, { userFriendlyMessage: msg\`This API key has been revoked and cannot be reactivated. Please create a new API key.\` })`. Это полностью сохраняет контракт GraphQL (`FORBIDDEN` через `apiKeyGraphqlApiExceptionHandler`) и REST (`400 API_KEY_REVOKED` через `RestApiExceptionFilter`).
  - Если `before.revokedAt !== null` и `patch.revokedAt === undefined` (например, переименование отозванного ключа в `api-keys.integration-spec.ts:401`), целевое значение `revokedAt` остаётся равным `before.revokedAt`, ошибка не выбрасывается, и в `changedFields` фиксируется только `['name']`.
  - Если `before.revokedAt === null` и передан `{ revokedAt: null }`, явный SQL `UPDATE core."apiKey" SET "name" = $3, "expiresAt" = $4::timestamptz, "revokedAt" = $5::timestamptz, "updatedAt" = now()` устраняет дефект старого кода, где `updateDataWithoutRevokedAt` мог оказаться пустым объектом `{}` при передаче только `{ revokedAt: null }`.
- **Отсутствие дедлоков при блокировке `core."roleTarget" FOR SHARE`**:
  - Все связанные операции (`runAuditedRoleDelete`, `runAuditedRoleAssignment`, `runAuditedRolePermissionUpsert`, `runAuditedApiKeyCreate`, `runAuditedApiKeyUpdate`) первым шагом внутри `runInCoreAuditTransaction` берут `FOR NO KEY UPDATE` на строку `core.workspace` (`WHERE id = $1`). Это сериализует конкурентные административные мутации ролей и API-ключей одного воркспейса на входе и исключает взаимные блокировки (deadlocks) между `core."apiKey"` и `core."roleTarget"`.

### 4. Изоляция графа Enterprise-зависимостей (`check_enterprise_dependencies.py`)

- В `Research/omnichannel_crm/implementation/enterprise-dependency-baseline.json` валидатор `validate-flat-role-target-role-is-entitled.util.ts` входит в `reaches_enterprise`, а `check_enterprise_dependencies.py` учитывает как обычные `import`, так и `import type`.
- Так как `WorkspaceMigrationRunnerService` импортирует `api-key-audit.ts`, файл `packages/twenty-server/src/engine/core-modules/crm-audit/api-key-audit.ts` не должен импортировать ничего из `src/engine/core-modules/api-key/*`, `src/engine/metadata-modules/*`, `twenty-shared/constants` или `twenty-shared/types`.
- Валидация и извлечение plain-объектов в `api-key-audit.ts` должны опираться только на `node:async_hooks`, `class-validator` (`isUUID`), `typeorm` (`type DataSource`, `type QueryRunner`) и соседние модули `src/engine/core-modules/crm-audit/*`.
- Для вызова `runAuditedApiKeyUpdate` в `ApiKeyService` необходимо инжектировать `@InjectDataSource() private readonly coreDataSource: DataSource`.

### 5. Инвалидация кэшей (`apiKeyMap`, `flatRoleTargetMaps`, `apiKeyRoleMap`, `rolesPermissions`) и `NativeTransactionOutcomeUnknownError`

- При создании ключа `WorkspaceMigrationRunnerService.executeRun` в блоке `finally` уже инвалидирует `flatRoleTargetMaps` и `rolesPermissions` (а `WorkspaceCacheService` автоматически пересчитывает производный `@WorkspaceDerivedCache('apiKeyRoleMap')`, чей `sourceKeyName = 'flatRoleTargetMaps'`).
- Кэш `apiKeyMap` (`@WorkspaceCache('apiKeyMap')`) не входит в `AllFlatEntityMaps`, поэтому его инвалидация (`this.invalidateApiKeyCache(capturedWorkspaceId)`) в `ApiKeyService.create` и `ApiKeyService.update` должна выполняться:
  1. Штатно после успешного возврата из `withApiKeyCreateAudit` / `runAuditedApiKeyUpdate` (когда `updated !== null`).
  2. В блоке `finally` при `caughtError instanceof NativeTransactionOutcomeUnknownError`, обязательно внутри собственного `try / catch`, чтобы возможный сбой инвалидации кэша не подавил и не подменил пробрасываемый `NativeTransactionOutcomeUnknownError`.

---

## Проверка полноты плана тестирования (`test-research.md`) и дополнительные кейсы

Матрица из 8 пунктов в `test-research.md` покрывает основные пути GraphQL, REST и CLI. При реализации тестов необходимо дополнительно включить следующие проверки:

1. **Обновление внешнего существующего теста `record-export.integration-spec.ts`**:
   - В `packages/twenty-server/test/integration/record-export/record-export.integration-spec.ts:106` есть прямой вызов `apiKeys().create(...)`. После добавления обязательного параметра `auditIdentity` в `ApiKeyService.create` этот вызов необходимо снабдить валидным `auditIdentity`, чтобы сохранить компилируемость (`tsgo`) и прохождение интеграционного теста.
2. **Точность `changedFields` при частичном обновлении и переименовании отозванного ключа**:
   - В тесте обновления проверить, что переименование уже отозванного ключа (`revokedAt` не передан в `updateData`) сохраняет прежний `revokedAt` и записывает в `crm_audit."crmAuditEntry"` ровно `changedFields: ['name']` (без `expiresAt` и `revokedAt`), подтверждая отсутствие ложного срабатывания из-за разницы форматов `Date.toISOString()` и PostgreSQL `to_jsonb`.
3. **Мутация экземпляра `Date` после вызова и граничные случаи `systemActorId`**:
   - В тесте защиты входного DTO проверить мутацию самого объекта `Date` (`expiresAt.setUTCFullYear(...)`) после старта промиса до первого `await`.
   - Проверить, что `captureRoleAuditIdentity` отклоняет `auth.type === 'system'` с пустым или отсутствующим `systemActorId`, а также отклоняет непустой `systemActorId` при `auth.type !== 'system'`.
4. **Сохранение `NativeTransactionOutcomeUnknownError` при ошибке кэша в `finally`**:
   - Проверить, что если при потере ACK `COMMIT` вызов `workspaceCacheService.invalidateAndRecompute` в `finally` также выбрасывает ошибку, наружу всё равно пробрасывается исходный `NativeTransactionOutcomeUnknownError`.
