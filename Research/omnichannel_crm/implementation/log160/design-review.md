# LOG160 — независимое критическое ревью дизайна и плана тестирования

## Вердикт

Дизайн (`design.md`) и план проверок (`test-research.md`) для `LOG160` («Audited system and bootstrap role creation, permission upserts, and roleTarget bindings in RoleService, WorkspaceManagerService, DevSeederPermissionsService, and RoleTargetService») архитектурно согласованы с закрытыми в `LOG111`–`LOG113` и `LOG156`–`LOG159` контурами транзакционного CRM-аудита и **одобрены к реализации** при обязательном учёте замечания по значению константы `WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER` и инвариантов ниже.

---

## 1. Проверка строгой изоляции `expected.isEditable === false` в `withRoleCreateAudit`

### Статус проверки: ПОДТВЕРЖДЕНО (с важным уточнением литерала константы)

1. **Условие допуска `isEditable === false`**:
   - В `packages/twenty-server/src/engine/core-modules/crm-audit/role-update-audit.ts` (`withRoleCreateAudit`, строки `200-251`) в текущей реализации жестко проверяется `expected.isEditable !== true`.
   - По дизайну `LOG160` до проверки скалярных полей `expected` синхронно выполняется `const capturedIdentity = captureRoleAuditIdentity(identity)`.
   - Значение `expected.isEditable === false` допускается **только** при одновременном выполнении двух условий:
     - `capturedIdentity.auth.type === 'system'`;
     - `expected.universalIdentifier === WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER.toLowerCase()`.
   - Во всех остальных случаях (`auth.type` равен `'user'`, `'apiKey'`, `'application'`, `'pendingActivationUser'`, либо `auth.type === 'system'`, но `expected.universalIdentifier` равен любому другому UUID, включая `MEMBER_ROLE_UNIVERSAL_IDENTIFIER` или произвольную роль) обязательно требуется `expected.isEditable === true`, иначе выбрасывается `'Role create audit requires normalized scalar fields'`.
   - Для защиты от ненормализованных типов условие проверки должно гарантировать булев тип `expected.isEditable`:
     ```ts
     const isSystemWorkspaceCustomApplicationRole =
       capturedIdentity.auth.type === 'system' &&
       expected.universalIdentifier ===
         WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER.toLowerCase();
     const hasValidEditability =
       expected.isEditable === true ||
       (isSystemWorkspaceCustomApplicationRole && expected.isEditable === false);
     ```

2. **Критическое замечание к тексту `design.md` (строка 32)**:
   - В `design.md:32` в скобках после `WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER.toLowerCase()` ошибочно указан UUID `'20202020-df90-4820-9828-55b4238f8684'`.
   - В действительности в `packages/twenty-server/src/engine/core-modules/application/constants/workspace-custom-application-role.constant.ts:1-2` константа определена как:
     ```ts
     export const WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER =
       'b5b505e2-8834-457f-a301-f1f4694fe365';
     ```
   - **Требование к реализации**: в `role-update-audit.ts` необходимо импортировать `WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER` напрямую из `src/engine/core-modules/application/constants/workspace-custom-application-role.constant` (этот модуль не имеет импортов и не создаёт рёбер к Enterprise-коду), а не использовать строковый литерал из скобок в `design.md`.

---

## 2. Проверка синхронной валидации `auditIdentity` до первого `await` в `RoleService`

### Статус проверки: ПОДТВЕРЖДЕНО

1. **`RoleService.createRole`, `createMemberRole`, `createGuestRole`, `createAuditedRole` (`packages/twenty-server/src/engine/metadata-modules/role/role.service.ts:184-221, 541-570, 650-676`)**:
   - В `createRole` до построения `flatRoleToCreate` и до первого `await` синхронно выполняются:
     - проверка отсутствия конфликтующего аудит-контекста (`getRoleMutationAudit(workspaceId)` и `hasConflictingMetadataAuditScope(workspaceId, getRoleMutationAudit)`);
     - `const capturedIdentity = captureRoleAuditIdentity(auditIdentity as RoleUpdateAuditIdentity);`
     - `captureRoleAuditOperation(workspaceId, capturedIdentity);`
   - После этого синхронно формируется `flatRoleToCreate = fromCreateRoleInputToFlatRoleToCreate(...)` и вызывается `withRoleCreateAudit(flatRoleToCreate, capturedIdentity, () => this.createRoleFromFlat(flatRoleToCreate))`.
   - `createMemberRole` и `createGuestRole` синхронно без промежуточных `await` делегируют в `this.createRole({ ..., auditIdentity })`.
   - `createAuditedRole` делегирует в `this.createRole({ input, workspaceId, ownerFlatApplication, auditIdentity })`, сохраняя контракт для `RoleResolver.createOneRole` и `CreateRoleTool`.

2. **`RoleService.createWorkspaceCustomApplicationRole` (`role.service.ts:572-648`)**:
   - В исходном коде первым действием метода является `await this.flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(...)`, и если роль с `WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER` уже существует в кэше, `createWorkspaceCustomApplicationFlatRole` не вызывается.
   - Дизайн корректно требует валидировать `auditIdentity` **синхронно в начале `createWorkspaceCustomApplicationRole` до первого `await`** (до обращения к `flatEntityMapsCacheService`):
     - проверить отсутствие активного/конфликтующего аудит-контекста (`if (getRoleMutationAudit(workspaceId) || hasConflictingMetadataAuditScope(workspaceId, getRoleMutationAudit)) throw new Error('Nested role audit is unsupported')`);
     - захватить `const capturedIdentity = captureRoleAuditIdentity(auditIdentity as RoleUpdateAuditIdentity)` и проверить `captureRoleAuditOperation(workspaceId, capturedIdentity)`;
     - передать `capturedIdentity` в `createWorkspaceCustomApplicationFlatRole`, где `validateBuildAndRunWorkspaceMigration` оборачивается в `withRoleCreateAudit(flatRoleToCreate, capturedIdentity, ...)`.
   - Благодаря этому даже на идемпотентной ветке (когда роль уже создана) вызов без `auditIdentity`, с чужим `workspace.id`, с `pendingActivationUser` или без `systemActorId` для системного контекста гарантированно отклоняется до чтения кэша и БД.

---

## 3. Проверка разрешения `applicationUniversalIdentifier` в `RoleTargetService.createMany`

### Статус проверки: ПОДТВЕРЖДЕНО

1. **Анализ проблемы в текущем коде (`packages/twenty-server/src/engine/metadata-modules/role-target/services/role-target.service.ts:76-110`)**:
   - В цикле по `createRoleTargetInputs` (строки `76-93`) при наличии `createRoleTargetInput.applicationId` выбирается `flatApplication = flatApplicationMaps.byId[createRoleTargetInput.applicationId]`, и создаваемый `flatRoleTargetToCreate` получает `applicationId` и `applicationUniversalIdentifier` этого приложения (например, `twentyStandardFlatApplication` при вызове из `DevSeederPermissionsService.initPermissions` на строке `74`).
   - Однако в `validateBuildAndRunWorkspaceMigration` (строки `107-108`) безусловно передавался `workspaceCustomFlatApplication.universalIdentifier`.
   - При включении `withApiKeyRoleAssignmentAudit` вокруг `this.roleTargetService.create` в `DevSeederPermissionsService.initPermissions` `WorkspaceMigrationRunnerService` (`workspace-migration-runner.service.ts:363-376, 404`) разрешал бы `mappings.application` как `workspaceCustomFlatApplication`, после чего `runAuditedRoleAssignment` (`role-assignment-audit.ts:852-857`) выбросил бы `'Role assignment final plan points to a different target'` из-за несовпадения `input.applicationUniversalIdentifier` (`twentyStandardFlatApplication.universalIdentifier`) и `mappings.application.universalIdentifier` (`workspaceCustomFlatApplication.universalIdentifier`).

2. **Корректность предложенного решения**:
   - Вычисление `migrationApplicationUniversalIdentifier` в `RoleTargetService.createMany`:
     ```ts
     const uniqueApplicationUniversalIdentifiers = [
       ...new Set(
         allFlatRoleTargetsToCreate.map(
           ({ applicationUniversalIdentifier }) =>
             applicationUniversalIdentifier,
         ),
       ),
     ];
     const migrationApplicationUniversalIdentifier =
       uniqueApplicationUniversalIdentifiers.length === 1
         ? uniqueApplicationUniversalIdentifiers[0]
         : workspaceCustomFlatApplication.universalIdentifier;
     ```
   - Когда все создаваемые `roleTarget` имеют один и тот же `applicationUniversalIdentifier` (включая `twentyStandardFlatApplication` в `DevSeederPermissionsService` и `workspaceCustomFlatApplication` во всех остальных путях), в `validateBuildAndRunWorkspaceMigration` передаётся именно он.
   - В результате `WorkspaceMigrationRunnerService` загружает целевое приложение, а `runAuditedRoleAssignment` блокирует его строку в `core.application` (`FOR SHARE`), сверяет `applicationId` и `applicationUniversalIdentifier` до и после `audit.flush()` и атомарно записывает событие `roleTarget` (`create`).

---

## 4. Проверка неизменности и чистоты `typecheck` для `upgrade-version-command/2-50/2-50-workspace-command-1792413669590-backfill-member-role-universal-identifier.command.ts`

### Статус проверки: ПОДТВЕРЖДЕНО

1. В `packages/twenty-server/src/database/commands/upgrade-version-command/2-50/2-50-workspace-command-1792413669590-backfill-member-role-universal-identifier.command.ts:95-99` вызывается:
   ```ts
   await this.roleService.createMemberRole({
     workspaceId,
     ownerFlatApplication: workspaceCustomFlatApplication,
     label: memberRoleLabel,
   });
   ```
2. Поскольку в `RoleService.createMemberRole` (а также `createRole`, `createGuestRole`, `createWorkspaceCustomApplicationRole`) параметр `auditIdentity?: RoleUpdateAuditIdentity` объявляется **опциональным в сигнатуре TypeScript** (при обязательной runtime-проверке внутри метода, аналогично `UserRoleService.assignRoleToManyUserWorkspace` в `LOG159` и `RolePermissionFlagService.upsertPermissionFlags` в `LOG157`):
   - Файл `2-50-workspace-command-1792413669590-backfill-member-role-universal-identifier.command.ts` остаётся полностью нетронутым (соблюдается правило `CLAUDE.md`: не модифицировать закоммиченные команды в `upgrade-version-command/`).
   - Проверка типов (`tsgo` / `typecheck-diff.cjs`) проходит без ошибок.
3. Аналогично, команда `2-51-workspace-command-1792755720300-backfill-workspace-custom-application-default-role.command.ts` вызывает собственный приватный метод `this.createWorkspaceCustomApplicationRole` и не затрагивается изменениями в `RoleService`.

---

## 5. Проверка границ Enterprise-зависимостей и плана тестирования (`test-research.md`)

1. **Границы Enterprise-зависимостей (`check_enterprise_dependencies.py`)**:
   - Все изменяемые файлы (`role-update-audit.ts`, `role.service.ts`, `role-target.service.ts`, `workspace-manager.service.ts`, `dev-seeder-permissions.service.ts`) находятся в открытом runtime-контуре `packages/twenty-server/src/engine/`.
   - Импорт `WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER` из `src/engine/core-modules/application/constants/workspace-custom-application-role.constant` и `withApiKeyRoleAssignmentAudit` из `src/engine/core-modules/crm-audit/role-assignment-audit` не создаёт зависимостей на `@license Enterprise` модули.
2. **Полнота тестового плана (`test-research.md`)**:
   - План покрывает все 8 ключевых сценариев в новом наборе `packages/twenty-server/test/fork-migration/crm-audit-system-role-and-seeder.postgres-spec.ts` и обновление существующего теста в `packages/twenty-server/test/fork-migration/crm-audit-role-update.postgres-spec.ts:985`.
   - Дополнительно рекомендуется при реализации тестов в `crm-audit-system-role-and-seeder.postgres-spec.ts` явно проверить:
     - отказ `createWorkspaceCustomApplicationRole` при вызове внутри уже активного аудит-контекста (`Nested role audit is unsupported`) даже когда роль кастомного приложения уже существует;
     - идемпотентный повторный вызов `WorkspaceManagerService.setupDefaultRoles`, когда `existingMemberRole` уже существует в `core.role` (создаётся только `roleTarget` для администратора, без повторного создания роли `Member`).
