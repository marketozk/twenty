# LOG165 - план тестирования и матрица проверок (аудит метаданных ролей, прав и `roleTarget` приложений)

## 1. Целевые сценарии в `crm-audit-application-metadata.postgres-spec.ts`

Набор поднимает ограниченную роль PostgreSQL (без прав суперпользователя, только append-only права на `crm_audit."crmAuditEntry"`) и проверяет реальные реализации `WorkspaceMigrationRunnerService`, `ApplicationManifestMigrationService`, `ApplicationSyncService`, `ApplicationService.delete`, `TwentyStandardApplicationService` и `runAuditedApplicationMetadataMigration`.

1. **Синхронизация стандартного приложения (`TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`)**:
   - создание и обновление стандартной роли `Admin` (`isEditable: false`, `applicationUniversalIdentifier = TWENTY_STANDARD_APPLICATION.universalIdentifier`) под системным актором (`workspace-manager:init` / `twenty-standard-application:sync`) атомарно создаёт/обновляет строку в `core.role` и записывает событие `role` (`create` / `update`) в `crm_audit."crmAuditEntry"` в одной транзакции с назначением `core.application."defaultRoleId"`.
2. **Первичная установка и обновление манифеста приложения (`ApplicationManifestMigrationService.syncMetadataFromManifest`)**:
   - установка манифеста с ролями, флагами прав (`rolePermissionFlag`), объектными (`objectPermission`) и полевыми (`fieldPermission`) правами, группами и предикатами строкового доступа (`rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`) и агентом с `roleUniversalIdentifier` (`roleTarget`) в одной транзакции записывает события `create` по всем созданным сущностям с общим `operationId`, `actor` и `initiator` (включая имперсонацию из `withCrmAuditRequest` и системную атрибуцию из `withCrmAuditIdentity`);
   - обновление манифеста (изменение флагов роли, прав на объекты и поля, предикатов, смена `roleUniversalIdentifier` агента на другую роль манифеста) записывает точные `update`-события и пару `roleTarget:delete` + `roleTarget:create` при смене роли агента.
3. **Ресинк манифеста после замены роли агента через `AgentService` / `AiAgentRoleService` (`IDX_ROLE_TARGET_UNIQUE_AGENT`)**:
   - когда у агента приложения в `core."roleTarget"` существует привязка со случайным `universalIdentifier`, созданная под `workspaceCustomFlatApplication`, повторный `syncMetadataFromManifest` включает эту привязку в `flatEntityToDelete.roleTarget`, удаляет её до вставки привязки манифеста без конфликта `IDX_ROLE_TARGET_UNIQUE_AGENT` и записывает `roleTarget:delete` (старый `id`) и `roleTarget:create` (новый `id`) в одной транзакции.
4. **Удаление сущностей при обновлении манифеста (`inferDeletionFromMissingEntities: true`) и полное удаление приложения (`ApplicationSyncService.uninstallApplication` + `ApplicationService.delete`)**:
   - удаление роли, агента, объекта, поля или флага прав при обновлении манифеста или при `uninstallApplication` явно удаляет и аудирует в том же коммите все зависимые `role`, агентские `roleTarget`, `rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate` (включая строки прав и агентские `roleTarget`, созданные под `workspaceCustomFlatApplication`), после чего `ApplicationService.delete` успешно удаляет строку `core.application`;
   - прямой вызов `ApplicationService.delete` при наличии неудалённых ролей, `roleTarget` или прав в `core` отклоняется с `'Application delete requires prior audited removal of role and permission metadata'` без удаления приложения.
5. **Fail-closed защита инвариантов в `runAuditedApplicationMetadataMigration` и `WorkspaceMigrationRunnerService`**:
   - попытка выполнить миграцию над `role` / `roleTarget` / правами через `WorkspaceMigrationRunnerService.run` без активного контекста CRM-аудита отклоняется с `'Workspace migration touching role or permission metadata requires an active CRM audit scope'`;
   - попытка удалить роль приложения, которая является `core.workspace."defaultRoleId"`, `core.application."defaultRoleId"` другого приложения или назначена участнику (`userWorkspaceId`) / API-ключу (`apiKeyId`), либо при появлении в БД незапланированной привязки `roleTarget` у удаляемого агента/роли, либо при наличии soft-deleted строк `rowLevelPermissionPredicate` / `rowLevelPermissionPredicateGroup` под удаляемой сущностью, откатывает транзакцию без изменений в `core` и `crm_audit."crmAuditEntry"`.
6. **Неопределённость коммита (`NativeTransactionOutcomeUnknownError`) и ошибка после коммита (`CoreAuditPostCommitError`)**:
   - при потере подтверждения `COMMIT` в `WorkspaceMigrationRunnerService.executeRun` выбрасывается `NativeTransactionOutcomeUnknownError` без запуска `executeActionRollbackHandler` и без `ROLLBACK`, кэш метаданных и `rolesPermissions` инвалидируется;
   - при ошибке после подтверждённого `COMMIT` выбрасывается `CoreAuditPostCommitError` без `ROLLBACK` и с инвалидацией кэша.

## 2. Регрессионные и граничные проверки

- 12 целевых PostgreSQL-наборов аудита ролей, привязок, API-ключей, `workspace.defaultRoleId`, `application.defaultRoleId` и метаданных приложений.
- Полная регрессия `ROB-765`.
- Дифференциальный typecheck (`typecheck-diff.cjs`), `check_enterprise_dependencies.py --verify-baseline`, `check_fork_migration_sources.py` и 33 guard unit-теста.
