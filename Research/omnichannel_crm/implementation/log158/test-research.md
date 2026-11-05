# LOG158 — план проверок аудита создания, обновления и отзыва API-ключей

## Реальные пути выполнения (Real-Path Gate)

1. **`ApiKeyResolver.createApiKey` / `ApiKeyController.create` / `GenerateApiKeyCommand.run` -> `ApiKeyService.create` -> `withApiKeyCreateAudit` -> `RoleTargetService.create` -> `WorkspaceMigrationRunnerService.executeRun` -> `runAuditedApiKeyCreate`**:
   - В одной транзакции `runInCoreAuditTransaction` блокирует `core.workspace`, `core.application`, `core.role`, проверяет `canBeAssignedToApiKeys === true`, вставляет `core."apiKey"`, запускает `CreateRoleTargetActionHandlerService` для вставки `core."roleTarget"`, сверяет обе строки, записывает `crm_audit."crmAuditEntry"` (`apiKey` `create` и `roleTarget` `create`) до `COMMIT`, повторно сверяет после `audit.flush()` и инвалидирует `flatRoleTargetMaps`, `apiKeyRoleMap`, `rolesPermissions` и `apiKeyMap`.
2. **`ApiKeyResolver.updateApiKey` / `ApiKeyController.update` -> `ApiKeyService.update` -> `runAuditedApiKeyUpdate`**:
   - В одной транзакции `runInCoreAuditTransaction` блокирует `core.workspace`, `core."apiKey"` (`FOR UPDATE`) и `core."roleTarget"` (`FOR SHARE`), проверяет запрет реактивации отозванного ключа (`revokedAt === null` при `before.revokedAt !== null`), обновляет `core."apiKey"`, записывает `crm_audit."crmAuditEntry"` (`apiKey` `update`) с хешированными полями `name`, `expiresAt`, `revokedAt`, повторно сверяет `core."apiKey"` и `core."roleTarget"` после `audit.flush()` и инвалидирует `apiKeyMap`.
3. **`ApiKeyResolver.revokeApiKey` / `ApiKeyController.remove` -> `ApiKeyService.revoke` -> `ApiKeyService.update`**:
   - Передаёт `auditIdentity` в `ApiKeyService.update(id, workspaceId, { revokedAt: new Date() }, auditIdentity)`, атомарно устанавливая `revokedAt` и записывая `crm_audit."crmAuditEntry"` (`apiKey` `update` с `changedFields: ['revokedAt']`).

## Матрица интеграционных проверок PostgreSQL (`crm-audit-api-key-lifecycle.postgres-spec.ts`)

1. **Атомарное создание API-ключа через `ApiKeyResolver.createApiKey` / `ApiKeyService.create`**:
   - Создаёт `core."apiKey"` и `core."roleTarget"` в одной транзакции с одним `operationId`, записывает `apiKey` (`create`, `changedFields: ['expiresAt', 'name', 'revokedAt']`, `values: {}`) и `roleTarget` (`create`, `values.roleId`, `values.apiKeyId`), поддерживает `impersonatorUserWorkspaceId` (`initiator: { kind: 'coreUser' }`) и инвалидирует `apiKeyMap` + `apiKeyRoleMap` + `rolesPermissions`.
2. **Атомарное создание API-ключа через `ApiKeyController.create` и CLI `GenerateApiKeyCommand` (`system` actor)**:
   - Проверяет проброс `auditIdentity` из REST-контроллера и системного субъекта `{ kind: 'system', id: 'workspace:generate-api-key' }`.
3. **Отказ создания API-ключа при `canBeAssignedToApiKeys === false` (и при конкурентном сбросе `canBeAssignedToApiKeys` в БД)**:
   - Ни при ошибке предмиграционной валидации, ни при конкурентном изменении `core.role."canBeAssignedToApiKeys" = false` перед `executeRun` в `core."apiKey"`, `core."roleTarget"` и `crm_audit."crmAuditEntry"` не остаётся строк.
4. **Обновление `name` и `expiresAt` через `ApiKeyResolver.updateApiKey` и `ApiKeyController.update` (включая `revokedAt: null` на активном ключе)**:
   - Записывает `apiKey` (`update`) с точным `changedFields` (`['expiresAt', 'name']`) и `values: {}`, сохраняет `core."roleTarget"` неизменным и возвращает `null` без записи аудита для несуществующего ключа.
5. **Отзыв ключа через `ApiKeyResolver.revokeApiKey` / `ApiKeyController.remove` и запрет реактивации (`revokedAt: null`) под блокировкой БД**:
   - Записывает `apiKey` (`update`, `changedFields: ['revokedAt']`), а попытка передать `revokedAt: null` для отозванного ключа выбрасывает `ApiKeyExceptionCode.API_KEY_REVOKED` (преобразуемый `ApiKeyResolver.updateApiKey` в `ForbiddenError`) без изменения `core."apiKey"` и без записи аудита.
6. **Защита от мутации входного DTO после старта вызова и невалидной `auditIdentity` до первого `await`**:
   - Мутация входного объекта после вызова не влияет на сохранённые значения и аудит; отсутствие `auditIdentity` отклоняется до любых обращений к кэшу и БД.
7. **Откат при потере подтверждения `COMMIT` (`NativeTransactionOutcomeUnknownError`) и при триггерном искажении `core."apiKey"` после `audit.flush()`**:
   - При потере ACK `COMMIT` в `create` и `update` выбрасывается `NativeTransactionOutcomeUnknownError`, а кэш `apiKeyMap` всё равно инвалидируется в `finally`.
   - При модификации `core."apiKey"` триггером на `crm_audit."crmAuditEntry"` транзакция откатывается целиком.
8. **Проверка дескрипторов безопасности и каталога для `apiKey` (`create`, `update`, запрет `delete`)**:
   - Проверяет отказ при попытке записать `delete` или неверный `securityDescriptor` для `apiKey`.
