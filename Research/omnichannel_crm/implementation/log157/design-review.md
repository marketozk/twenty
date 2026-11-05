# LOG157 Architecture and Security Design Review

Reviewed `Research/omnichannel_crm/implementation/log157/design.md`,
`Research/omnichannel_crm/implementation/log157/test-research.md`, and the
actual `crm-audit.types.ts`, `crm-audit-transaction-context.ts`,
`role-update-audit.ts`, `role-assignment-audit.ts`,
`workspace-migration-runner.service.ts`, `role.resolver.ts`,
`validate-role-mutation-does-not-lock-out-actor.util.ts`,
`role-permission-flag.service.ts`, `object-permission.service.ts`,
`field-permission.service.ts`, `row-level-permission-predicate.service.ts`,
`upsert-object-permissions.tool.ts`, `upsert-row-level-permission-rules.tool.ts`,
and `scripts/omnichannel/check_enterprise_dependencies.py` files after LOG156
(`6547c7ea`). This report covers audited role permission flag, object
permission, field permission, and row-level permission predicate and group
upserts (part of ROB-765). Runtime and source implementation acceptance belong
to the following step.

## Verdict

The LOG157 design is sound and closes the remaining public and AI role
permission mutation entrypoints (`RolePermissionFlagService.upsertPermissionFlags`,
`RoleResolver.upsertPermissionFlags`,
`ObjectPermissionService.upsertObjectPermissions`,
`RoleResolver.upsertObjectPermissions`, `UpsertObjectPermissionsTool.execute`,
`FieldPermissionService.upsertFieldPermissions`,
`RoleResolver.upsertFieldPermissions`,
`RowLevelPermissionPredicateService.upsertRowLevelPermissionPredicates`,
`RoleResolver.upsertRowLevelPermissionPredicates`, and
`UpsertRowLevelPermissionRulesTool.execute`) under the atomic `core` /
`crm_audit` transaction boundary. Four implementation-critical refinements
identified during source verification must be incorporated during
implementation:

1. **Action handler diffing (`compareTwoFlatEntity`, `updatedAt` in `toCompare: false`) and unchanged-row correspondence:**
   - In `ALL_ENTITY_PROPERTIES_CONFIGURATION_BY_METADATA_NAME`, `createdAt` and
     `updatedAt` have `toCompare: false` for `rolePermissionFlag`,
     `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicate`, and
     `rowLevelPermissionPredicateGroup`. Consequently, `compareTwoFlatEntity`
     never includes `updatedAt` in `action.update`, and
     `UpdateObjectPermissionActionHandlerService`,
     `UpdateFieldPermissionActionHandlerService`,
     `UpdateRowLevelPermissionPredicateActionHandlerService`, and
     `UpdateRowLevelPermissionPredicateGroupActionHandlerService` execute
     `repository.update({ id: entityId, workspaceId }, update)` with only the
     changed comparable columns while TypeORM's `@UpdateDateColumn` updates
     `updatedAt` in SQL.
   - Therefore, in `runAuditedRolePermissionUpsert`:
     - For `create` actions, verify microsecond `createdAt` and `updatedAt`
       timestamps via PostgreSQL `timestamptz` comparison against
       `action.flatEntity.createdAt` and `action.flatEntity.updatedAt`, and
       normalize `undefined` boolean permission fields on `action.flatEntity`
       (`fromCreateObjectPermissionInputToUniversalFlatObjectPermission` and
       `fromCreateFieldPermissionInputToUniversalFlatFieldPermission` set
       `can* ?? undefined`) to `null` when comparing against persisted
       `to_jsonb` rows.
     - For `update` actions, validate `action.update` via
       `Object.getOwnPropertyDescriptors` (rejecting accessors, empty updates,
       and immutable or unsupported keys such as `roleUniversalIdentifier`,
       `objectMetadataUniversalIdentifier`, `fieldMetadataUniversalIdentifier`,
       or `deletedAt`), resolve universal foreign keys on RLS update actions
       (`fieldMetadataUniversalIdentifier`,
       `workspaceMemberFieldMetadataUniversalIdentifier`,
       `rowLevelPermissionPredicateGroupUniversalIdentifier`,
       `parentRowLevelPermissionPredicateGroupUniversalIdentifier`), and compare
       post-handler rows using `updatedAt: afterRow.updatedAt` (matching
       `role-update-audit.ts`).
     - Existing rows that remain in the caller's desired set without any change
       to comparable properties emit no `update` action (`ObjectPermissionService`
       and `FieldPermissionService` omit unchanged rows from
       `flatEntityToUpdate`, and `compareTwoFlatEntity` returns `undefined` for
       unchanged items in `RowLevelPermissionPredicateService.groupsToUpdate` /
       `predicatesToUpdate`). For full-replacement upserts (`objectPermission`,
       `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`), every
       locked `beforeRow` whose ID/target is in the desired set must either
       match a `plannedUpdate` (recording an `update` audit entry) or have zero
       actions and remain bit-for-bit identical in `afterRows` (including
       `updatedAt`, recording no audit entry).
   - Because `computeOrderedMigrationActions` orders RLS actions as
     `rowLevelPermissionPredicateGroup.create`,
     `rowLevelPermissionPredicateGroup.update`,
     `rowLevelPermissionPredicate.delete`,
     `rowLevelPermissionPredicate.create`,
     `rowLevelPermissionPredicate.update`, and
     `rowLevelPermissionPredicateGroup.delete`, and delete handlers mutate
     `allFlatEntityMaps` in place during `work(runner)`,
     `runAuditedRolePermissionUpsert` must snapshot `mappings` before
     `await work(runner)` and resolve group universal identifiers against the
     union of `mappings.predicateGroups` and `plannedGroupCreates`.

2. **`FieldPermissionService.upsertFieldPermissions` partial-update semantics, relation mirror fields, and `core."objectPermission"` non-requirement:**
   - Unlike `upsertPermissionFlags`, `upsertObjectPermissions`, and
     `upsertRowLevelPermissionPredicates`, `FieldPermissionService.upsertFieldPermissions`
     is a partial upsert: it only creates, updates, or deletes
     `core."fieldPermission"` rows for `(objectMetadataId, fieldMetadataId)`
     keys in `input.fieldPermissions` and `mirroredFieldKeys` (`ONE_TO_MANY` /
     `MANY_TO_ONE` relation target fields added by
     `addRelatedFieldPermissionsToDesired`), leaving all other
     `core."fieldPermission"` rows on the role untouched (and leaving
     foreign-application mirrored rows untouched when cleared).
   - Accordingly, `runAuditedRolePermissionUpsert` for `fieldPermission` must
     lock all `core."fieldPermission"` rows for `(workspaceId, roleId)`
     `FOR UPDATE`, verify that every `plannedDelete` and `plannedUpdate` matches
     a locked `beforeRow`, verify that every untouched `beforeRow` remains
     completely unchanged (including `updatedAt`) after `work(runner)` and
     after `audit.flush()`, and verify that `afterRows` equals
     `(untouched beforeRows) ∪ (updated beforeRows) ∪ (created plannedCreates)`.
   - Although `FieldPermissionService.validateFieldPermission` throws
     `PermissionsExceptionCode.OBJECT_PERMISSION_NOT_FOUND` when
     `rolesPermissions?.[flatRole.id]?.[fieldPermission.objectMetadataId]` is
     missing, `WorkspaceRolesPermissionsCacheService` populates
     `rolesPermissions[role.id][objectMetadataId]` for every `objectMetadata` in
     the workspace (falling back to `role.canReadAllObjectRecords`, etc. when no
     override row exists in `core."objectPermission"`, as in
     `DevSeederPermissionsService`). Therefore, `runAuditedRolePermissionUpsert`
     for `fieldPermission` must lock `core.role` (`FOR UPDATE`),
     `core."objectMetadata"` (`FOR SHARE`, verifying `isSystem === false`), and
     `core."fieldMetadata"` (`FOR SHARE`, verifying
     `field.objectMetadataId === planned.objectMetadataId` for both direct and
     mirrored fields), and must not require a row in `core."objectPermission"`
     to exist.

3. **Pre-assigning omitted group/predicate UUIDs in `RowLevelPermissionPredicateService.upsertRowLevelPermissionPredicates` and `ON DELETE CASCADE` lock coverage:**
   - `RowLevelPermissionPredicateGroupInput.id` and
     `RowLevelPermissionPredicateInput.id` are optional (`id?: string`) and
     default to `v4()` inside `computePredicateGroupOperations` and
     `computePredicateOperations`. To pass the exact `desiredGroupIds` and
     `desiredPredicateIds` into `withRowLevelPermissionUpsertAudit` before the
     first `await`, `RowLevelPermissionPredicateService.upsertRowLevelPermissionPredicates`
     must synchronously clone `input` before the first `await` with
     `id: group.id ?? v4()` on each `predicateGroup` and
     `id: predicate.id ?? v4()` on each `predicate` (preserving
     `validateRowLevelPermissionRuleOwnershipOrThrow`,
     `computePredicateGroupOperations`, `computePredicateOperations`, and all
     existing `failing-row-level-permission-predicate-upsert.integration-spec.ts`
     error snapshots).
   - Because `core."rowLevelPermissionPredicate"."rowLevelPermissionPredicateGroupId"`
     and `core."rowLevelPermissionPredicateGroup"."parentRowLevelPermissionPredicateGroupId"`
     reference `core."rowLevelPermissionPredicateGroup"(id) ON DELETE CASCADE`,
     `runAuditedRolePermissionUpsert` must lock all
     `core."rowLevelPermissionPredicateGroup"` rows in `workspaceId` matching
     `("roleId" = $2 AND "objectMetadataId" = $3) OR id = ANY($4::uuid[]) OR "parentRowLevelPermissionPredicateGroupId" = ANY($5::uuid[])`
     `FOR UPDATE` and all `core."rowLevelPermissionPredicate"` rows in
     `workspaceId` matching
     `("roleId" = $2 AND "objectMetadataId" = $3) OR id = ANY($6::uuid[]) OR "rowLevelPermissionPredicateGroupId" = ANY($5::uuid[])`
     `FOR UPDATE` before `await work(runner)`, verifying `deletedAt === null`,
     `roleId === request.roleId`, `objectMetadataId === request.objectMetadataId`,
     and 1-to-1 correspondence with `desiredGroupIds` / `desiredPredicateIds`
     and planned actions so `ON DELETE CASCADE` can never silently delete an
     un-planned, soft-deleted, or cross-role/cross-object row.
   - For predicates with non-null `workspaceMemberFieldMetadataId`,
     `runAuditedRolePermissionUpsert` must lock both the referenced
     `core."fieldMetadata"` row and its owning `core."objectMetadata"` row
     (`FOR SHARE`) and verify that the owning object belongs to `workspaceId`
     and has `"nameSingular" = 'workspaceMember'`.

4. **Enterprise dependency guard (`scripts/omnichannel/check_enterprise_dependencies.py`) compliance:**
   - In `Research/omnichannel_crm/implementation/enterprise-dependency-baseline.json`,
     `packages/twenty-shared/src/types/index.ts` (`twenty-shared/types`) and all
     files under `src/engine/metadata-modules/row-level-permission-predicate/`
     are in `reaches_enterprise`, and `check_enterprise_dependencies.py` treats
     both value imports and `import type` as dependency edges.
   - Therefore, `role-permission-audit.ts` and
     `validate-role-mutation-does-not-lock-out-actor.util.ts` must not import
     from `'twenty-shared/types'` or from any
     `row-level-permission-predicate` / universal-flat-entity RLS module.
     `validate-role-mutation-does-not-lock-out-actor.util.ts` must continue
     importing `PermissionFlagType` from `'twenty-shared/constants'`
     (enterprise-free), and `role-permission-audit.ts` must validate `operand`
     and `logicalOperator` using local string sets without importing
     `'twenty-shared/types'`.
