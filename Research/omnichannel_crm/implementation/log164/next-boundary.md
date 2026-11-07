# Next boundary after LOG164 - application manifest and standard application metadata migrations

Read-only boundary analysis for the step following LOG164. No runtime or
acceptance claim is made here.

## What LOG111-LOG113 and LOG156-LOG164 closed

1. **Role `CREATE`, `UPDATE`, `DELETE`** across public, AI tool, system/bootstrap and
   workflow agent-step paths (`LOG111`, `LOG112`, `LOG156`, `LOG160`, `LOG161`).
2. **Every service-level `roleTarget` mutation** (`LOG113`, `LOG156`, `LOG158`-`LOG162`):
   `UserRoleService`, `AiAgentRoleService`, `ApiKeyRoleService`, `ApiKeyService`,
   `RoleTargetService`, and `AgentService`.
3. **Role permission upserts** (`LOG157`, `LOG160`): permission flags, object and field
   permissions, row-level predicates and groups.
4. **API-key create, update and revoke** (`LOG158`).
5. **Workspace and application `defaultRoleId` updates** (`LOG163`, `LOG164`):
   `core.workspace."defaultRoleId"` (`WorkspaceService.updateWorkspaceById`,
   `WorkspaceManagerService.setupDefaultRoles`,
   `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace`) and
   `core.application."defaultRoleId"` (`ApplicationService.update`,
   `RoleService.createWorkspaceCustomApplicationRole`,
   `TwentyStandardApplicationService.setStandardApplicationDefaultRoleOrThrow`,
   `ApplicationManifestMigrationService.syncApplicationReferencesFromManifest`).

## Next open boundary

1. **Application manifest install, sync and uninstall (`FromTo` / `FromRecord` migrations).**
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
2. **`TwentyStandardApplicationService` metadata sync** (`twenty-standard-application.service.ts:95`)
   writes standard roles and permissions through the same unaudited `FromTo` entry point.
