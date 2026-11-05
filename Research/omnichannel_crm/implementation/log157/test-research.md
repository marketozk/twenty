# LOG157 test research

Read-only test boundary analysis for audited role permission flag, object
permission, field permission, and row-level permission predicate upserts after
LOG156 publication (`6547c7ea`). No runtime results are claimed here.

## Existing test suites and compatibility

1. `test/fork-migration/crm-audit-role-update.postgres-spec.ts` (`LOG111`, `LOG112`),
   `test/fork-migration/crm-audit-role-assignment.postgres-spec.ts` (`LOG113`), and
   `test/fork-migration/crm-audit-role-delete-and-targets.postgres-spec.ts` (`LOG156`):
   - Test `RoleService`, `UserRoleService`, `AiAgentRoleService`,
     `ApiKeyRoleService`, `RoleTargetService`, and
     `WorkspaceMigrationRunnerService` against real PostgreSQL.
   - Keeping `role-permission-audit.ts` as a separate metadata audit owner
     (`getRolePermissionAudit`, `runAuditedRolePermissionUpsert`) with mutual
     exclusion in `WorkspaceMigrationRunnerService.executeRun` preserves all
     existing role and `roleTarget` suites unchanged.
2. `src/engine/metadata-modules/role/tools/__tests__/role-tools.spec.ts`:
   - Updating `UpsertObjectPermissionsTool.execute` and
     `UpsertRowLevelPermissionRulesTool.execute` to forward
     `auditIdentity: { auth: context.authContext!, agentId: context.agentId }`
     requires updating their unit expectations in `role-tools.spec.ts`.

## New PostgreSQL cases required for LOG157

1. **Audited role permission flag upserts (`RolePermissionFlagService.upsertPermissionFlags`, `runAuditedRolePermissionUpsert`):**
   - Creates and deletes `core."rolePermissionFlag"` rows for an editable role
     and writes atomic `rolePermissionFlag` `delete` + `create` audit entries
     (`{ roleId, permissionFlagId }`) sharing one `operationId` before `COMMIT`.
   - Rejects revoking `PermissionFlagType.ROLES` on a role held by the caller
     (`actingRoleIds` or live `core."roleTarget"` row for `actingUserWorkspaceId`)
     when `canUpdateAllSettings === false`, both at the service pre-check
     (`PermissionsExceptionCode.CANNOT_REVOKE_OWN_SETTINGS_ACCESS`) and under DB
     lock when `canUpdateAllSettings` was concurrently cleared in `core.role`,
     with 0 DB mutations and 0 audit entries.
   - Rejects stale `before` flag sets (e.g., an un-planned `rolePermissionFlag`
     row inserted concurrently in DB) or non-editable roles, and rolls back on
     post-flush corruption.
2. **Audited object permission upserts (`ObjectPermissionService.upsertObjectPermissions`, `UpsertObjectPermissionsTool`):**
   - Creates, updates, and deletes `core."objectPermission"` overrides in one
     transaction and writes atomic `objectPermission` `delete`, `update`, and
     `create` audit entries with exact boolean diff fields.
   - Rejects read/write inconsistency under DB lock when `core.role` has
     `canReadAllObjectRecords = false` (or `canUpdateAllObjectRecords = true`
     with `canReadObjectRecords = false`), rejects stale `core."objectPermission"`
     sets or missing/foreign `core."objectMetadata"`, and preserves committed
     mutations + cache invalidation (`rolesPermissions`) on
     `NativeTransactionOutcomeUnknownError`.
3. **Audited field permission upserts (`FieldPermissionService.upsertFieldPermissions`):**
   - Creates, updates, and deletes `core."fieldPermission"` rows (including
     mirrored relation target field permissions) in one transaction and writes
     atomic `fieldPermission` `delete`, `update`, and `create` audit entries.
   - Rejects system objects (`isSystem = true`), field/object ownership
     mismatches in `core."fieldMetadata"`, non-restriction values (`true`), or
     post-flush corruption.
4. **Audited row-level permission predicate and group upserts (`RowLevelPermissionPredicateService.upsertRowLevelPermissionPredicates`, `UpsertRowLevelPermissionRulesTool`):**
   - Creates, updates, and deletes `core."rowLevelPermissionPredicateGroup"` and
     `core."rowLevelPermissionPredicate"` rows in one transaction and writes
     atomic `rowLevelPermissionPredicateGroup` and `rowLevelPermissionPredicate`
     audit entries with `value` redacted (hash-only) and structural fields in
     `values`.
   - Rejects foreign/missing `fieldMetadataId` or `workspaceMemberFieldMetadataId`,
     stale `before` group/predicate sets in DB, or post-flush corruption, with 0
     DB mutations and 0 audit entries.
