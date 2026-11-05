# Next boundary after LOG157 - audited API-key creation, update, and revocation with atomic roleTarget binding

Read-only boundary analysis for the step following LOG157. No runtime or
acceptance claim is made here.

## What LOG111-LOG113, LOG156, and LOG157 closed across role, roleTarget, and role permission lifecycle

1. **Role `CREATE`, `UPDATE`, and `DELETE` (`LOG111`, `LOG112`, `LOG156`):**
   - Closed `RoleService.createAuditedRole`, `RoleService.updateRole`,
     `RoleService.deleteRole`, `RoleResolver.createOneRole` / `updateOneRole` /
     `deleteOneRole`, `CreateRoleTool`, `UpdateRoleTool`, and `DeleteRoleTool`
     with atomic `role` (`create`, `update`, `delete`) and `roleTarget`
     (`delete`, `create`) CRM audit entries and database-locked `core.workspace`,
     `core.application`, `core.role`, `core."roleTarget"`, `core."userWorkspace"`,
     `core."apiKey"`, and `core.agent` verification.
2. **Member, agent, and API-key role assignments (`LOG113`, `LOG156`):**
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

## Next open boundary (`rob765-progress.md` - API-key lifecycle and atomic roleTarget binding)

In `ApiKeyResolver` (`packages/twenty-server/src/engine/core-modules/api-key/api-key.resolver.ts:109-181`)
and `ApiKeyService` (`packages/twenty-server/src/engine/core-modules/api-key/services/api-key.service.ts:34-123`):

1. `ApiKeyService.create` (`ApiKeyResolver.createApiKey`) inserts `core."apiKey"`
   and calls `RoleTargetService.create` (`targetMetadataForeignKey: 'apiKeyId'`)
   in two separate transactions (relying on a non-atomic compensating
   `apiKeyRepository.delete` on failure) without atomic `apiKey` (`create`) +
   `roleTarget` (`create`) CRM audit entries or database-locked
   `role.canBeAssignedToApiKeys` verification.
2. `ApiKeyService.update` (`ApiKeyResolver.updateApiKey`) and
   `ApiKeyService.revoke` (`ApiKeyResolver.revokeApiKey`) mutate `core."apiKey"`
   (`name`, `expiresAt`, `revokedAt`) without atomic `apiKey` (`update`) CRM
   audit coverage or database-locked reactivation/revocation verification.
