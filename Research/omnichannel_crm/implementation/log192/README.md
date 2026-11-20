# LOG192 - Транзакционный аудит удаления установленных приложений (`core.application` `delete`) и проброс `auditIdentity` при деинсталляции

## Сводка изменений
- В `application-authorization-and-variable-audit.ts`:
  - `runAuditedApplicationDelete` теперь безусловно блокирует и снимает снимок удаляемой строки `core.application` (`SELECT to_jsonb(a) AS row ... FOR UPDATE`);
  - при отсутствии `request.operation` удаление завершается с fail-closed отказом даже если у приложения нет каскадных записей `applicationAuthorization`, `publicDomain` или `applicationKeyValuePair`;
  - запись `application:delete` (`before: projectApplication(beforeAppRow)`, `after: null`, `metadataAccess: 'currentWorkspaceAdministration'`) пишется в тот же `CrmAuditTransactionContext` (с общим `operationId`), что и каскадные удаления `applicationAuthorization:delete`, `publicDomain:delete` и `applicationKeyValuePair:delete`;
  - после `audit.flush()` повторно проверяется отсутствие удалённой строки в `core.application` (`Application state changed during audit flush`).
- В `ApplicationInstallResolver.uninstallApplication` из `@Context() context?.req` извлекается `auditIdentity` через `roleAuditIdentityFromRequest` и пробрасывается через `ApplicationUninstallRunnerService.uninstallApplication` в `ApplicationSyncService.uninstallApplication`.
- В тестах `fork-migration`:
  - расширен `crm-audit-application-authorization-and-variable.postgres-spec.ts` (проверка fail-closed без каскадных строк, откат при пост-flush изменении `core.application`, полная цепочка `ApplicationUninstallRunnerService` -> `ApplicationSyncService` -> `ApplicationService.delete` и общий `operationId`);
  - расширен `crm-audit-application-default-role.postgres-spec.ts` (проверка проброса `auditIdentity` и `impersonatorUserWorkspaceId` из `ApplicationInstallResolver.uninstallApplication`);
  - обновлены ожидания для нового события `application:delete` в 9 смежных PostgreSQL-спеках (`crm-audit-application-metadata`, `crm-audit-command-menu-item`, `crm-audit-front-component-and-settings-menu-item`, `crm-audit-logic-function`, `crm-audit-page-layout`, `crm-audit-skill`, `crm-audit-timeline-activity-type`, `crm-audit-webhook`, `crm-audit-workspace-domain`).

## Артефакты
- [Дизайн](design.md)
- [Ревью дизайна](design-review.md)
- [Исследование тестов](test-research.md)
- [Ревью кода](review.md)
- [Результаты проверок](results.json)
- [Дифференциальный typecheck](typecheck-differential.json)
- [Снимок исходников](source-snapshot.json)
- [Лог регрессии](regression.log)
- [Следующая граница](next-boundary.md)
