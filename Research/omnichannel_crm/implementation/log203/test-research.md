# LOG-203 Test Research

## New PostgreSQL Test Suite
`packages/twenty-server/test/fork-migration/crm-audit-public-merge.postgres-spec.ts`

Built on the real PostgreSQL 17 harness (`createOmniNativeMessageFixture` + `addCustomCrmMetadata` + `CommonMergeManyQueryRunnerService`), with `duplicateCriteria` enabled on `company`, `person`, `customCase`, and uncovered `task` (and inactive child tables removed/deactivated in metadata so only fixture-created tables are queried by `getRelationFieldsPointingToCurrentObject`), covering:

1. **Happy-path `mergeMany` across covered standard (`company`, `person`) and custom (`customCase`) objects, `dryRun: true`, getter `dryRun` bypass protection, uppercase UUIDs, empty `mergedData`, `selectedFields` without `id`, all 5 actor types, 3-record merge, and `validate()`**:
   - Merges 2 and 3 records (`conflictPriorityIndex` = 0 and non-zero), including uppercase UUIDs in `args.ids`, empty `mergedData = {}`, and `selectedFields: { name: true }` without `id`.
   - Verifies priority record retains/merges fields, duplicates are physically deleted, `action: 'delete'` (with `deletedRecord: { access: 'currentWorkspaceAdministration' }`) + `action: 'update'` share ONE `operationId`, private values are redacted, `releaseRecordStock` called with `quantity: idsToDelete.length`, `managerPort.getRepository` never called, and post-query hooks run after commit.
   - Verifies all 5 actor kinds (`user`, `apiKey`, `application`, `agent`, `system` -> `systemActorId: 'crm-api-merge'`).
   - Verifies `dryRun: true` (including with nested `relations`) leaves DB unchanged, writes `0` audit rows, and reads relations via `queryRunnerContext.repository`.
   - Verifies mutable getter `dryRun` (`true` on first read, `false` on second read) cannot bypass audit (B1) and stays consistent as `dryRun: true` with `0` mutations.
   - Verifies `validate()` rejects remote objects, object without `duplicateCriteria`, non-array `ids` (`"abcdef"`), non-string `ids` elements (`[null, 123]`), `< 2` IDs, `> MUTATION_MAX_MERGE_RECORDS`, invalid UUIDs, duplicate IDs (case-insensitive), non-integer / out-of-range `conflictPriorityIndex`, and non-boolean `dryRun` (`"false"`) - all with `INVALID_QUERY_INPUT` and `0` audit rows.
   - Verifies missing or soft-deleted record IDs fail with `RECORD_NOT_FOUND` and `0` audit rows.

2. **Related-record migration, duplicate soft-delete, soft-deleted FK effects, transactional nested relation read, `select`-RLS hidden child refusal (B2), trigger skips, and fail-closed boundaries**:
   - Merging two `company` records where duplicate has:
     - live `person` rows (migrated via `update` to `priorityRecordId`),
     - live `customCase` rows colliding on a unique index `(companyId, code)` with priority's `customCase` (duplicate `customCase` gets `soft_delete`, non-colliding `customCase` gets `update`),
     - soft-deleted `person` row with `ON DELETE SET NULL` (audited as `update` by `prepareNativeCrmDeleteEffects`):
     all child `update`/`soft_delete` + duplicate `company:delete` + priority `company:update` commit under ONE `operationId`; DB state matches exactly; `selectedFields: { id: true, name: true, people: { id: true } }` reads migrated `people` inside the same transaction without calling `managerPort.getRepository`.
   - `select`-RLS hidden live child refusal (B2): when a live `person` pointing to `duplicateCompany` (with `ON DELETE SET NULL`) or live `customCase` (with `ON DELETE CASCADE`) is hidden by `select`-RLS, `mergeMany` rejects fail-closed with `RECORD_NOT_FOUND`, leaving parent and hidden child completely untouched (no `SET NULL`, no `CASCADE`) and `0` audit rows.
   - Fail-closed refusals (all leave DB completely untouched - including no migrated children - with `0` audit rows and no post-query hooks):
     - uncovered live child row in `taskTarget` pointing to duplicate `company` (`Native audit coverage excludes this object or mutation`);
     - uncovered soft-deleted FK child table (`delete_child` with `ON DELETE CASCADE`) pointing to duplicate `company` (`excludes referenced`);
     - non-empty `FILES` on duplicate `company` (`excludes linked files`), while non-empty `FILES` on `priorityRecord` alone (with valid `core.file`) succeeds;
     - omni-protected duplicate `person` (`core."omniExternalIdentity"` -> `OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND`).
   - Trigger skips: `BEFORE DELETE` trigger skip on duplicate `company`, `BEFORE UPDATE` trigger skip on migrating child `person`, and `BEFORE UPDATE` trigger skip on soft-deleting duplicate `customCase`: all fail closed with `RECORD_NOT_FOUND`, rolling back all migrated children and priority updates with `0` audit rows.

3. **Permissions, RLS predicates, outer `withNativeCrmAuditTransaction` aggregation + real `CommonRecordVisibilityService` masking, and inherited scope poisoning**:
   - Permission denials: `canDestroyObjectRecords: false` (even with `canUpdateObjectRecords: true`) and `canUpdateObjectRecords: false` (even with `canDestroyObjectRecords: true`) both fail with `PermissionsException(PERMISSION_DENIED)` and roll back migrated children with `0` audit rows.
   - Inside an outer proven `withNativeCrmAuditTransaction` that already updated `priorityCompany.name = 'uncommitted outer'`, `mergeMany` sees `'uncommitted outer'`, aggregates outer + merge `priorityCompany` updates (`first-before / last-after`) with child migrations and duplicate delete under ONE `operationId`, runs real registered `CommonRecordVisibilityService` masking on nested `people` records, and defers post-query hooks until outer commit.
   - Inherited scope fail-closed & poisoning: plain external `transactionScope`, `runInStandaloneShareWithScope`, shallow copy `{ ...scope }`, expired scope, wrong actor + wrong `workspaceId` poisoning when caught, `RECORD_NOT_FOUND` poisoning inside outer scope, and uncovered object `task` (with `duplicateCriteria`) works outside scope with `0` audit rows and fails closed + poisons inside outer proven scope (while `dryRun: true` inside outer scope remains read-only with `0` audit rows).

4. **Real audit INSERT failure rollback and lost `COMMIT` ACK**:
   - Trigger failure on `crm_audit."crmAuditEntry"` rolls back child migrations, child soft-deletes, duplicate physical delete, and priority update completely; emits `0` events, skips `releaseRecordStock` and post-query hooks.
   - Simulated lost `COMMIT` ACK throws `NativeTransactionOutcomeUnknownError` without `ROLLBACK` or retry, leaves committed merge + all audit entries intact, and skips events / post-query hooks.

## Existing Suites to Verify
- `test/fork-migration/crm-audit-public-destroy.postgres-spec.ts`
- `test/fork-migration/crm-audit-public-update.postgres-spec.ts`
- `test/fork-migration/crm-audit-native-delete.postgres-spec.ts`
- `test/fork-migration/crm-audit-delete-set-null.postgres-spec.ts`
- Full PostgreSQL regression suite on Schrodinger.
