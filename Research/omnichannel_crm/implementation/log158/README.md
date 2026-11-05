# LOG158 - аудит создания, обновления и отзыва API-ключей с атомарной привязкой roleTarget

Проверки доработки завершены. ROB765 остаётся In Progress.
[Дизайн](design.md), [ревью решения](design-review.md), [ревью кода](review.md), [план проверок](test-research.md).

LOG158 закрывает все мутационные точки жизненного цикла `core."apiKey"`: создание ключа с привязкой к роли (`ApiKeyService.create`, `ApiKeyResolver.createApiKey`, `ApiKeyController.create`, CLI `GenerateApiKeyCommand`), обновление ключа (`ApiKeyService.update`, `ApiKeyResolver.updateApiKey`, `ApiKeyController.update`) и отзыв ключа (`ApiKeyService.revoke`, `ApiKeyResolver.revokeApiKey`, `ApiKeyController.remove`).

В `crm-audit.types.ts` и `crm-audit-transaction-context.ts` добавлен административный вид ресурса `apiKey` (`actions: ['create', 'update']`, `values: []`, `redacted: ['name', 'expiresAt', 'revokedAt']`) с обязательным дескриптором `{ resourceKind: 'apiKey', resourceId, metadataAccess: 'currentWorkspaceAdministration' }`. В `role-update-audit.ts` добавлена поддержка `systemActorId` для системного субъекта CLI (`GenerateApiKeyCommand` -> `{ kind: 'system', id: 'workspace:generate-api-key' }`) и общая проверка взаимного исключения контекстов метаданных (`registerMetadataAuditScopeCheck` / `hasConflictingMetadataAuditScope`).

В `api-key-audit.ts`, `WorkspaceMigrationRunnerService` и `ApiKeyService` добавлены `withApiKeyCreateAudit`, `runAuditedApiKeyCreate` и `runAuditedApiKeyUpdate`. При создании API-ключа `INSERT INTO core."apiKey"`, создание `core."roleTarget"` (`CreateRoleTargetActionHandlerService`) и запись двух событий `crm_audit."crmAuditEntry"` (`apiKey` `create` и `roleTarget` `create` с общим `operationId`) выполняются в одной транзакции `runInCoreAuditTransaction` под блокировками `core.workspace` (`FOR NO KEY UPDATE`), `core.application` (`FOR SHARE`), `core.role` (`FOR SHARE`, проверка `canBeAssignedToApiKeys === true`), `core."apiKey"` и `core."roleTarget"` (`FOR UPDATE`), полностью устраняя прежний трёхтранзакционный паттерн с компенсирующим `DELETE`. При обновлении и отзыве ключа в `runAuditedApiKeyUpdate` под блокировкой `FOR UPDATE` на `core."apiKey"` и `FOR SHARE` на `core."roleTarget"` проверяется запрет реактивации отозванного ключа (`revokedAt === null` при `before.revokedAt !== null` -> `ApiKeyExceptionCode.API_KEY_REVOKED`), обновляется `core."apiKey"`, записывается событие `apiKey` (`update`) до `COMMIT` и повторно сверяется состояние после `audit.flush()`. Кэш `apiKeyMap` инвалидируется после коммита и в `finally` при `NativeTransactionOutcomeUnknownError`.

3058 tests/103 suites PASS (670.323s). 249 targeted/6 suites PASS (22.68s), 12 новых PostgreSQL случаев. 26 guard tests PASS, 10 migration checksums неизменны. Types 456/458 roots, baseline 238 / current 237 diagnostics, 0 новых/changed-code. Совпали 12 local/remote source hashes.

[Результаты](results.json), [сверка исходников](source-snapshot.json),
[типы](typecheck-differential.json), [регрессия](regression.log).

Далее - [аудит пакетного и первичного назначения ролей участникам (`assignRoleToManyUserWorkspace`)](next-boundary.md). Полный HTTP/JWT контроль и выкат остаются открытыми критериями. GitHub Actions не используется.
