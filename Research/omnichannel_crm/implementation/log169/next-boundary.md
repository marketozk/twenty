# Next boundary after LOG169 - `navigationMenuItem` lifecycle and cascade deletions, durable cache

Read-only boundary analysis for the step following LOG169. No runtime or
acceptance claim is made here.

## What LOG111-LOG113 and LOG156-LOG169 closed

1. **Role `CREATE`, `UPDATE`, `DELETE`** across public, AI tool, system/bootstrap,
   workflow agent-step, standard application sync, and application manifest sync/uninstall
   paths (`LOG111`, `LOG112`, `LOG156`, `LOG160`, `LOG161`, `LOG165`).
2. **Every service-level and manifest/uninstall `roleTarget` mutation** (`LOG113`, `LOG156`,
   `LOG158`-`LOG162`, `LOG165`): `UserRoleService`, `AiAgentRoleService`, `ApiKeyRoleService`,
   `ApiKeyService`, `RoleTargetService`, `AgentService`, `ApplicationManifestMigrationService`,
   and `ApplicationSyncService.uninstallApplication`.
3. **Role permission upserts, manifest/uninstall permission sync, and standalone object/field deletion cascades**
   (`LOG157`, `LOG160`, `LOG165`, `LOG166`): permission flags, object and field permissions,
   row-level predicates and groups, `ObjectMetadataService.deleteOneObject`,
   `FieldMetadataService.deleteOneField`, `ApplicationService.delete` guard, and
   `WorkspaceMigrationRunnerService` fail-closed barrier.
4. **API-key create, update and revoke** (`LOG158`).
5. **Workspace and application `defaultRoleId` updates** (`LOG163`, `LOG164`).
6. **`applicationAuthorization` and `userApplicationVariableValue` lifecycle and cascade deletions**
   (`LOG167`).
7. **`twoFactorAuthenticationMethod` lifecycle and recovery-code redemption (`twoFactorAuthenticationMethod` + `refreshToken`)**
   (`LOG168`).
8. **`coreWorkflow` and `coreView` ownership (`createdByUserWorkspaceId`) and visibility (`visibility`) updates and durable `sync_workflowRunShares` reconciliation**
   (`LOG169`): `CoreWorkflowMutationWorkspaceService.updateWorkflowVisibility`, `CoreWorkflowResolver.updateCoreWorkflowVisibility`, `ViewService.updateOne`, `ViewResolver.updateView`, `ViewController.update`, `runAuditedApplicationMetadataMigration`, and `WorkspaceMigrationRunnerService` fail-closed barrier.

## Next open boundary

1. **`navigationMenuItem` full lifecycle (`create`, `update`, `delete`) and cascade deletions (`NavigationMenuItemService`, `NavigationMenuItemResolver`, `NavigationMenuItemDeletionService`, manifest/standard-app sync, and parent FK cascades).**
2. **Durable cache / background event delivery and full HTTP-JWT acceptance.**
