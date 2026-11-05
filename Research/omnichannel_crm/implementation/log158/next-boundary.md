# Next boundary after LOG158 - audited bulk and initial member role assignments (`assignRoleToManyUserWorkspace`)

Read-only boundary analysis for the step following LOG158. No runtime or
acceptance claim is made here.

## What LOG111-LOG113 and LOG156-LOG158 closed across role, roleTarget, role permission, and API-key lifecycle

1. **Role `CREATE`, `UPDATE`, and `DELETE` (`LOG111`, `LOG112`, `LOG156`):**
   - Closed `RoleService.createAuditedRole`, `RoleService.updateRole`,
     `RoleService.deleteRole`, `RoleResolver.createOneRole` / `updateOneRole` /
     `deleteOneRole`, `CreateRoleTool`, `UpdateRoleTool`, and `DeleteRoleTool`
     with atomic `role` (`create`, `update`, `delete`) and `roleTarget`
     (`delete`, `create`) CRM audit entries and database-locked `core.workspace`,
     `core.application`, `core.role`, `core."roleTarget"`, `core."userWorkspace"`,
     `core."apiKey"`, and `core.agent` verification.
2. **Single-target member, agent, and API-key role assignments (`LOG113`, `LOG156`):**
   - Closed `UserRoleService.assignRoleToWorkspaceMember`,
     `AiAgentRoleService.assignRoleToAgent` / `removeRoleFromAgent`, and
     `ApiKeyRoleService.assignRoleToApiKey` with database-locked target/role
     verification and atomic `roleTarget` (`delete`, `create`) audit entries.
3. **Role permission flag, object permission, field permission, and row-level permission predicate upserts (`LOG157`):**
   - Closed `RolePermissionFlagService.upsertPermissionFlags`,
     `ObjectPermissionService.upsertObjectPermissions`
     (`UpsertObjectPermissionsTool`),
     `FieldPermissionService.upsertFieldPermissions`, and
     `RowLevelPermissionPredicateService.upsertRowLevelPermissionPredicates`
     (`UpsertRowLevelPermissionRulesTool`) with database-locked role,
     application, flag, object, field, group, self-lockout, read/write
     consistency, and `ON DELETE CASCADE` verification and atomic
     `rolePermissionFlag`, `objectPermission`, `fieldPermission`,
     `rowLevelPermissionPredicateGroup`, and `rowLevelPermissionPredicate`
     audit entries before `COMMIT`.
4. **API-key creation, update, and revocation (`LOG158`):**
   - Closed `ApiKeyService.create` (`ApiKeyResolver.createApiKey`,
     `ApiKeyController.create`, `GenerateApiKeyCommand`), `ApiKeyService.update`
     (`ApiKeyResolver.updateApiKey`, `ApiKeyController.update`), and
     `ApiKeyService.revoke` (`ApiKeyResolver.revokeApiKey`,
     `ApiKeyController.remove`) with single-transaction `core."apiKey"` +
     `core."roleTarget"` creation, database-locked reactivation refusal, and
     atomic `apiKey` (`create`, `update`) and `roleTarget` (`create`) CRM audit
     entries before `COMMIT`.

## Next open boundary (`rob765-progress.md` - bulk and initial member role assignments)

In `UserRoleService.assignRoleToManyUserWorkspace`
(`packages/twenty-server/src/engine/metadata-modules/user-role/user-role.service.ts:120-161`)
and its direct callers outside `assignRoleToWorkspaceMember`:

1. `UserWorkspaceService.addUserToWorkspace`
   (`packages/twenty-server/src/engine/core-modules/user-workspace/user-workspace.service.ts:270-317`)
   and `WorkspaceManagerService.setupDefaultRoles`
   (`packages/twenty-server/src/engine/workspace-manager/workspace-manager.service.ts:97-138`)
   call `UserRoleService.assignRoleToManyUserWorkspace` directly without an
   active `roleTarget` audit scope.
2. `UserRoleService.assignRoleToManyUserWorkspace` accepts an arbitrary array of
   `userWorkspaceIds` and calls `RoleTargetService.createMany`, whereas
   `withRoleAssignmentAudit` currently handles only a single `userWorkspaceId`
   through `assignRoleToWorkspaceMember`.
