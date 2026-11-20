# LOG192 - Дизайн транзакционного аудита удаления приложений (`application:delete` в `core.application`) и проброса `auditIdentity` через `ApplicationInstallResolver.uninstallApplication` / `ApplicationUninstallRunnerService`

## 1. Контекст и цель
После закрытия `LOG188`-`LOG191` в жизненном цикле `core.application` (`create`, `update`, `delete`) остаётся последний незакрытый участок:
1. В `runAuditedApplicationDelete` (`application-authorization-and-variable-audit.ts`) при удалении строки `core.application`:
   - ранее аудировались только каскадно удаляемые строки (`applicationAuthorization:delete`, `publicDomain:delete`, `applicationKeyValuePair:delete`), но не сама удаляемая запись `core.application` (`application:delete`);
   - при отсутствии каскадных строк `runAuditedApplicationDelete` допускал удаление без `request.operation` (неаутентифицированный вызов `ApplicationService.delete` не отклонялся fail-closed);
   - после `audit.flush()` не перепроверялось, что строка `core.application` всё ещё отсутствует (защита от post-flush подмены триггерами).
2. В `ApplicationInstallResolver.uninstallApplication` -> `ApplicationUninstallRunnerService.uninstallApplication` -> `ApplicationSyncService.uninstallApplication`:
   - GraphQL-контекст запроса (`context.req`) не извлекался через `roleAuditIdentityFromRequest` и не пробрасывался в `ApplicationUninstallRunnerService.uninstallApplication` и `ApplicationSyncService.uninstallApplication`.

## 2. Архитектура решения
1. В `application-authorization-and-variable-audit.ts` (`runAuditedApplicationDelete`):
   - Блокировка и чтение полного снимка строки `core.application`:
     `SELECT to_jsonb(a) AS row FROM core.application a WHERE a.id=$1 AND a."workspaceId"=$2 FOR UPDATE`.
   - Безусловное требование аутентифицированной идентичности операции (`if (!request.operation)` -> fail-closed ошибка `request.captureError ?? new Error('Application authorization mutation requires authenticated audit identity')`).
   - Создание `CrmAuditTransactionContext` для каждой операции удаления `core.application` с разрешением инициатора (`resolveRoleAuditInitiator`).
   - После выполнения `work(runner)` и проверки удаления `core.application` и всех каскадных таблиц (`applicationAuthorization`, `publicDomain`, `keyValuePair`):
     - запись каскадных `applicationAuthorization:delete`, `publicDomain:delete`, `applicationKeyValuePair:delete`;
     - запись `application:delete` (`before: projectApplication(beforeAppRow)`, `after: null`, `securityDescriptor: { resourceKind: 'application', resourceId: normalizedApplicationId, metadataAccess: 'currentWorkspaceAdministration' }`) с тем же `operationId`, что и каскадные удаления;
     - выполнение `await audit.flush()`;
     - пост-flush проверка, что `core.application` (`SELECT id FROM core.application WHERE id=$1`) и все каскадные таблицы пусты (`Application state changed during audit flush`).
2. В `ApplicationInstallResolver.uninstallApplication` и `ApplicationUninstallRunnerService.uninstallApplication`:
   - Добавляется извлечение `auditIdentity` через `roleAuditIdentityFromRequest(context.req)` в `ApplicationInstallResolver.uninstallApplication` и опциональный параметр `auditIdentity?: ApplicationMetadataAuditIdentity` в `ApplicationUninstallRunnerService.uninstallApplication`, пробрасываемый в `ApplicationSyncService.uninstallApplication`.
3. Граница Enterprise:
   - `projectApplication` импортируется из уже подключённого `workspace-domain-audit.ts`; новые рёбра к `@license Enterprise` не добавляются.
