# Следующая граница ROB-765 после LOG-175

После закрытия в `LOG-175` транзакционного аудита полного жизненного цикла исходящих вебхуков (`core.webhook` в `WebhookService`, `WebhookResolver`, `WebhookController`, `CreateWebhookTool`, `UpdateWebhookTool`, `DeleteWebhookTool`, `runAuditedApplicationMetadataMigration`, `assertNoRemainingApplicationRoleOrPermissionMetadata` и fail-closed барьере `WorkspaceMigrationRunnerService.executeRun`) открытыми границами `ROB-765` остаются:

1. Оставшиеся административные настройки рабочего пространства и аутентификации в схеме `core` (включая настройки провайдеров входа/SSO `core."workspaceSsoIdentityProvider"`, домены отправки писем `core."emailingDomain"`, общие настройки безопасности `core.workspace`).
2. Семейный отзыв refresh-токенов, in-flight fencing и конкурентный вход в `Session lifecycle`.
3. Публичный `DESTROY` / `MERGE`, реальные `recordShare` и физическое удаление файлов (`FilesFieldDeletionJob`) в общем контуре native/core аудита.
4. Полная HTTP/JWT приёмка и выкат собранного кандидата.
