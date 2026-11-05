# Next boundary after LOG156 - audited role permission flag, object permission, field permission, and row-level permission predicate upserts

Read-only boundary analysis for the step following LOG156. No runtime or
acceptance claim is made here.

## What LOG111-LOG113 and LOG156 closed across role and roleTarget lifecycle

1. **Role `CREATE` and `UPDATE` (`LOG111`, `LOG112`):**
   - Closed `RoleService.createAuditedRole`, `RoleService.updateRole`,
     `RoleResolver.createOneRole` / `updateOneRole`, `CreateRoleTool`, and
     `UpdateRoleTool` with atomic `role` (`create`, `update`) CRM audit entries
     and database-locked `core.role` and `core.application` verification.
2. **Public member role assignment (`LOG113`):**
   - Closed `UserRoleService.assignRoleToWorkspaceMember`,
     `RoleResolver.updateWorkspaceMemberRole`, and
     `AssignRoleToWorkspaceMemberTool` with `core.workspace` `FOR NO KEY UPDATE`
     serialization, last-admin demotion protection, and atomic `roleTarget`
     (`delete`, `create`) audit entries.
3. **Role `DELETE` and agent/API-key role assignment and removal (`LOG156`):**
   - Closed `RoleService.deleteRole`, `RoleResolver.deleteOneRole`, and
     `DeleteRoleTool` (`withRoleDeleteAudit`, `runAuditedRoleMutation` with
     `action === 'delete'`), locking `core.workspace`, `core.application`,
     `core.role`, `core."roleTarget"`, `core."userWorkspace"`, `core."apiKey"`,
     and `core.agent`, verifying active target rebinds to `defaultRoleId` and
     caller lockout under DB locks, and recording atomic `roleTarget`
     (`delete`, `create`) and `role` (`delete`) audit entries.
   - Closed `AiAgentRoleService.assignRoleToAgent` / `removeRoleFromAgent`
     (`RoleResolver.assignRoleToAgent` / `removeRoleFromAgent`) and
     `ApiKeyRoleService.assignRoleToApiKey` (`ApiKeyResolver.assignRoleToApiKey`)
     with database-locked target/role verification and atomic `roleTarget`
     (`delete`, `create`) audit entries (`{ roleId, agentId }` and
     `{ roleId, apiKeyId }`).

## Next open boundary (`rob765-progress.md` - Role permission upserts)

In `RoleResolver` (`packages/twenty-server/src/engine/metadata-modules/role/role.resolver.ts:306-429`)
and `RoleToolsModule` (`packages/twenty-server/src/engine/metadata-modules/role/tools/`):

1. `RolePermissionFlagService.upsertPermissionFlags` (`upsertPermissionFlags`)
2. `ObjectPermissionService.upsertObjectPermissions` (`upsertObjectPermissions`,
   `UpsertObjectPermissionsTool`)
3. `FieldPermissionService.upsertFieldPermissions` (`upsertFieldPermissions`)
4. `RowLevelPermissionPredicateService.upsertRowLevelPermissionPredicates`
   (`upsertRowLevelPermissionPredicates`, `UpsertRowLevelPermissionRulesTool`)

currently execute workspace migrations for `rolePermissionFlag`,
`objectPermission`, `fieldPermission`, `rowLevelPermissionPredicate`, and
`rowLevelPermissionPredicateGroup` without atomic CRM audit coverage or
database-locked role/self-lockout verification.
