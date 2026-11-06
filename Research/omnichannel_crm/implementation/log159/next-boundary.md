# Next boundary after LOG159 - audited system/default role creation and workspace defaultRoleId assignment

Read-only boundary analysis for the step following LOG159. No runtime or
acceptance claim is made here.

## What LOG111-LOG113 and LOG156-LOG159 closed across role, roleTarget, role permission, and API-key lifecycle

1. **Role `CREATE`, `UPDATE`, and `DELETE` (`LOG111`, `LOG112`, `LOG156`):**
   - Closed `RoleService.createAuditedRole`, `RoleService.updateRole`,
     `RoleService.deleteRole`, `RoleResolver.createOneRole` / `updateOneRole` /
     `deleteOneRole`, `CreateRoleTool`, `UpdateRoleTool`, and `DeleteRoleTool`.
2. **Single-target and bulk member, agent, and API-key role assignments (`LOG113`, `LOG156`, `LOG159`):**
   - Closed `UserRoleService.assignRoleToWorkspaceMember`,
     `UserRoleService.assignRoleToManyUserWorkspace`
     (`UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace`,
     `WorkspaceManagerService.setupDefaultRoles`,
     `DevSeederPermissionsService.initPermissions`),
     `AiAgentRoleService.assignRoleToAgent` / `removeRoleFromAgent`, and
     `ApiKeyRoleService.assignRoleToApiKey` with database-locked target/role/last-admin
     verification and atomic `roleTarget` (`delete`, `create`) audit entries.
3. **Role permission flag, object permission, field permission, and row-level permission predicate upserts (`LOG157`):**
   - Closed `RolePermissionFlagService.upsertPermissionFlags`,
     `ObjectPermissionService.upsertObjectPermissions`,
     `FieldPermissionService.upsertFieldPermissions`, and
     `RowLevelPermissionPredicateService.upsertRowLevelPermissionPredicates`.
4. **API-key creation, update, and revocation (`LOG158`):**
   - Closed `ApiKeyService.create`, `ApiKeyService.update`, and
     `ApiKeyService.revoke` across GraphQL, REST, and CLI with single-transaction
     `core."apiKey"` + `core."roleTarget"` creation and atomic `apiKey` /
     `roleTarget` CRM audit entries.

## Next open boundary (`rob765-progress.md` - system/bootstrap role creation in `RoleService`)

In `RoleService` (`packages/twenty-server/src/engine/metadata-modules/role/role.service.ts:184-200, 541-675`)
and `WorkspaceManagerService` (`packages/twenty-server/src/engine/workspace-manager/workspace-manager.service.ts:85-138`):

1. `RoleService.createMemberRole`, `RoleService.createGuestRole`, and
   `RoleService.createRole` call `createRoleFromFlat` without `withRoleCreateAudit`,
   and `RoleService.createWorkspaceCustomApplicationFlatRole` runs a `role`
   `create` migration (`isEditable: false`, `isSystemBuild: true`) without a
   `role` (`create`) CRM audit entry.
