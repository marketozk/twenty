# LOG192 - Исследование тестового покрытия

## Целевые тестовые наборы
1. `packages/twenty-server/test/fork-migration/crm-audit-application-authorization-and-variable.postgres-spec.ts`:
   - Обновление проверки `ApplicationSyncService.uninstallApplication`: подтверждается `4` записи (`application:delete` + 2 `applicationAuthorization:delete` с одним общим `operationId`, и `role:delete` с отдельным `operationId`), а также проверка `redactedDiff` и сокрытия `name` приложения.
   - Новый PostgreSQL-сценарий `LOG192`:
     - прямой неаутентифицированный вызов `ApplicationService.delete` без каскадных строк отклоняется fail-closed;
     - вызов через `ApplicationInstallResolver.uninstallApplication` -> `ApplicationUninstallRunnerService.uninstallApplication` -> `ApplicationSyncService.uninstallApplication` -> `ApplicationService.delete` с `context.req` (включая имперсонацию) записывает `application:delete` с `actor` и `initiator`, с сокрытием чувствительных полей `name` и проверкой `values`;
     - post-flush проверка: подмена/повторная вставка строки `core.application` во время `audit.flush()` откатывает транзакцию с ошибкой `Application state changed during audit flush`.
2. Обновление ожиданий на добавленную запись `application:delete` в 7 существующих PostgreSQL-тестах, вызывающих `runAuditedApplicationDelete` / `ApplicationSyncService.uninstallApplication`:
   - `crm-audit-application-metadata.postgres-spec.ts`
   - `crm-audit-command-menu-item.postgres-spec.ts`
   - `crm-audit-front-component-and-settings-menu-item.postgres-spec.ts`
   - `crm-audit-logic-function.postgres-spec.ts`
   - `crm-audit-page-layout.postgres-spec.ts`
   - `crm-audit-timeline-activity-type.postgres-spec.ts`
   - `crm-audit-workspace-domain.postgres-spec.ts` (проверка совпадения `operationId` для `publicDomain:delete` / `applicationKeyValuePair:delete` и `application:delete`).
3. Полная регрессия всех 128 сьютов `twenty-server`, включая `crm-audit-skill.postgres-spec.ts` и `crm-audit-webhook.postgres-spec.ts`.
