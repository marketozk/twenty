# LOG158 — дизайн аудита создания, обновления и отзыва API-ключей с атомарной привязкой roleTarget

## Контекст и проблема

После `LOG111`–`LOG113`, `LOG156` и `LOG157` закрыты создание, обновление и удаление ролей, назначение ролей участникам, агентам и существующим API-ключам (`ApiKeyRoleService.assignRoleToApiKey`), а также изменение всех четырёх видов прав ролей (`rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup` / `rowLevelPermissionPredicate`).

При этом в `ApiKeyService` (`packages/twenty-server/src/engine/core-modules/api-key/services/api-key.service.ts:34-124`), `ApiKeyResolver` (`packages/twenty-server/src/engine/core-modules/api-key/api-key.resolver.ts:109-181`), `ApiKeyController` (`packages/twenty-server/src/engine/core-modules/api-key/controllers/api-key.controller.ts:97-166`) и `GenerateApiKeyCommand` (`packages/twenty-server/src/engine/core-modules/api-key/commands/generate-api-key.command.ts:124-130`) остаются открытыми три мутационные точки жизненного цикла `core."apiKey"`:

1. **`ApiKeyService.create` (`ApiKeyResolver.createApiKey`, `ApiKeyController.create`, `GenerateApiKeyCommand.run`)**:
   - Выполняет `apiKeyRepository.insertAndReturnOne` в первой транзакции (`T1`), затем вызывает `roleTargetService.create` во второй транзакции (`T2`), а при ошибке `T2` пытается выполнить компенсирующий `apiKeyRepository.delete` в третьей транзакции (`T3`).
   - Между `T1` и `T2` (или при сбое `T3`) в `core."apiKey"` остаётся неаудированный ключ без `core."roleTarget"`, а записи аудита `apiKey` (`create`) и `roleTarget` (`create`) не создаются атомарно в одном `COMMIT`.
2. **`ApiKeyService.update` (`ApiKeyResolver.updateApiKey`, `ApiKeyController.update`)**:
   - Проверяет запрет реактивации отозванного ключа (`revokedAt === null && isRevoked(apiKey)`) по неблокированному чтению `findById`, после чего выполняет `apiKeyRepository.update` без блокировок `core.workspace` / `core."apiKey"` / `core."roleTarget"`, без повторной проверки после записи и без записи аудита `apiKey` (`update`).
3. **`ApiKeyService.revoke` (`ApiKeyResolver.revokeApiKey`, `ApiKeyController.remove`)**:
   - Делегирует в `ApiKeyService.update(id, workspaceId, { revokedAt: new Date() })` без `auditIdentity` и без атомарного аудита `apiKey` (`update`).

## Варианты решения

### Вариант 1 (выбран): Закрытый владелец `api-key-audit.ts` с однотранзакционным созданием `apiKey` + `roleTarget` через `WorkspaceMigrationRunnerService` и транзакционным обновлением/отзывом `runAuditedApiKeyUpdate`

1. **Каталог административного аудита (`crm-audit.types.ts`, `crm-audit-transaction-context.ts`)**:
   - Добавить `'apiKey'` в `CrmAuditResourceKind`.
   - В `CATALOG` добавить:
     - `apiKey`: `values: []`, `redacted: ['name', 'expiresAt', 'revokedAt']` (пользовательское имя ключа и временные метки хешируются в `redactedDiff.changedFields` без хранения открытых строк в `values`).
   - В `ADMINISTRATIVE_ACTIONS` добавить `apiKey: ['create', 'update']` с обязательным дескриптором `{ resourceKind: 'apiKey', resourceId, metadataAccess: 'currentWorkspaceAdministration' }`.
2. **Поддержка системного субъекта в `RoleUpdateAuditIdentity` (`role-update-audit.ts`)**:
   - Добавить опциональное поле `systemActorId?: string` в `RoleUpdateAuditIdentity`, проверять его в `captureRoleAuditIdentity` (`auth.type === 'system'` требует непустой `systemActorId <= 256`, а для остальных типов `systemActorId` запрещён) и пробрасывать в `captureRoleAuditOperation` -> `captureNativeCrmAuditOperation`. Это позволяет CLI-команде `GenerateApiKeyCommand` передавать `{ auth: { workspace: { id: workspace.id }, type: 'system' }, systemActorId: 'workspace:generate-api-key' }`.
3. **Атомарное создание `core."apiKey"` + `core."roleTarget"` (`withApiKeyCreateAudit` и `runAuditedApiKeyCreate` в `api-key-audit.ts`)**:
   - В `ApiKeyService.create` входные поля (`name`, `expiresAt`, `revokedAt`, `roleId`, `workspaceId`) и `auditIdentity` клонируются и валидируются до первого `await`.
   - Генерируется `apiKeyId = randomUUID()`, и вызов `roleTargetService.create({ createRoleTargetInput: { roleId, targetId: apiKeyId, targetMetadataForeignKey: 'apiKeyId' }, workspaceId })` оборачивается в `withApiKeyCreateAudit(...)`.
   - Если предмиграционная flat-валидация в `RoleTargetService.create` (существование роли в `flatRoleMaps`, `canBeAssignedToApiKeys === true`, права подписки) завершается ошибкой до запуска `WorkspaceMigrationRunnerService.executeRun`, в `core."apiKey"` не вставляется ни одной строки и компенсирующий `DELETE` не нужен.
   - В `WorkspaceMigrationRunnerService.executeRun` проверяется взаимное исключение `[roleAudit, assignmentAudit, permissionAudit, apiKeyCreateAudit]`, и при активном `apiKeyCreateAudit` вызывается `runAuditedApiKeyCreate(this.coreDataSource, apiKeyCreateAudit, actions, mappings, execute)`.
   - Внутри `runInCoreAuditTransaction`:
     - Устанавливается `SET LOCAL lock_timeout = '8s'`.
     - Блокируются `core.workspace` (`FOR NO KEY UPDATE`, `deletedAt IS NULL`), `core.application` (`FOR SHARE`), `core.role` (`FOR SHARE`, проверка `canBeAssignedToApiKeys === true` и совпадения `universalIdentifier`).
     - Проверяется отсутствие существующих строк `core."apiKey"` (`id = apiKeyId FOR UPDATE`) и `core."roleTarget"` (`"workspaceId" = $1 AND ("apiKeyId" = $2 OR id = $3) FOR UPDATE`).
     - До вызова `work(runner)` в той же транзакции выполняется `INSERT INTO core."apiKey" ("id", "name", "expiresAt", "revokedAt", "workspaceId") VALUES (...)`, чтобы внешний ключ `core."roleTarget"."apiKeyId" -> core."apiKey"."id"` был удовлетворён внутри транзакции.
     - Выполняется `await work(runner)` (`CreateRoleTargetActionHandlerService`), вставляющий `core."roleTarget"`.
     - Под блокировками `FOR UPDATE` перечитываются `core."apiKey"` и `core."roleTarget"`, сверяются все скалярные поля и микросекундные временные метки, записываются две атомарные записи аудита (`apiKey` `create` и `roleTarget` `create`), вызывается `await audit.flush()`, и повторно проверяется неизменность состояния после `audit.flush()`.
     - В `ApiKeyService.create` кэш `apiKeyMap` инвалидируется после подтверждённого коммита и в `finally` при `NativeTransactionOutcomeUnknownError`.
4. **Транзакционное обновление и отзыв `core."apiKey"` (`runAuditedApiKeyUpdate` в `api-key-audit.ts`)**:
   - В `ApiKeyService.update` и `ApiKeyService.revoke` входные аргументы (`id`, `workspaceId`, `updateData`, `auditIdentity`) клонируются и валидируются до первого `await`.
   - Внутри `runInCoreAuditTransaction`:
     - Устанавливается `SET LOCAL lock_timeout = '8s'`, блокируется `core.workspace` (`FOR NO KEY UPDATE`, `deletedAt IS NULL`).
     - Блокируется `core."apiKey"` (`WHERE id = $1 AND "workspaceId" = $2 FOR UPDATE`): если строка отсутствует, транзакция возвращает `null` без записи аудита.
     - Под блокировкой `FOR UPDATE` проверяется запрет реактивации отозванного ключа (`before.revokedAt !== null && patch.revokedAt === null` -> `ApiKeyAuditError('API_KEY_REVOKED')`, который `ApiKeyService.update` преобразует в штатный `ApiKeyException(..., ApiKeyExceptionCode.API_KEY_REVOKED)`).
     - Блокируются связанные строки `core."roleTarget"` (`WHERE "workspaceId" = $1 AND "apiKeyId" = $2 FOR SHARE`).
     - Выполняется `UPDATE core."apiKey" SET "name" = $3, "expiresAt" = $4::timestamptz, "revokedAt" = $5::timestamptz, "updatedAt" = now() WHERE id = $1 AND "workspaceId" = $2`.
     - Перечитывается `core."apiKey"` (`FOR UPDATE`), сверяются целевые значения полей и неизменность `createdAt`, записывается запись аудита `apiKey` (`update`), вызывается `await audit.flush()`, и после `audit.flush()` повторно сверяются `core."apiKey"` и `core."roleTarget"`.
     - В `ApiKeyService.update` кэш `apiKeyMap` инвалидируется после успешного обновления и в `finally` при `NativeTransactionOutcomeUnknownError`.
5. **Изоляция графа Enterprise-зависимостей**:
   - `api-key-audit.ts` не импортирует ничего из `src/engine/core-modules/api-key/*` или `twenty-shared/constants`; преобразование `PersistedApiKeyRow` в `ApiKeyEntity` и `ApiKeyAuditError` в `ApiKeyException` выполняется внутри `ApiKeyService`.

### Вариант 2 (отклонён): Вставка `core."apiKey"` и `core."roleTarget"` прямым SQL в `ApiKeyService.create` в обход `RoleTargetService.create`

- Дублирует логику построения `FlatRoleTarget`, проверки прав подписки (`validateFlatRoleTargetRoleIsEntitled`) и инвалидации `flatRoleTargetMaps` / `apiKeyRoleMap` / `rolesPermissions`, которая уже централизована в `RoleTargetService` и `WorkspaceMigrationRunnerService`.

### Вариант 3 (отклонён): Сохранение двух раздельных транзакций в `ApiKeyService.create`

- Нарушает требование атомарности создания `core."apiKey"`, его `core."roleTarget"` и записей `crm_audit."crmAuditEntry"` в одном `COMMIT`.
