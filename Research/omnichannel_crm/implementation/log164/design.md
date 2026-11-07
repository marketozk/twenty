# LOG164 - дизайн аудита смены роли приложения по умолчанию (`core.application."defaultRoleId"`)

## 1. Контекст

Поле `core.application."defaultRoleId"` определяет роль, под которой выполняются серверные функции (`logicFunction`), шаги и триггеры workflow (`workflow-execution-context.service.ts:227-243`, `call-database-event-trigger-jobs.job.ts:117`), запросы REST/GraphQL/MCP от имени приложения (`resolve-role-ids-from-auth-context.util.ts:22-33`, `mcp-protocol.service.ts:175-185`) и доступ к записям (`build-record-share-inputs-for-created-records.util.ts:60`). Изменение `core.application."defaultRoleId"` напрямую меняет объём полномочий приложения в рабочем пространстве.

После `LOG111`-`LOG163` все операции над `core.role`, `core."roleTarget"`, правами ролей, API-ключами и `core.workspace."defaultRoleId"` переведены на закрытый транзакционный CRM-аудит. Проверка всех обращений к `ApplicationEntity` и `core.application` в `packages/twenty-server/src` (за исключением уже зафиксированных исторических upgrade-команд `2-19`, `2-43`, `2-51`, которые по правилам репозитория не переписываются) показала, что в runtime `core.application."defaultRoleId"` изменяется только через `ApplicationService.update` (`application.service.ts:802-837`) из трёх путей:

1. `RoleService.createWorkspaceCustomApplicationRole` (`role.service.ts:641`): при инициализации пространства (`WorkspaceManagerService.init`, `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace`) назначает кастомному приложению пространства его системную роль.
2. `TwentyStandardApplicationService.setStandardApplicationDefaultRoleOrThrow` (`twenty-standard-application.service.ts:160`), вызываемый из `synchronizeTwentyStandardApplicationOrThrow` (`WorkspaceManagerService.init`, `DevSeederWorkspaceService.seedDev`): назначает стандартному приложению роль `Admin`.
3. `ApplicationManifestMigrationService.syncApplicationReferencesFromManifest` (`application-manifest-migration.service.ts:438`), вызываемый из `syncMetadataFromManifest` -> `ApplicationSyncService.synchronizeFromManifest` при установке, обновлении и dev-синхронизации манифеста приложения: разрешает `manifest.application.defaultRoleUniversalIdentifier` среди `manifest.roles` и передаёт `defaultRoleId` в `ApplicationService.update`.

Все остальные вызовы `ApplicationService.update` и `applicationRepository.update` изменяют только неролевые поля (`grantedCapabilities`, `logo`, `logoFileId`, `version`, `autoUpgrade`, `isSdkLayerStale`, `sdkClientCoreChecksum`, `uninstallHookCompletedForRequestedAt`, `name`, `description`, чексуммы пакетов).

## 2. Архитектура решения

### 2.1. Каталог аудита (`crm-audit.types.ts`, `crm-audit-transaction-context.ts`)

- Добавить `'application'` в `CrmAuditResourceKind`.
- Добавить `application: { values: ['defaultRoleId'], redacted: [] }` в `CATALOG` и `application: ['update']` в `ADMINISTRATIVE_ACTIONS`.
- Записи аудита `application` / `update` получают `securityDescriptor: { resourceKind: 'application', resourceId: applicationId, metadataAccess: 'currentWorkspaceAdministration' }`.

### 2.2. Синхронный захват атрибуции (`crm-audit-attribution-context.ts`) и модуль `application-default-role-audit.ts`

1. В `crm-audit-attribution-context.ts` добавить синхронную функцию `captureCurrentCrmAuditOperation(workspaceId)`:
   - читает текущий снимок из `AsyncLocalStorage` (установленный `WorkspaceAuthContextMiddleware` через `withCrmAuditRequest` для HTTP/GraphQL-запросов или `withCrmAuditIdentity` для фоновых задач и CLI-команд жизненного цикла приложений: `TriggerInstallApplicationJob`, `TriggerUpgradeApplicationJob`, `TriggerUninstallApplicationJob`, `UpgradeWorkspaceApplicationJob`, `InstallApplicationCommand`, `PreInstalledAppsService`, `OAuthService`);
   - синхронно проверяет совпадение `workspaceId` и валидность субъекта (`coreUser`, `apiKey`, `application`, `agent`, `system`), возвращая `{ operation, impersonatorUserWorkspaceId }`, либо `undefined`, если контекст отсутствует.
2. Создать `packages/twenty-server/src/engine/core-modules/crm-audit/application-default-role-audit.ts`:
   - регистрирует `getApplicationDefaultRoleAudit` в `registerMetadataAuditScopeCheck`;
   - `captureApplicationDefaultRoleAudit({ workspaceId, applicationId, auditIdentity })` выполняется синхронно до первого `await`:
     - проверяет валидность UUID `workspaceId` и `applicationId`;
     - отклоняет вложенный metadata-аудит (`'Nested application default role audit is unsupported'`);
     - принимает явный `auditIdentity` (`RoleUpdateAuditIdentity` или `MembershipCleanupIdentity`) либо, если он не передан, захватывает операцию через `captureCurrentCrmAuditOperation(workspaceId)`; при отсутствии или невалидности субъекта возвращает thunk, выбрасывающий `'Role mutation requires authenticated audit identity'` (или ошибку валидации субъекта) до обращения к БД;
   - `runAuditedApplicationDefaultRoleUpdate(dataSource, request, defaultRoleId, work)`:
     - блокирует повторное использование `request` (`WeakSet`) и вложенные metadata-аудит контексты;
     - проверяет, что `defaultRoleId` равен `null` либо валидному UUID;
     - внутри `runInCoreAuditTransaction`:
       1. `SET LOCAL lock_timeout = '8s'`;
       2. `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE` (сериализация со всеми ролевыми операциями пространства);
       3. `SELECT id,"workspaceId","universalIdentifier",to_jsonb(a)->>'defaultRoleId' AS "defaultRoleId",to_jsonb(a)->>'deletedAt' AS "deletedAt" FROM core.application a WHERE a.id=$1 AND a."workspaceId"=$2 FOR UPDATE`;
       4. если `defaultRoleId !== null`: `SELECT to_jsonb(r) AS row FROM core.role r WHERE id=$1 AND "workspaceId"=$2 FOR SHARE`, проверяет существование роли в том же пространстве и принадлежность роли этому приложению (`uuid(targetRole.applicationId) === request.applicationId`), исключая привязку приложения к чужой роли;
       5. разрешает инициатора имперсонации (`resolveRoleAuditInitiator`), создаёт `CrmAuditTransactionContext`, выполняет `work(runner)`;
       6. сверяет состояние `core.application` и `core.role` после `work(runner)` (`verifyState('update')`);
       7. если `beforeDefaultRoleId !== normalizedDefaultRoleId`, записывает событие `application` (`update`, `changedFields: ['defaultRoleId']`, `values: { defaultRoleId: { before, after } }`), вызывает `await audit.flush()` и повторно сверяет состояние (`verifyState('flush')`).

### 2.3. Подключение `ApplicationService` и вызывающих сервисов

1. `ApplicationService.update(id, data, options?: { auditIdentity?: RoleUpdateAuditIdentity | MembershipCleanupIdentity })`:
   - синхронно до первого `await` копирует `const capturedData = { ...data };` (защита от TOCTOU-мутации входного объекта) и при `capturedData.defaultRoleId !== undefined` вызывает `captureApplicationDefaultRoleAudit(...)()`;
   - при `capturedData.defaultRoleId !== undefined` выполняет обновление и чтение обновлённой строки `ApplicationEntity` внутри `runAuditedApplicationDefaultRoleUpdate` через `queryRunner.manager`;
   - при `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` инвалидирует `['flatApplicationMaps']` в защищённом `try / catch` и пробрасывает ошибку без отправки ложного события `broadcastApplicationEvent`;
   - при вызовах без `defaultRoleId` поведение не меняется.
2. Вызывающие пути:
   - `RoleService.createWorkspaceCustomApplicationRole`: передаёт `{ auditIdentity: capturedIdentity }` в `this.applicationService.update(...)`.
   - `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow` и `setStandardApplicationDefaultRoleOrThrow`: принимают опциональный `auditIdentity?: RoleUpdateAuditIdentity` (по умолчанию системный актор `twenty-standard-application:sync`; `WorkspaceManagerService.init` передаёт `workspace-manager:init`, `DevSeederWorkspaceService.seedDev` передаёт `dev-seeder:seed-twenty-standard-application`) и пробрасывают его в `this.applicationService.update(...)`.
   - `ApplicationManifestMigrationService.syncApplicationReferencesFromManifest`: передаёт `ownerApplicationId: ownerFlatApplication.id` в `resolveApplicationReferenceIdOrThrow` для ролей манифеста (включая явную проверку `manifest.application.defaultRoleUniversalIdentifier`, если он не встретился в `manifest.roles`), передаёт `{ defaultRoleId }` при установке роли или её сбросе в `null` (`inferDeletionFromMissingEntities && isDefined(ownerFlatApplication.defaultRoleId)`) и пробрасывает опциональный `auditIdentity` в `this.applicationService.update(...)`.
   - `ApplicationService.create`: отклоняет непустой `data.defaultRoleId` (`'Application creation cannot assign defaultRoleId without audit'`), чтобы назначение роли приложения по умолчанию всегда проходило через `runAuditedApplicationDefaultRoleUpdate`.

## 3. Затронутые файлы

1. `packages/twenty-server/src/engine/core-modules/crm-audit/application-default-role-audit.ts` (новый)
2. `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit.types.ts`
3. `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`
4. `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-attribution-context.ts`
5. `packages/twenty-server/src/engine/core-modules/application/application.service.ts`
6. `packages/twenty-server/src/engine/core-modules/application/application-manifest/application-manifest-migration.service.ts`
7. `packages/twenty-server/src/engine/metadata-modules/role/role.service.ts`
8. `packages/twenty-server/src/engine/workspace-manager/twenty-standard-application/services/twenty-standard-application.service.ts`
9. `packages/twenty-server/src/engine/workspace-manager/workspace-manager.service.ts`
10. `packages/twenty-server/src/engine/workspace-manager/dev-seeder/services/dev-seeder.workspace-service.ts`
11. `packages/twenty-server/test/fork-migration/crm-audit-application-default-role.postgres-spec.ts` (новый)
12. `packages/twenty-server/test/fork-migration/crm-audit-system-role-and-seeder.postgres-spec.ts`
