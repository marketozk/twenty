# LOG160 — план тестирования и исследовательская матрица проверок

## 1. Целевые сценарии в `crm-audit-system-role-and-seeder.postgres-spec.ts`

1. **Системное создание `Member`-роли (`RoleService.createMemberRole`) и `Guest`-роли (`RoleService.createGuestRole`)**:
   - Проверка создания строки в `core.role` (`isEditable: true`, `universalIdentifier === MEMBER_ROLE_UNIVERSAL_IDENTIFIER` для `Member`) и атомарной записи `crm_audit."crmAuditEntry"` (`resourceKind: 'role'`, `action: 'create'`, `actor: { kind: 'system', id: 'workspace-manager:setup-default-roles' }` / `'dev-seeder:init-permissions'`, `redactedDiff.values` со всеми 10 булевыми флагами и хэшами `label`, `description`, `icon`).
2. **Системное создание не-редактируемой роли приложения (`RoleService.createWorkspaceCustomApplicationRole`)**:
   - Когда роль ещё не существует: создаёт строку в `core.role` с `isEditable: false`, `universalIdentifier === WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER`, записывает событие `role` (`create`) в `crm_audit."crmAuditEntry"` с `actor: { kind: 'system', id: 'workspace-manager:init' }` и вызывает `applicationService.update` с `defaultRoleId`.
   - Идемпотентный повторный вызов (когда роль уже существует в `flatRoleMaps`): не создаёт дубликат роли и не пишет лишнюю запись аудита, но при отсутствии или невалидности `auditIdentity` отвергает вызов до чтения `flatRoleMaps`.
3. **Запрет создания роли с `isEditable: false` для не-системного субъекта или чужого `universalIdentifier`**:
   - Вызов `withRoleCreateAudit` с `isEditable: false` и `auth.type === 'user'` отвергается с `'Role create audit requires normalized scalar fields'`.
   - Вызов `withRoleCreateAudit` с `isEditable: false`, `auth.type === 'system'`, но `universalIdentifier !== WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER` отвергается с `'Role create audit requires normalized scalar fields'`.
4. **Обязательность `auditIdentity` во всех методах создания ролей `RoleService`**:
   - Вызовы `createRole`, `createMemberRole`, `createGuestRole` и `createWorkspaceCustomApplicationRole` без `auditIdentity`, с чужим `workspace.id`, с `pendingActivationUser` или с `type: 'system'` без `systemActorId` отвергаются до запуска миграции; `crm_audit."crmAuditEntry"` остаётся пустой.
5. **Сквозной прогон `WorkspaceManagerService.init` / `setupDefaultRoles`**:
   - Вызов `createWorkspaceCustomApplicationRole` + `setupDefaultRoles` (`assignRoleToManyUserWorkspace` для администратора + `createMemberRole` для роли по умолчанию) создаёт системную роль приложения, привязку администратора и роль `Member` с тремя транзакционными записями в `crm_audit."crmAuditEntry"`.
6. **Привязка `roleTarget` к API-ключу с явным `applicationId` (`twentyStandardFlatApplication.id`) в `DevSeederPermissionsService`**:
   - Вызов `withApiKeyRoleAssignmentAudit` вокруг `roleTargetService.create` с `applicationId: twentyStandardFlatApplication.id` проходит проверку `verifyRoleAuditApplication` для `twentyStandardFlatApplication`, создаёт `core."roleTarget"` с `applicationId === twentyStandardFlatApplication.id` и записывает событие `roleTarget` (`create`) с `actor: { kind: 'system', id: 'dev-seeder:init-permissions' }`.
7. **Сквозной прогон `DevSeederPermissionsService.initPermissions` (полный режим)**:
   - Проверяет атомарный аудит всех шагов `initPermissions`: привязка seed API-ключа к `Admin`, создание `Guest`-роли и назначение гостю, создание `Object-restricted` роли с `upsertObjectPermissions` и `upsertFieldPermissions` и назначение участнику, создание `Impersonate-only` роли с `upsertPermissionFlags` и назначение участнику, назначение `Admin`, создание роли кастомного приложения и `Member`-роли (`initMinimalPermissionsAndActivateWorkspace`) и пакетное назначение `Member`-роли остальным участникам.
8. **Откат транзакции при сбое обработчика или дрейфе полей в системном создании роли**:
   - При ошибке внутри `CreateRoleActionHandlerService` или несовпадении скалярных полей/меток времени откатываются и `core.role`, и `crm_audit."crmAuditEntry"`.

## 2. Обновление существующего набора `crm-audit-role-update.postgres-spec.ts`

- Тест `keeps internal bootstrap creation without falsely attributing a user` (строка `985`) обновляется: проверяет, что вызов `service.createRole` без `auditIdentity` отклоняется (`Role mutation requires authenticated audit identity`), а с системным `auditIdentity` (`systemActorId: 'dev-seeder:init-permissions'`) создаёт роль и записывает атомарный аудит с `actor: { kind: 'system', id: 'dev-seeder:init-permissions' }`.

## 3. Регрессионные и граничные проверки

- Целевые PostgreSQL-наборы аудита ролей и метаданных (`8` наборов).
- Полная регрессия `jest-fork-migration.config.mjs` (`165` наборов).
- Дифференциальный typecheck (`typecheck-diff.cjs`), `check_enterprise_dependencies.py --verify-baseline`, `check_fork_migration_sources.py` и `26` guard unit-тестов (`33` на Linux).
