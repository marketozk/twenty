# Next boundary after LOG162 - application manifest metadata writers and workspace defaultRoleId

Read-only boundary analysis for the step following LOG162. No runtime or
acceptance claim is made here.

## What LOG111-LOG113 and LOG156-LOG162 closed

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
   `RoleTargetService.createMany`, and now `AgentService.createOneAgent` / `updateOneAgent` /
   `deleteOneAgent` / `deleteManyAgents` (`withAgentMetadataRoleTargetAudit`).
3. **Role permission upserts** (`LOG157`, `LOG160`): permission flags, object and field
   permissions, row-level predicates and groups.
4. **API-key create, update and revoke** (`LOG158`).

## Next open boundary

1. **Application manifest install, sync and uninstall.**
   `ApplicationManifestMigrationService` (`application-manifest-migration.service.ts:141`, `:341`)
   and `ApplicationSyncService` (`application-sync.service.ts:462`) run
   `validateBuildAndRunWorkspaceMigrationFromTo` / `FromRecord` with no CRM audit scope.
   A manifest declares `roles` (with permission flags, object/field permissions and row-level
   predicates) and `agents` with `roleUniversalIdentifier`; the latter become `roleTarget`
   rows (`find-manifest-entity-descriptor-by-universal-identifier.util.ts:248`). Uninstall or
   an upgrade with `inferDeletionFromMissingEntities` deletes them, and deleting an agent
   removes its `roleTarget` through `ON DELETE CASCADE`. None of these writes are audited yet.
   A role replaced through `AgentService.updateOneAgent` or `AiAgentRoleService.assignRoleToAgent`
   gets a new random universal identifier under the workspace application, so a later
   manifest sync that re-creates the manifest binding may hit `IDX_ROLE_TARGET_UNIQUE_AGENT`.
2. **`TwentyStandardApplicationService` sync** (`twenty-standard-application.service.ts:95`)
   writes standard roles and permissions through the same unaudited `FromTo` entry point.
3. **Workspace `defaultRoleId`** updates in `WorkspaceService`
   (`workspace.service.ts:386`) change which role new members receive and are not audited.

The runner already refuses to mix audit owners in one migration
(`workspace-migration-runner.service.ts:391-400`); a manifest audit has to describe a
multi-entity plan (roles, permissions, agents, role targets) rather than one bounded
replacement, so it needs its own design and review before implementation.
