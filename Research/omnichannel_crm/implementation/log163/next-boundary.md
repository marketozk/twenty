# Next boundary after LOG163 - application defaultRoleId and application manifest metadata writers

Read-only boundary analysis for the step following LOG163. No runtime or
acceptance claim is made here.

## What LOG111-LOG113 and LOG156-LOG163 closed

1. **Role `CREATE`, `UPDATE`, `DELETE`** across public, AI tool, system/bootstrap and
   workflow agent-step paths (`LOG111`, `LOG112`, `LOG156`, `LOG160`, `LOG161`):
   `RoleService.createAuditedRole` / `createRole` / `createMemberRole` / `createGuestRole` /
   `createWorkspaceCustomApplicationRole` / `updateRole` / `deleteRole`,
   `AiAgentRoleService.deleteAgentOnlyRoleIfUnused`, the role resolver and AI tools,
   `WorkspaceManagerService`, `DevSeederPermissionsService` and
   `WorkflowVersionStepOperationsWorkspaceService`.
2. **Every service-level `roleTarget` mutation** (`LOG113`, `LOG156`, `LOG158`-`LOG162`):
   `UserRoleService.assignRoleToWorkspaceMember` / `assignRoleToManyUserWorkspace`,
   `AiAgentRoleService.assignRoleToAgent` / `removeRoleFromAgent`,
   `ApiKeyRoleService.assignRoleToApiKey`, `ApiKeyService.create`,
   `RoleTargetService.createMany`, and `AgentService.createOneAgent` / `updateOneAgent` /
   `deleteOneAgent` / `deleteManyAgents` (`withAgentMetadataRoleTargetAudit`).
3. **Role permission upserts** (`LOG157`, `LOG160`): permission flags, object and field
   permissions, row-level predicates and groups.
4. **API-key create, update and revoke** (`LOG158`).
5. **Workspace `defaultRoleId` updates** (`LOG163`):
   `WorkspaceService.updateWorkspaceById` (`WorkspaceResolver.updateWorkspace`),
   `WorkspaceManagerService.setupDefaultRoles` and
   `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace`
   (`runAuditedWorkspaceDefaultRoleUpdate` in `workspace-default-role-audit.ts`).

## Next open boundary

1. **Application `defaultRoleId` (`core.application."defaultRoleId"`).**
   `ApplicationService.update` (`application.service.ts:802`) sets `defaultRoleId` on
   `core.application` from `RoleService.createWorkspaceCustomApplicationRole`
   (`role.service.ts:641`), `TwentyStandardApplicationService.setStandardApplicationDefaultRoleOrThrow`
   (`twenty-standard-application.service.ts:160`) and
   `ApplicationManifestMigrationService.syncApplicationReferencesFromManifest`
   (`application-manifest-migration.service.ts:438`). This column controls the effective
   role under which application logic functions, workflows, REST/GraphQL/MCP requests and
   record shares execute (`resolve-role-ids-from-auth-context.util.ts:22-33`,
   `workflow-execution-context.service.ts:227-243`).
2. **Application manifest install, sync and uninstall.**
   `ApplicationManifestMigrationService` (`application-manifest-migration.service.ts:141`, `:341`)
   and `ApplicationSyncService` (`application-sync.service.ts:462`) run
   `validateBuildAndRunWorkspaceMigrationFromTo` / `FromRecord` with no CRM audit scope.
   A manifest declares `roles` (with permission flags, object/field permissions and row-level
   predicates) and `agents` with `roleUniversalIdentifier`; the latter become `roleTarget`
   rows. Uninstall or an upgrade with `inferDeletionFromMissingEntities` deletes them, and
   deleting an agent removes its `roleTarget` through `ON DELETE CASCADE`. A role replaced
   through `AgentService.updateOneAgent` or `AiAgentRoleService.assignRoleToAgent` gets a new
   random universal identifier under the workspace application, so a later manifest sync that
   re-creates the manifest binding may hit `IDX_ROLE_TARGET_UNIQUE_AGENT`.
3. **`TwentyStandardApplicationService` sync** (`twenty-standard-application.service.ts:95`)
   writes standard roles and permissions through the same unaudited `FromTo` entry point.
