# LOG164 - план тестирования и матрица проверок (`core.application."defaultRoleId"`)

## 1. Целевые сценарии в `crm-audit-application-default-role.postgres-spec.ts`

Набор поднимает ограниченную роль PostgreSQL (без прав владельца/суперпользователя, только append-only в `crm_audit."crmAuditEntry"`) и проверяет реальные реализации `ApplicationService.update`, `RoleService.createWorkspaceCustomApplicationRole`, `TwentyStandardApplicationService`, `ApplicationManifestMigrationService` и `runAuditedApplicationDefaultRoleUpdate`.

1. **Системная инициализация `defaultRoleId` стандартного и кастомного приложений**:
   - `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow` (через `setStandardApplicationDefaultRoleOrThrow`) устанавливает `defaultRoleId = adminRoleId` на стандартном приложении и записывает в одной транзакции событие `application` (`update`, `resourceId: standardAppId`, `changedFields: ['defaultRoleId']`, `values.defaultRoleId: { before: null, after: adminRoleId }`, `actor: { kind: 'system', id: 'workspace-manager:init' }`);
   - `RoleService.createWorkspaceCustomApplicationRole` создаёт системную роль кастомного приложения (`role:create`) и атомарно устанавливает `defaultRoleId` на кастомном приложении с записью `application` (`update`, `resourceId: customAppId`, `actor: { kind: 'system', id: 'workspace-manager:init' }`).
2. **Синхронизация манифеста приложения (`ApplicationManifestMigrationService.syncApplicationReferencesFromManifest`) с контекстной и явной атрибуцией**:
   - вызов внутри `withCrmAuditRequest` (HTTP-запрос пользователя, в том числе с имперсонацией `impersonatorUserWorkspaceId`) и внутри `withCrmAuditIdentity` (фоновая задача установки/обновления приложения) обновляет `core.application."defaultRoleId"` и записывает `application` (`update`) с соответствующим `actor` и `initiator`;
   - смена `defaultRoleId` с одной роли приложения на другую и сброс в `null` корректно фиксируют `before` и `after`.
3. **Идемпотентный no-op при совпадении `defaultRoleId`**:
   - повторная передача того же `defaultRoleId` (без учёта регистра UUID) обновляет попутные поля приложения (`name`, `version`, `uninstallLogicFunctionId`) внутри транзакции без создания лишней записи в `crm_audit."crmAuditEntry"`.
4. **Защита под блокировкой БД (`core.workspace FOR NO KEY UPDATE`, `core.application FOR UPDATE`, `core.role FOR SHARE`)**:
   - попытка назначить приложению несуществующую роль, роль другого рабочего пространства, роль другого приложения (`targetRole.applicationId !== application.id`, например попытка стороннего приложения назначить себе стандартную роль `Admin`) или невалидный UUID откатывает транзакцию (`'Application default role is unavailable or not owned by application'`), оставляя `core.application` и `crm_audit."crmAuditEntry"` без изменений.
5. **Fail-closed валидация `auditIdentity` и аудит-контекста до первого `await`**:
   - вызов `ApplicationService.update` с `defaultRoleId` без `auditIdentity` и вне `withCrmAuditRequest` / `withCrmAuditIdentity`, либо с неаудируемым `pendingActivationUser`, либо внутри активного metadata-аудита (`withRoleUpdateAudit`), либо при повторном использовании токена отклоняется синхронно до обращения к БД;
   - обновления `ApplicationService.update` без `defaultRoleId` (например, `version`, `autoUpgrade`, `logo`) работают без `auditIdentity` и защищены от TOCTOU-мутации входного объекта `data` во время `await`.
6. **Потеря подтверждения `COMMIT` (`NativeTransactionOutcomeUnknownError`) и ошибка после подтверждённого `COMMIT` (`CoreAuditPostCommitError`)**:
   - при обрыве на `COMMIT` выбрасывается `NativeTransactionOutcomeUnknownError`, `ROLLBACK` не отправляется, `workspaceCacheService.invalidateAndRecompute(workspaceId, ['flatApplicationMaps'])` вызывается, а `workspaceEventBroadcaster` не рассылает событие до подтверждения;
   - при ошибке после подтверждённого `COMMIT` выбрасывается `CoreAuditPostCommitError` без `ROLLBACK`, кэш `flatApplicationMaps` инвалидируется.

## 2. Обновление существующих PostgreSQL-наборов

- `crm-audit-system-role-and-seeder.postgres-spec.ts`: проверка проброса `{ auditIdentity }` из `RoleService.createWorkspaceCustomApplicationRole` в `applicationService.update`.

## 3. Регрессионные и граничные проверки

- 11 целевых PostgreSQL-наборов аудита ролей, привязок, API-ключей, `workspace.defaultRoleId` и `application.defaultRoleId`.
- Полная регрессия `ROB-765`.
- Дифференциальный typecheck (`typecheck-diff.cjs`), `check_enterprise_dependencies.py --verify-baseline`, `check_fork_migration_sources.py` и guard unit-тесты.
