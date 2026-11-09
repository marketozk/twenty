# LOG177 - План проверок (`connectionProvider` и `reportAppConnectionAuthFailure`)

## 1. Целевые PostgreSQL интеграционные сценарии (`crm-audit-connection-provider-and-auth-failure.postgres-spec.ts`)

1. **Жизненный цикл `connectionProvider` (`core."connectionProvider"`) и барьер удаления `core.application`**:
   - Создание `connectionProvider` (`type: 'oauth'`, `scope: 'USER'`, `oauthConfig`) через `withApplicationMetadataAudit` / `runAuditedApplicationMetadataMigration` -> `connectionProvider:create` с `values: { applicationId, type: 'oauth', scope: 'USER' }` и `changedFields` без утечки `oauthConfig`, `name`, `displayName`, `logo` и UUID хуков в `values`.
   - Идемпотентное обновление без фактических изменений -> `0` новых записей аудита.
   - Обновление `scope` (`'USER'` -> `'WORKSPACE'`), `displayName`, `oauthConfig` и `onConnectLogicFunctionUniversalIdentifier` -> `connectionProvider:update` с `changedFields: ['displayName', 'oauthConfig', 'onConnectLogicFunctionUniversalIdentifier', 'scope']` и `values.scope: { before: 'USER', after: 'WORKSPACE' }`.
   - Блокировка удаления `connectionProvider`, пока на него ссылается `core."connectedAccount"`, и блокировка `runAuditedApplicationDelete` (`assertNoRemainingApplicationRoleOrPermissionMetadata`), пока у приложения остаются строки `core."connectionProvider"`.
   - Аудируемое удаление `connectionProvider` после очистки `connectedAccount` -> `connectionProvider:delete`, после чего `runAuditedApplicationDelete` проходит штатно.
   - Fail-closed отказ `WorkspaceMigrationRunnerService.executeRun` при попытке выполнить миграцию `connectionProvider` без контекста аудита.
2. **Отчёт об отказе авторизации подключения приложения (`ApplicationConnectionAuthFailureService.reportAuthFailureOrThrow` / `ApplicationConnectionsResolver.reportAppConnectionAuthFailure`)**:
   - Отчёт с причиной (`reason: 'invalid_auth'`) на `WORKSPACE`-подключении -> `connectedAccount:update` (`actor: { kind: 'application', id: oauthAppId }`, `changedFields: ['authFailedAt', 'authFailedReason']`, `values: {}`).
   - Отчёт без причины (`reason: null`) на собственном `USER`-подключении -> `connectedAccount:update` (`changedFields: ['authFailedAt']` при прежнем `authFailedReason === null`, либо `['authFailedAt', 'authFailedReason']` при сбросе непустой причины в `null`).
   - Пропуск устаревшего отчёта при конкурентном обновлении `lastCredentialsRefreshedAt` -> строка не изменяется, `0` новых записей аудита.
   - Штатный `ConnectionProviderException` (`CONNECTION_NOT_FOUND`) при обращении к чужому `applicationId`, чужому `USER`-подключению, архивированному подключению или несуществующему `id` (`0` новых записей аудита).
3. **Инварианты отказоустойчивости**:
   - Post-flush триггер, искажающий `core."connectionProvider"` после вставки в `crm_audit."crmAuditEntry"`, приводит к полному откату транзакции.
   - Потеря подтверждения `COMMIT` пробрасывает `NativeTransactionOutcomeUnknownError` без выполнения `ROLLBACK`.
