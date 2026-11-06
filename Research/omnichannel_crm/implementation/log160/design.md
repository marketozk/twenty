# LOG160 — дизайн аудита системного и bootstrap-создания ролей, прав и привязок `roleTarget`

## 1. Контекст и постановка задачи

После `LOG111`–`LOG113` и `LOG156`–`LOG159`:
- Публичное и AI-создание, обновление и удаление ролей (`RoleService.createAuditedRole`, `RoleService.updateRole`, `RoleService.deleteRole`) закрыты транзакционным контекстом `withRoleCreateAudit` / `withRoleUpdateAudit` / `withRoleDeleteAudit`.
- Одиночные и пакетные назначения ролей участникам (`UserRoleService.assignRoleToWorkspaceMember`, `UserRoleService.assignRoleToManyUserWorkspace`), агентам (`AiAgentRoleService`) и API-ключам (`ApiKeyRoleService`, `ApiKeyService.create`) закрыты `withRoleAssignmentAudit`, `withBulkUserRoleAssignmentAudit`, `withAgentRoleAssignmentAudit`, `withAgentRoleRemovalAudit`, `withApiKeyRoleAssignmentAudit` и `withApiKeyCreateAudit`.
- Upsert флагов прав, объектных прав, полевых прав и предикатов строкового доступа (`RolePermissionFlagService`, `ObjectPermissionService`, `FieldPermissionService`, `RowLevelPermissionPredicateService`) закрыты `role-permission-audit.ts` (`LOG157`).

Открытыми в `RoleService`, `WorkspaceManagerService`, `DevSeederPermissionsService` и `RoleTargetService` оставались системные и bootstrap-пути создания ролей и привязки `roleTarget`:
1. `RoleService.createRole`, `RoleService.createMemberRole` и `RoleService.createGuestRole` (`packages/twenty-server/src/engine/metadata-modules/role/role.service.ts:184-200, 541-570, 650-676`) вызывали `createRoleFromFlat` без `withRoleCreateAudit`.
2. `RoleService.createWorkspaceCustomApplicationRole` и `createWorkspaceCustomApplicationFlatRole` (`role.service.ts:572-648`) создавали системную не-редактируемую роль приложения (`isEditable: false`, `universalIdentifier: WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER`) через `validateBuildAndRunWorkspaceMigration` без `withRoleCreateAudit`. При этом `withRoleCreateAudit` (`role-update-audit.ts:229`) отвергал `isEditable: false`.
3. В `WorkspaceManagerService` (`packages/twenty-server/src/engine/workspace-manager/workspace-manager.service.ts:85, 138`) вызовы `createWorkspaceCustomApplicationRole` и `createMemberRole` не передавали `auditIdentity`.
4. В `DevSeederPermissionsService` (`packages/twenty-server/src/engine/workspace-manager/dev-seeder/core/services/dev-seeder-permissions.service.ts`):
   - строка `74`: прямой вызов `this.roleTargetService.create` для `API_KEY_DATA_SEED_IDS.ID_1` (с `applicationId: twentyStandardFlatApplication.id`) выполнялся без `withApiKeyRoleAssignmentAudit`;
   - строки `109, 227, 232, 258, 293`: вызовы `createGuestRole`, `createWorkspaceCustomApplicationRole`, `createMemberRole` и `createRole` выполнялись без `auditIdentity`;
   - строки `275, 337, 390`: вызовы `upsertPermissionFlags`, `upsertObjectPermissions` и `upsertFieldPermissions` не передавали `auditIdentity` (обязательный после `LOG157`).
5. В `RoleTargetService.createMany` (`packages/twenty-server/src/engine/metadata-modules/role-target/services/role-target.service.ts:107-109`) при явной передаче `createRoleTargetInput.applicationId` (например, `twentyStandardFlatApplication.id` в `DevSeederPermissionsService`) сущность `flatRoleTargetToCreate` получала `applicationUniversalIdentifier` указанного приложения, но в `validateBuildAndRunWorkspaceMigration` всегда передавался `workspaceCustomFlatApplication.universalIdentifier`, что приводило бы к расхождению `applicationUniversalIdentifier` при проверке в `runAuditedRoleAssignment`.

Цель `LOG160` — перевести все указанные пути на закрытый транзакционный аудит `core.role` / `core."roleTarget"` / прав ролей в единой транзакции с `crm_audit."crmAuditEntry"`.

---

## 2. Рассмотренные варианты архитектуры

### Вариант A (рекомендуемый): закрытие `RoleService.createRole` / `createMemberRole` / `createGuestRole` / `createWorkspaceCustomApplicationRole` через `withRoleCreateAudit` с поддержкой системной роли приложения и согласованием `applicationUniversalIdentifier` в `RoleTargetService.createMany`

1. **`role-update-audit.ts` (`withRoleCreateAudit`)**:
   - Синхронно валидировать `const capturedIdentity = captureRoleAuditIdentity(identity)` до проверки полей `flatRole`.
   - Разрешить `expected.isEditable === false` **только** при одновременном выполнении двух условий:
     - `capturedIdentity.auth.type === 'system'`;
     - `expected.universalIdentifier === WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER.toLowerCase()` (`'b5b505e2-8834-457f-a301-f1f4694fe365'`).
   - Для всех остальных вызовов (`user`, `apiKey`, `application`, `agent`, а также системных ролей с любым другим `universalIdentifier`) по-прежнему требовать `expected.isEditable === true`.
2. **`RoleService` (`role.service.ts`)**:
   - В `createRole`: добавить параметр `auditIdentity?: RoleUpdateAuditIdentity`, синхронно захватывать `capturedIdentity = captureRoleAuditIdentity(auditIdentity as RoleUpdateAuditIdentity)` и `captureRoleAuditOperation(workspaceId, capturedIdentity)` до построения `flatRoleToCreate` и делегировать выполнение в `withRoleCreateAudit(flatRoleToCreate, capturedIdentity, () => this.createRoleFromFlat(flatRoleToCreate))`.
   - В `createAuditedRole`: делегировать в `this.createRole({ input, workspaceId, ownerFlatApplication, auditIdentity })` (сохраняя обратную совместимость для `RoleResolver` и `CreateRoleTool`).
   - В `createMemberRole` и `createGuestRole`: добавить `auditIdentity?: RoleUpdateAuditIdentity` и пробрасывать его в `this.createRole`.
   - В `createWorkspaceCustomApplicationRole`: добавить `auditIdentity?: RoleUpdateAuditIdentity`, синхронно до первого `await` (до чтения `flatRoleMaps` и проверки `existingFlatRole`) валидировать `capturedIdentity = captureRoleAuditIdentity(auditIdentity as RoleUpdateAuditIdentity)` и `captureRoleAuditOperation(workspaceId, capturedIdentity)`, и передавать `capturedIdentity` в `createWorkspaceCustomApplicationFlatRole`.
   - В `createWorkspaceCustomApplicationFlatRole`: обернуть `validateBuildAndRunWorkspaceMigration` в `withRoleCreateAudit(flatRoleToCreate, auditIdentity, ...)`.
3. **`RoleTargetService.createMany` (`role-target.service.ts`)**:
   - Вычислять `migrationApplicationUniversalIdentifier`: если все элементы `allFlatRoleTargetsToCreate` имеют один и тот же `applicationUniversalIdentifier`, передавать его в `validateBuildAndRunWorkspaceMigration`, иначе — `workspaceCustomFlatApplication.universalIdentifier`. Это гарантирует, что при создании `roleTarget` с явным `applicationId` (как `twentyStandardFlatApplication.id` в `DevSeederPermissionsService`) `WorkspaceMigrationRunnerService` загружает именно это приложение и проверка `verifyRoleAuditApplication` / `applicationUniversalIdentifier` в `runAuditedRoleAssignment` проходит консистентно.
4. **Точки вызова в `WorkspaceManagerService` и `DevSeederPermissionsService`**:
   - В `WorkspaceManagerService.init` (`workspace-manager.service.ts:85`): передавать `auditIdentity: { auth: { workspace: { id: workspaceId }, type: 'system' }, systemActorId: 'workspace-manager:init' }`.
   - В `WorkspaceManagerService.setupDefaultRoles` (`workspace-manager.service.ts:138`): передавать `auditIdentity: { auth: { workspace: { id: workspaceId }, type: 'system' }, systemActorId: 'workspace-manager:setup-default-roles' }`.
   - В `DevSeederPermissionsService.initPermissions` (`dev-seeder-permissions.service.ts:74, 109`): обернуть создание `roleTarget` для `API_KEY_DATA_SEED_IDS.ID_1` в `withApiKeyRoleAssignmentAudit` с `systemActorId: 'dev-seeder:init-permissions'` и передавать тот же `auditIdentity` в `createGuestRole`, `createImpersonateOnlyRoleForSeedWorkspace` (`createRole`, `upsertPermissionFlags`) и `createLimitedRoleForSeedWorkspace` (`createRole`, `upsertObjectPermissions`, `upsertFieldPermissions`).
   - В `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace` (`dev-seeder-permissions.service.ts:227, 232`): передавать `auditIdentity` с `systemActorId: 'dev-seeder:init-minimal-permissions'` в `createWorkspaceCustomApplicationRole` и `createMemberRole`.

- **Плюсы**:
  - Все методы создания ролей в `RoleService` (`createRole`, `createAuditedRole`, `createMemberRole`, `createGuestRole`, `createWorkspaceCustomApplicationRole`) становятся fail-closed и требуют валидный `auditIdentity` до первого `await`.
  - Сохраняется строгий запрет на создание не-редактируемых ролей (`isEditable: false`) для любых не-системных субъектов.
  - Ни один файл в `upgrade-version-command/` не модифицируется (параметр `auditIdentity?: RoleUpdateAuditIdentity` опционален на уровне типа TypeScript, но обязателен в runtime).
  - Нулевой риск нарушения границ Enterprise-зависимостей.

### Вариант B: отдельный контекст `withSystemRoleCreateAudit`

- **Описание**: завести параллельный `AsyncLocalStorage`-контекст для `createWorkspaceCustomApplicationFlatRole` и `createMemberRole`.
- **Минусы**: дублирует `withRoleCreateAudit` и `runAuditedRoleMutation` (`action === 'create'`), которые уже проверяют `core.application`, отсутствие коллизии `id`, все 10 булевых флагов, текстовые поля и микросекундные `createdAt`/`updatedAt`.
- **Вердикт**: отклонён.

---

## 3. Инварианты безопасности и транзакционной целостности

1. **Fail-closed валидация `auditIdentity` до первого `await`**:
   - В `createRole`, `createMemberRole`, `createGuestRole` и `createWorkspaceCustomApplicationRole` проверка `captureRoleAuditIdentity` + `captureRoleAuditOperation` и проверка отсутствия конфликтующих аудит-контекстов выполняются синхронно до любых обращений к кэшу или БД (в том числе в `createWorkspaceCustomApplicationRole`, даже если роль уже существует и метод завершается по идемпотентной ветке).
2. **Инвариант `isEditable: false` в `withRoleCreateAudit`**:
   - `expected.isEditable === true` обязателен всегда, кроме `capturedIdentity.auth.type === 'system' && expected.universalIdentifier === WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER.toLowerCase()`.
   - Попытка передать `isEditable: false` с `auth.type === 'user'` / `'apiKey'` / `'application'` или с другим `universalIdentifier` немедленно отвергается с ошибкой `'Role create audit requires normalized scalar fields'`.
3. **Согласованность `applicationId` и `applicationUniversalIdentifier` в `RoleTargetService.createMany`**:
   - При создании `roleTarget` с явным `applicationId` (`twentyStandardFlatApplication.id`) миграция запускается с `applicationUniversalIdentifier` этого приложения, а `runAuditedRoleAssignment` блокирует `core.application` (`FOR SHARE`), сверяет `applicationId` и `applicationUniversalIdentifier` и записывает событие `roleTarget` (`create`) в одной транзакции с `INSERT INTO core."roleTarget"`.

---

## 4. Затронутые файлы

1. `packages/twenty-server/src/engine/core-modules/crm-audit/role-update-audit.ts`
2. `packages/twenty-server/src/engine/metadata-modules/role/role.service.ts`
3. `packages/twenty-server/src/engine/metadata-modules/role-target/services/role-target.service.ts`
4. `packages/twenty-server/src/engine/workspace-manager/workspace-manager.service.ts`
5. `packages/twenty-server/src/engine/workspace-manager/dev-seeder/core/services/dev-seeder-permissions.service.ts`
6. `packages/twenty-server/test/fork-migration/crm-audit-role-update.postgres-spec.ts`
7. `packages/twenty-server/test/fork-migration/crm-audit-system-role-and-seeder.postgres-spec.ts` (новый интеграционный PostgreSQL-набор)
