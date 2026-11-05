# LOG157 - audited role permission flag, object permission, field permission, and row-level permission predicate upserts

Proposed concrete design for independent review. Source inspection used
`RolePermissionFlagService`, `ObjectPermissionService`, `FieldPermissionService`,
`RowLevelPermissionPredicateService`, `RoleResolver`,
`UpsertObjectPermissionsTool`, `UpsertRowLevelPermissionRulesTool`,
`WorkspaceMigrationRunnerService`, `validate-role-mutation-does-not-lock-out-actor.util.ts`,
`role-update-audit.ts`, `role-assignment-audit.ts`, `crm-audit.types.ts`, and
`crm-audit-transaction-context.ts`. No repository or runtime changes are claimed
by this document.

## Problem and scope

In `rob765-progress.md` (`Role lifecycle`) and `log156/next-boundary.md`,
`LOG111`–`LOG113` and `LOG156` closed public and AI role `CREATE`, `UPDATE`, and
`DELETE` plus member, agent, and API-key `roleTarget` assignments. The remaining
role permission mutation surfaces in `RoleResolver` and `RoleToolsModule` are:

1. **Role permission flag upserts (`RolePermissionFlagService.upsertPermissionFlags`, `RoleResolver.upsertPermissionFlags`):**
   - Replaces a role's `core."rolePermissionFlag"` rows without atomic CRM audit
     coverage, database-locked role/application/flag verification, or
     self-lockout protection when a caller whose role has
     `canUpdateAllSettings === false` removes `PermissionFlagType.ROLES` from
     their own role.
2. **Object permission upserts (`ObjectPermissionService.upsertObjectPermissions`, `RoleResolver.upsertObjectPermissions`, `UpsertObjectPermissionsTool.execute`):**
   - Replaces a role's `core."objectPermission"` overrides without atomic CRM
     audit coverage or database-locked `core.role`, `core."objectMetadata"`, and
     read/write consistency verification.
3. **Field permission upserts (`FieldPermissionService.upsertFieldPermissions`, `RoleResolver.upsertFieldPermissions`):**
   - Upserts/deletes a role's `core."fieldPermission"` restrictions (including
     relation mirror fields) without atomic CRM audit coverage or
     database-locked `core.role`, `core."objectMetadata"`, `core."fieldMetadata"`,
     and `core."objectPermission"` verification.
4. **Row-level permission predicate and group upserts (`RowLevelPermissionPredicateService.upsertRowLevelPermissionPredicates`, `RoleResolver.upsertRowLevelPermissionPredicates`, `UpsertRowLevelPermissionRulesTool.execute`):**
   - Replaces a role+object's `core."rowLevelPermissionPredicateGroup"` and
     `core."rowLevelPermissionPredicate"` rules without atomic CRM audit
     coverage or database-locked role/object/field/group ownership verification.

## Proposed design

1. **Audit catalog extension (`crm-audit.types.ts`, `crm-audit-transaction-context.ts`):**
   - Add five administrative resource kinds with exact
     `metadataAccess: 'currentWorkspaceAdministration'` descriptor enforcement:
     - `rolePermissionFlag`: `ADMINISTRATIVE_ACTIONS = ['create', 'delete']`,
       `CATALOG = { values: ['roleId', 'permissionFlagId'], redacted: [] }`.
     - `objectPermission`: `ADMINISTRATIVE_ACTIONS = ['create', 'update', 'delete']`,
       `CATALOG = { values: ['roleId', 'objectMetadataId', 'canReadObjectRecords', 'canUpdateObjectRecords', 'canSoftDeleteObjectRecords', 'canDestroyObjectRecords'], redacted: [] }`.
     - `fieldPermission`: `ADMINISTRATIVE_ACTIONS = ['create', 'update', 'delete']`,
       `CATALOG = { values: ['roleId', 'objectMetadataId', 'fieldMetadataId', 'canReadFieldValue', 'canUpdateFieldValue'], redacted: [] }`.
     - `rowLevelPermissionPredicateGroup`: `ADMINISTRATIVE_ACTIONS = ['create', 'update', 'delete']`,
       `CATALOG = { values: ['roleId', 'objectMetadataId', 'parentRowLevelPermissionPredicateGroupId', 'logicalOperator', 'positionInRowLevelPermissionPredicateGroup'], redacted: ['deletedAt'] }`.
     - `rowLevelPermissionPredicate`: `ADMINISTRATIVE_ACTIONS = ['create', 'update', 'delete']`,
       `CATALOG = { values: ['roleId', 'objectMetadataId', 'fieldMetadataId', 'operand', 'subFieldName', 'workspaceMemberFieldMetadataId', 'workspaceMemberSubFieldName', 'rowLevelPermissionPredicateGroupId', 'positionInRowLevelPermissionPredicateGroup'], redacted: ['value', 'deletedAt'] }`.
       (`value` is redacted so JSONB arrays/objects and literal filter values are
       hashed for diff detection without storing raw user/customer literals in
       `crm_audit."crmAuditEntry"`).
2. **Closed role permission audit owner (`packages/twenty-server/src/engine/core-modules/crm-audit/role-permission-audit.ts`, `WorkspaceMigrationRunnerService`):**
   - Introduce `withRolePermissionFlagUpsertAudit`,
     `withObjectPermissionUpsertAudit`, `withFieldPermissionUpsertAudit`,
     `withRowLevelPermissionUpsertAudit`, `getRolePermissionAudit`, and
     `runAuditedRolePermissionUpsert` in `role-permission-audit.ts` (keeping all
     imports enterprise-free so `check_enterprise_dependencies.py` passes with 0
     violations).
   - Enforce mutual exclusion in `WorkspaceMigrationRunnerService.executeRun`
     across `roleAudit`, `assignmentAudit`, and `permissionAudit`, and include
     `flatRowLevelPermissionPredicateMaps` and
     `flatRowLevelPermissionPredicateGroupMaps` in `hasRolesPermissionsChanged`
     inside `invalidateCache` so `rolesPermissions` is invalidated in `finally`
     even on `NativeTransactionOutcomeUnknownError`.
   - Inside `runInCoreAuditTransaction`:
     - Lock `core.workspace` `FOR NO KEY UPDATE` (active workspace check), verify
       `core.application` `FOR SHARE` (`verifyRoleAuditApplication`), and lock
       `core.role` `FOR UPDATE` (verifying `isEditable === true`,
       `universalIdentifier`, and `applicationId === application.id`).
     - **For `rolePermissionFlag`**:
       - Lock `core."permissionFlag"` `FOR SHARE` and existing
         `core."rolePermissionFlag"` rows for `roleId` `FOR UPDATE`.
       - Verify caller lockout under DB locks: if `actingRoleIds` includes
         `roleId` or `core."roleTarget"` (`FOR SHARE`) links
         `actingUserWorkspaceId` to `roleId`, and `beforeRole.canUpdateAllSettings !== true`,
         reject when `'ROLES'` is not retained in `permissionFlagKeys`.
       - Verify 1-to-1 correspondence between locked `beforeRows`,
         `permissionFlagKeys`, `plannedDeletes`, and `plannedCreates`; execute
         handlers; verify post-handler rows and microsecond timestamps; record
         `rolePermissionFlag` `delete` and `create` audit entries, flush, and
         re-verify post-flush state.
     - **For `objectPermission`**:
       - Lock referenced `core."objectMetadata"` rows `FOR SHARE` and existing
         `core."objectPermission"` rows for `roleId` `FOR UPDATE`.
       - Verify full-replacement correspondence between `beforeRows`,
         `desiredObjectMetadataIds`, `plannedDeletes`, `plannedUpdates`, and
         `plannedCreates`; execute handlers; verify post-handler rows,
         microsecond timestamps, and read/write consistency against locked
         `beforeRole` (`(canRead ?? beforeRole.canReadAllObjectRecords) === false`
         cannot coexist with any write permission); record `objectPermission`
         `delete`, `update`, and `create` audit entries, flush, and re-verify
         post-flush state.
     - **For `fieldPermission`**:
       - Lock referenced `core."objectMetadata"` (`FOR SHARE`, verifying
         `isSystem === false`), `core."fieldMetadata"` (`FOR SHARE`, verifying
         `objectMetadataId` ownership), and existing `core."fieldPermission"`
         rows for `roleId` `FOR UPDATE`.
       - Verify `canReadFieldValue` and `canUpdateFieldValue` are only `false`
         or `null` (and not both `null` on create/update), verify `beforeRows`
         match planned updates/deletes, execute handlers, verify post-handler
         rows and microsecond timestamps, record `fieldPermission` `delete`,
         `update`, and `create` audit entries, flush, and re-verify post-flush
         state.
     - **For `rowLevelPermissionPredicate`**:
       - Lock referenced `core."objectMetadata"` (`FOR SHARE`) and
         `core."fieldMetadata"` (`FOR SHARE`, verifying `fieldMetadataId` belongs
         to `objectMetadataId` and `workspaceMemberFieldMetadataId` belongs to
         `workspaceMember`), plus existing active
         `core."rowLevelPermissionPredicateGroup"` and
         `core."rowLevelPermissionPredicate"` rows for `(roleId, objectMetadataId)`
         `FOR UPDATE`.
       - Verify full-replacement correspondence for `(roleId, objectMetadataId)`
         between `beforeGroups`/`beforePredicates`, `desiredGroupIds`/`desiredPredicateIds`,
         and planned `create`/`update`/`delete` actions; execute handlers;
         verify post-handler rows, group ownership, and microsecond timestamps;
         record `rowLevelPermissionPredicateGroup` and
         `rowLevelPermissionPredicate` `delete`, `update`, and `create` audit
         entries, flush, and re-verify post-flush state.
3. **Caller and service wiring (`RoleResolver`, `UpsertObjectPermissionsTool`, `UpsertRowLevelPermissionRulesTool`, `RolePermissionFlagService`, `ObjectPermissionService`, `FieldPermissionService`, `RowLevelPermissionPredicateService`):**
   - Capture all caller inputs (`input`, `actingRoleIds`, `actingUserWorkspaceId`,
     `auditIdentity`) before the first `await`.
   - `RowLevelPermissionPredicateService.upsertRowLevelPermissionPredicates`
     requires `auditIdentity: RoleUpdateAuditIdentity` unconditionally.
   - `RolePermissionFlagService.upsertPermissionFlags`,
     `ObjectPermissionService.upsertObjectPermissions`, and
     `FieldPermissionService.upsertFieldPermissions` accept
     `auditIdentity?: RoleUpdateAuditIdentity` (passed by `RoleResolver` and
     `UpsertObjectPermissionsTool`, omitted only by internal
     `DevSeederPermissionsService`) and enforce `Object.hasOwn(args, 'auditIdentity')`
     validation before the first `await`.
   - Add `validatePermissionFlagsUpsertDoesNotLockOutActorOrThrow` in
     `validate-role-mutation-does-not-lock-out-actor.util.ts` and call it in
     `RolePermissionFlagService.upsertPermissionFlags` before migration build.
