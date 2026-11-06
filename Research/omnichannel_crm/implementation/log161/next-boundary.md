# Next boundary after LOG161 - agent metadata roleTarget mutations in AgentService and remaining core/native writers

Read-only boundary analysis for the step following LOG161. No runtime or
acceptance claim is made here.

## What LOG111-LOG113 and LOG156-LOG161 closed across role, roleTarget, role permission, and API-key lifecycle

1. **Role `CREATE`, `UPDATE`, and `DELETE` across public, AI tool, system/bootstrap, and workflow agent-step cleanup paths (`LOG111`, `LOG112`, `LOG156`, `LOG160`, `LOG161`):**
   - Closed `RoleService.createAuditedRole`, `RoleService.createRole`,
     `RoleService.createMemberRole`, `RoleService.createGuestRole`,
     `RoleService.createWorkspaceCustomApplicationRole`,
     `RoleService.updateRole`, `RoleService.deleteRole`,
     `AiAgentRoleService.deleteAgentOnlyRoleIfUnused`
     (`runAuditedUnusedAgentRoleDelete`),
     `RoleResolver.createOneRole` / `updateOneRole` / `deleteOneRole`,
     `CreateRoleTool`, `UpdateRoleTool`, `DeleteRoleTool`,
     `WorkspaceManagerService.init` / `setupDefaultRoles`,
     `DevSeederPermissionsService.initPermissions` /
     `initMinimalPermissionsAndActivateWorkspace`, and
     `WorkflowVersionStepOperationsWorkspaceService.runWorkflowVersionStepDeletionSideEffects`.
2. **Single-target and bulk member, agent, and API-key role assignments (`LOG113`, `LOG156`, `LOG159`, `LOG160`, `LOG161`):**
   - Closed `UserRoleService.assignRoleToWorkspaceMember`,
     `UserRoleService.assignRoleToManyUserWorkspace`,
     `AiAgentRoleService.assignRoleToAgent` / `removeRoleFromAgent`
     (including `WorkflowVersionStepOperationsWorkspaceService.createDraftStep` and
     removal of the unaudited fallback branch),
     `ApiKeyRoleService.assignRoleToApiKey`, and
     `RoleTargetService.createMany` with database-locked target/role/last-admin
     verification and atomic `roleTarget` (`delete`, `create`) audit entries.
3. **Role permission flag, object permission, field permission, and row-level permission predicate upserts (`LOG157`, `LOG160`):**
   - Closed `RolePermissionFlagService.upsertPermissionFlags`,
     `ObjectPermissionService.upsertObjectPermissions`,
     `FieldPermissionService.upsertFieldPermissions`, and
     `RowLevelPermissionPredicateService.upsertRowLevelPermissionPredicates`
     across GraphQL, AI tools, and dev-seeder bootstrap.
4. **API-key creation, update, and revocation (`LOG158`):**
   - Closed `ApiKeyService.create`, `ApiKeyService.update`, and
     `ApiKeyService.revoke` across GraphQL, REST, and CLI with single-transaction
     `core."apiKey"` + `core."roleTarget"` creation and atomic `apiKey` /
     `roleTarget` CRM audit entries.

## Next open boundary (`rob765-progress.md` - inline `roleTarget` mutations inside `AgentService` and remaining core/native writers)

1. In `AgentService` (`packages/twenty-server/src/engine/metadata-modules/ai/ai-agent/agent.service.ts:82-350`):
   - `AgentService.createOneAgent`, `AgentService.updateOneAgent`, and
     `AgentService.deleteManyAgents` can create, replace, or delete
     `core."roleTarget"` rows alongside `core.agent` mutations through
     `WorkspaceMigrationValidateBuildAndRunService` when `roleId` is supplied on
     agent creation/update or when deleting an agent that has an assigned role.
