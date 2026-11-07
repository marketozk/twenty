# Next boundary after LOG165 - remaining core metadata writers and durable cache

Read-only boundary analysis for the step following LOG165. No runtime or
acceptance claim is made here.

## What LOG111-LOG113 and LOG156-LOG165 closed

1. **Role `CREATE`, `UPDATE`, `DELETE`** across public, AI tool, system/bootstrap,
   workflow agent-step, standard application sync, and application manifest sync/uninstall
   paths (`LOG111`, `LOG112`, `LOG156`, `LOG160`, `LOG161`, `LOG165`).
2. **Every service-level and manifest/uninstall `roleTarget` mutation** (`LOG113`, `LOG156`,
   `LOG158`-`LOG162`, `LOG165`): `UserRoleService`, `AiAgentRoleService`, `ApiKeyRoleService`,
   `ApiKeyService`, `RoleTargetService`, `AgentService`, `ApplicationManifestMigrationService`,
   and `ApplicationSyncService.uninstallApplication`.
3. **Role permission upserts and manifest/uninstall permission sync** (`LOG157`, `LOG160`,
   `LOG165`): permission flags, object and field permissions, row-level predicates and groups,
   plus `WorkspaceMigrationRunnerService` guard refusing unaudited migrations touching any of
   the seven role/permission/roleTarget metadata tables and `ApplicationService.delete` guard
   refusing unaudited cascade deletion.
4. **API-key create, update and revoke** (`LOG158`).
5. **Workspace and application `defaultRoleId` updates** (`LOG163`, `LOG164`).

## Next open boundary

1. **Object/field/permissionFlag deletion through standalone metadata services (`ObjectMetadataService`, `FieldMetadataService`).**
   When a custom object or field is deleted outside an application manifest sync (through
   `ObjectMetadataService.deleteOneObject` or `FieldMetadataService.deleteOneField`) and a role
   holds `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicate`, or
   `rowLevelPermissionPredicateGroup` rows referencing that object or field, PostgreSQL
   `ON DELETE CASCADE` / `ON DELETE SET NULL` mutates those permission tables unless routed
   through an audited metadata scope.
2. **Remaining core metadata writers (`coreWorkflow`, `coreView`, `navigationMenuItem`, `applicationAuthorization`, `userApplicationVariableValue`, `twoFactorAuthenticationMethod`) and durable cache / HTTP-JWT acceptance.**
