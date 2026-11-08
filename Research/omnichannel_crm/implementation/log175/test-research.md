# LOG175 - Исследование тестового контура (`crm-audit-webhook.postgres-spec.ts`)

## 1. Цели тестирования

Проверить на реальной PostgreSQL (`twenty_rob764_test_*` с применённой миграцией `OmniAuditBootstrapFastInstanceCommand` и непривилегированной runtime-ролью):
1. **Полный жизненный цикл `webhook` (`create`, `update`, no-op `update`, `delete`) через `WebhookResolver`, `WebhookController`, `WebhookService` и AI-инструменты (`CreateWebhookTool`, `UpdateWebhookTool`, `DeleteWebhookTool`)**:
   - Создание вебхука (`WebhookResolver.createWebhook`) с имперсонацией (`impersonatorUserWorkspaceId` -> `initiator: { kind: 'coreUser', id: impersonatorUserId }`): запись `webhook:create` в `crm_audit."crmAuditEntry"`, `redactedDiff.values = { applicationId: { before: null, after: customApplicationId } }`, `changedFields = ['applicationId', 'description', 'operations', 'secret', 'targetUrl']`, отсутствие `targetUrl`, `operations`, `description`, `secret` в `redactedDiff.values`.
   - Обновление вебхука (`WebhookController.update` и `UpdateWebhookTool.execute`): изменение `targetUrl`, `operations`, `description`, `secret` -> запись `webhook:update` только по фактически изменившимся полям, отсутствие лишних записей при идемпотентном повторе (`no-op update`).
   - Создание и удаление вебхука через AI-инструменты (`CreateWebhookTool.execute` с `agentId` -> `actor: { kind: 'agent', id: agentId }`, `initiator: { kind: 'coreUser', id: ownerUserId }`, и `DeleteWebhookTool.execute` / `WebhookController.remove` / `WebhookResolver.deleteWebhook`) и с аутентификацией по `apiKey` (`actor: { kind: 'apiKey', id: apiKeyId }`).
2. **Пакетные миграции приложений (`runAuditedApplicationMetadataMigration`), системная сборка и защита удаления приложения (`assertNoRemainingApplicationRoleOrPermissionMetadata` / `runAuditedApplicationDelete`)**:
   - Создание, обновление и удаление `webhook` в составе `withApplicationMetadataAudit` (`runAuditedApplicationMetadataMigration`).
   - Блокировка `assertNoRemainingApplicationRoleOrPermissionMetadata` и `runAuditedApplicationDelete`, пока у приложения остаётся строка в `core.webhook`, и успешное завершение после аудируемого удаления вебхука.
   - Автоматическая обёртка системной миграции (`isSystemBuild: true` в `WorkspaceMigrationValidateBuildAndRunService`) при создании/обновлении/удалении `webhook`.
3. **Fail-closed инварианты, откат при сбое триггера/аудита и `NativeTransactionOutcomeUnknownError`**:
   - Отказ при прямом вызове `WorkspaceMigrationRunnerService.run` с действием `webhook` без активного контекста аудита.
   - Отказ при вызове `WebhookService.create` / `update` / `delete` без аутентифицированного субъекта.
   - Отказ при повторном использовании одноразового `NavigationMenuItemAuditRequest`.
   - Откат транзакции при модификации строки `core.webhook` триггером после `audit.flush()`.
   - Сохранение коммита и инвалидация `flatWebhookMaps` при потере подтверждения `COMMIT` (`NativeTransactionOutcomeUnknownError`).
