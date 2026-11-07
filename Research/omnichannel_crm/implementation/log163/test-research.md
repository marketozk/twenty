# LOG163 - план тестирования и матрица проверок (`core.workspace."defaultRoleId"`)

## 1. Целевые сценарии в `crm-audit-workspace-default-role.postgres-spec.ts`

Набор поднимает ограниченную роль PostgreSQL (без прав владельца/суперпользователя, только append-only в `crm_audit."crmAuditEntry"`) и проверяет настоящий код `WorkspaceService`, `WorkspaceResolver`, `WorkspaceManagerService`, `DevSeederPermissionsService` и `runAuditedWorkspaceDefaultRoleUpdate`.

1. **Публичное обновление `defaultRoleId` через `WorkspaceService.updateWorkspaceById` и `WorkspaceResolver.updateWorkspace`**:
   - смена `defaultRoleId` с `memberRoleId` на `secondUserRoleId` (в том числе одновременно с другими полями пространства, например `displayName`) записывает в одной транзакции новое значение в `core.workspace` и ровно одну запись `workspace` (`update`, `changedFields: ['defaultRoleId']`, `values.defaultRoleId: { before: memberRoleId, after: secondUserRoleId }`, `metadataAccess: 'currentWorkspaceAdministration'`);
   - вызов через `WorkspaceResolver.updateWorkspace` извлекает `auditIdentity` из HTTP-запроса (`roleAuditIdentityFromRequest(context.req)`), включая разрешение инициатора `coreUser` при имперсонации (`impersonationContext.impersonatorUserWorkspaceId`).
2. **Идемпотентный no-op при совпадении `defaultRoleId`**:
   - если `payload.defaultRoleId` (включая разный регистр UUID) совпадает с текущим `core.workspace."defaultRoleId"` под блокировкой `FOR NO KEY UPDATE`, транзакция обновляет попутные поля запроса без записи пустого события в `crm_audit."crmAuditEntry"`.
3. **Защита под блокировкой БД (`FOR NO KEY UPDATE` на `core.workspace`, `FOR SHARE` на `core.role`)**:
   - если целевая роль удалена, принадлежит другому пространству или имеет `canBeAssignedToUsers === false` в момент захвата блокировки в транзакции (даже если предварительная проверка по кэшу была пройдена или замокана), транзакция откатывается (`'Workspace default role is unavailable or not assignable to users'`), `core.workspace."defaultRoleId"` и `crm_audit."crmAuditEntry"` не изменяются;
   - попытка записать `defaultRoleId: null` на активном пространстве отклоняется (`'Workspace default role is unavailable or not assignable to users'`).
4. **Fail-closed валидация `auditIdentity` и аудит-контекста**:
   - вызов `updateWorkspaceById` с `defaultRoleId` без `auditIdentity` или с неаудируемым `pendingActivationUser` отклоняется до записи в БД и до внешних побочных эффектов DNS;
   - вызов внутри активного metadata-аудита (`withRoleUpdateAudit`) синхронно до первого `await` отклоняется с `'Nested workspace default role audit is unsupported'`, не обращаясь к репозиторию и сервисам прав;
   - обновление других полей `WorkspaceService.updateWorkspaceById` без `defaultRoleId` (например, `displayName`) работает без `auditIdentity` и не пишет записей `workspace` в `crm_audit."crmAuditEntry"`.
5. **Системные пути инициализации (`WorkspaceManagerService.setupDefaultRoles`, `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace`)**:
   - `WorkspaceManagerService.setupDefaultRoles` атомарно устанавливает `defaultRoleId = memberRole.id` и записывает `workspace` (`update`, `before: null`, `after: memberRole.id`, `actor: { kind: 'system', id: 'workspace-manager:setup-default-roles' }`);
   - `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace` в одной транзакции устанавливает `defaultRoleId = memberRole.id` и `activationStatus = 'ACTIVE'` и записывает `workspace` (`update`, `actor: { kind: 'system', id: 'dev-seeder:init-minimal-permissions' }`).
6. **Потеря подтверждения `COMMIT` (`NativeTransactionOutcomeUnknownError`) и ошибка после подтверждённого `COMMIT` (`CoreAuditPostCommitError`)**:
   - при обрыве на `COMMIT` выбрасывается `NativeTransactionOutcomeUnknownError`, `ROLLBACK` не отправляется, `coreEntityCacheService.invalidate('workspaceEntity', workspaceId)` всё равно вызывается, а зарегистрированный в этом вызове `customDomain` не удаляется в `catch`;
   - при ошибке после подтверждённого `COMMIT` выбрасывается `CoreAuditPostCommitError` без `ROLLBACK`, кэш `workspaceEntity` инвалидируется.
7. **Побочные эффекты при откате/коммите, пост-проверка записи, `PENDING_CREATION` и иммутабельность `auditIdentity`**:
   - при откате транзакции до `COMMIT` зарегистрированный `customDomain` компенсируется через `dnsManagerService.deleteHostnameSilently`, а `coreEntityCacheService.invalidate` не вызывается;
   - при совместной передаче `defaultRoleId` и `logo: null` поле `logoFileId` сбрасывается атомарно в транзакции, а `fileCorePictureService.deleteCorePicture` вызывается после `COMMIT`;
   - если `work(runner)` не записал ожидаемый `defaultRoleId`, транзакция откатывается на пост-проверке (`'Workspace default role update did not persist expected value'`);
   - на пространстве со статусом `PENDING_CREATION` вызов с `defaultRoleId` и `pendingActivationUser` сохраняет штатный `PermissionsException` из `validateWorkspaceUpdatePermissions`;
   - мутация объекта `auditIdentity` во время промежуточных `await` не меняет сохранённый `actor` в `crm_audit."crmAuditEntry"`.

## 2. Обновление существующих PostgreSQL-наборов

- `crm-audit-system-role-and-seeder.postgres-spec.ts` и `crm-audit-bulk-role-assignment.postgres-spec.ts`: подключение реального `WorkspaceEntity` репозитория к `WorkspaceManagerService` и `DevSeederPermissionsService` и проверка создаваемых записей `workspace:update` наряду с `role` и `roleTarget`.

## 3. Регрессионные и граничные проверки

- Целевые PostgreSQL-наборы ролей и `workspace.defaultRoleId`.
- Полная регрессия `ROB-765`.
- Дифференциальный typecheck (`typecheck-diff.cjs`), `check_enterprise_dependencies.py --verify-baseline`, `check_fork_migration_sources.py` и guard unit-тесты.
