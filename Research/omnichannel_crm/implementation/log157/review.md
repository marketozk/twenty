# LOG157 independent owner implementation review

Reviewed the audited role permission flag, object permission, field permission,
and row-level permission predicate and group upsert implementation
(`crm-audit.types.ts`, `crm-audit-transaction-context.ts`,
`role-permission-audit.ts`, `WorkspaceMigrationRunnerService`,
`RolePermissionFlagService`, `ObjectPermissionService`,
`FieldPermissionService`, `RowLevelPermissionPredicateService`, `RoleResolver`,
`UpsertObjectPermissionsTool`, and `UpsertRowLevelPermissionRulesTool`),
Enterprise dependency isolation, unit tool tests, and PostgreSQL integration
test suites against `Research/omnichannel_crm/implementation/log157/design.md`
and `Research/omnichannel_crm/implementation/log157/design-review.md`. No
source or runtime files were modified during this review.

## Verdict

No remaining blocking defects, race conditions, SQL injection or authority
bypass vectors, or Enterprise dependency violations were identified in the
inspected working tree changes:

- `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit.types.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/role-permission-audit.ts`
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service.ts`
- `packages/twenty-server/src/engine/metadata-modules/role-permission-flag/role-permission-flag.service.ts`
- `packages/twenty-server/src/engine/metadata-modules/object-permission/object-permission.service.ts`
- `packages/twenty-server/src/engine/metadata-modules/object-permission/field-permission/field-permission.service.ts`
- `packages/twenty-server/src/engine/metadata-modules/row-level-permission-predicate/services/row-level-permission-predicate.service.ts`
- `packages/twenty-server/src/engine/metadata-modules/role/role.resolver.ts`
- `packages/twenty-server/src/engine/metadata-modules/role/tools/upsert-object-permissions.tool.ts`
- `packages/twenty-server/src/engine/metadata-modules/role/tools/upsert-row-level-permission-rules.tool.ts`
- `packages/twenty-server/src/engine/metadata-modules/role/tools/__tests__/role-tools.spec.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-role-permissions.postgres-spec.ts`

All four implementation refinements raised in `design-review.md` and all
security, transactional, and house-rule checks are accurately implemented.

## Verification of design-review.md findings and review checks

1. **Action handler diffing (`compareTwoFlatEntity`, `updatedAt` in `toCompare: false`), `mappings` snapshot before `work(runner)`, and unchanged-row correspondence:**
   - `WorkspaceMigrationRunnerService.executeRun` snapshots `mappings`
     (`application`, `roles`, `permissionFlags`, `rolePermissionFlags`,
     `objectMetadatas`, `fieldMetadatas`, `objectPermissions`,
     `fieldPermissions`, `rowLevelPermissionPredicates`,
     `rowLevelPermissionPredicateGroups`) before `execute` runs action handlers
     that mutate `allFlatEntityMaps` in place.
   - `runAuditedRolePermissionUpsert` resolves all planned `create`, `update`,
     and `delete` actions before entering `runInCoreAuditTransaction`, and in
     `runAuditedRowLevelPermissionUpsert` resolves group universal identifiers
     via `resolveGroupId` against the union of
     `mappings.rowLevelPermissionPredicateGroups` and
     `createdGroupIdByUniversalId`.
   - For `create` actions across all 5 entity kinds, `role-permission-audit.ts`
     normalizes `undefined` boolean/nullable fields to `null`, compares
     `scalarWithoutTimestamps(actual)` against `expectedScalar`, and verifies
     microsecond `createdAt` and `updatedAt` timestamps in PostgreSQL via
     `"createdAt"=$2::timestamptz AND "updatedAt"=$3::timestamptz`.
   - For `update` actions (`objectPermission`, `fieldPermission`,
     `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`),
     `extractPlainObject` inspects `Object.getOwnPropertyDescriptors`, rejects
     accessor properties, empty updates, and immutable or unsupported keys,
     resolves universal foreign keys on RLS updates
     (`fieldMetadataUniversalIdentifier`,
     `workspaceMemberFieldMetadataUniversalIdentifier`,
     `rowLevelPermissionPredicateGroupUniversalIdentifier`,
     `parentRowLevelPermissionPredicateGroupUniversalIdentifier`), and verifies
     post-handler rows using `updatedAt: actual?.updatedAt`.
   - Surviving rows without a `plannedUpdate` must match `beforeRow`
     bit-for-bit (including `updatedAt`) and emit no audit entry.
2. **`FieldPermissionService.upsertFieldPermissions` partial-update semantics, relation mirror fields, and `core."objectPermission"` non-requirement:**
   - `FieldPermissionService.upsertFieldPermissions` computes `touchedFieldKeys`
     and `desiredActiveFieldKeys` across both `inputFieldKeys` and
     `mirroredFieldKeys` (`ONE_TO_MANY` / `MANY_TO_ONE` relation target fields
     from `addRelatedFieldPermissionsToDesired`), excluding foreign-application
     mirrored rows when cleared.
   - `runAuditedFieldPermissionUpsert` locks all `core."fieldPermission"` rows
     for `(workspaceId, roleId)` (plus any touched IDs) `FOR UPDATE`, verifies
     that untargeted `beforeRows` have neither delete nor update actions and
     remain bit-for-bit identical after `work(runner)` and after
     `audit.flush()`, and verifies 1-to-1 correspondence between
     `desiredActiveFieldKeys`, surviving rows, and `plannedCreates`.
   - `runAuditedFieldPermissionUpsert` locks `core.role` (`FOR UPDATE`),
     referenced `core."objectMetadata"` (`FOR SHARE`, verifying
     `isSystem !== true`), and referenced `core."fieldMetadata"` (`FOR SHARE`,
     verifying `field.objectMetadataId === objectId` for all touched direct and
     mirrored fields) without requiring an override row in
     `core."objectPermission"`.
3. **Pre-assigned group/predicate UUIDs in `RowLevelPermissionPredicateService.upsertRowLevelPermissionPredicates` and `ON DELETE CASCADE` lock coverage:**
   - `RowLevelPermissionPredicateService.upsertRowLevelPermissionPredicates`
     synchronously clones `args.input` before the first `await`, assigning
     `id: predicate.id ?? v4()` (and `structuredClone(predicate.value)`) on
     each predicate and `id: group.id ?? v4()` on each predicate group, and
     validates `captureRoleAuditIdentity` + `captureRoleAuditOperation` before
     `await this.hasRowLevelPermissionFeatureOrThrow(workspaceId)`.
   - `runAuditedRowLevelPermissionUpsert` locks all
     `core."rowLevelPermissionPredicateGroup"` rows in `workspaceId` matching
     `("roleId"=$2 AND "objectMetadataId"=$3 AND "deletedAt" IS NULL) OR id=ANY($4::uuid[]) OR "parentRowLevelPermissionPredicateGroupId"=ANY($5::uuid[])`
     `FOR UPDATE` and all `core."rowLevelPermissionPredicate"` rows matching
     `("roleId"=$2 AND "objectMetadataId"=$3 AND "deletedAt" IS NULL) OR id=ANY($4::uuid[]) OR "rowLevelPermissionPredicateGroupId"=ANY($5::uuid[])`
     `FOR UPDATE`, rejecting any row with `deletedAt !== null`, foreign
     `roleId` / `objectMetadataId`, or unplanned cascade child before
     `await work(runner)` executes.
   - For predicates referencing `workspaceMemberFieldMetadataId`,
     `runAuditedRowLevelPermissionUpsert` locks both the referenced
     `core."fieldMetadata"` row and its owning `core."objectMetadata"` row
     (`FOR SHARE`) and verifies `"nameSingular" === 'workspaceMember'` in
     `workspaceId`.
4. **Strict Enterprise dependency isolation (`scripts/omnichannel/check_enterprise_dependencies.py`) and `CLAUDE.md` house rules:**
   - Running
     `python -I -X utf8 scripts/omnichannel/check_enterprise_dependencies.py --verify-baseline`
     reports `"status": "pass"` with zero violations (`{}`).
   - `role-permission-audit.ts` does not import from `'twenty-shared/types'` or
     any `row-level-permission-predicate` module, validating `logicalOperator`
     and `operand` locally.
   - All modified and newly added files adhere to `CLAUDE.md` house rules
     (named exports, strict typing without `any`, and terse WHY-only `//`
     comments).

## Security, transactional integrity and test coverage checks

1. **Database locking, self-lockout, read/write consistency, redaction, and lost-ACK cache invalidation:**
   - All 4 permission audit runners execute inside `runInCoreAuditTransaction`
     with `SET LOCAL lock_timeout = '8s'`, locking `core.workspace`
     (`FOR NO KEY UPDATE`), `core.application` (`FOR SHARE`), `core.role`
     (`FOR UPDATE`, verifying `isEditable === true` and `applicationId`), target
     metadata tables (`FOR SHARE`), and permission rows (`FOR UPDATE`), and
     re-verifying all locked snapshots after `audit.flush()` before `COMMIT`.
   - `RolePermissionFlagService.upsertPermissionFlags` and
     `runAuditedRolePermissionFlagUpsert` enforce self-lockout protection both
     pre-flight and under DB locks (`actingRoleIds` and live `core."roleTarget"`
     `FOR SHARE`) when `canUpdateAllSettings !== true` and `'ROLES'` is omitted.
   - `runAuditedObjectPermissionUpsert` enforces read/write consistency against
     the locked `core.role` row after applying overrides.
   - `crm-audit-transaction-context.ts` redacts
     `rowLevelPermissionPredicate.value` (and `deletedAt` on RLS groups and
     predicates), storing only hashes while recording `changedFields: ['value']`
     with `values: {}`.
   - `WorkspaceMigrationRunnerService.invalidateCache` includes
     `flatRowLevelPermissionPredicateMaps` and
     `flatRowLevelPermissionPredicateGroupMaps` in `hasRolesPermissionsChanged`
     and runs in `finally` so `rolesPermissions` and flat entity caches are
     invalidated even when `COMMIT` throws
     `NativeTransactionOutcomeUnknownError`.
2. **Unit and PostgreSQL integration test coverage:**
   - `role-tools.spec.ts` verifies that `UpsertObjectPermissionsTool` and
     `UpsertRowLevelPermissionRulesTool` forward `auditIdentity` to their
     respective services.
   - `crm-audit-role-permissions.postgres-spec.ts` exercises real PostgreSQL
     transactions across all 5 resource kinds: atomic create/update/delete
     auditing, no-op skipping, self-lockout rejection (pre-check and concurrent
     DB lock), stale cache divergence rejection, post-flush trigger corruption
     rollback, agent initiator attribution, read/write consistency against
     locked `core.role`, `NativeTransactionOutcomeUnknownError` commit
     preservation and cache invalidation, relation mirror field permissions and
     untargeted field preservation, system object rejection, RLS `value`
     redaction, `workspaceMember` object verification, `ON DELETE CASCADE`
     soft-deleted child protection, and administrative `securityDescriptor` and
     single-consumption invariants.
