# LOG-205 Independent Code Review

## Verdict
PASS (after addressing 3 Major and 3 Minor findings; 0 Blocker).

## Scope Reviewed
- `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-transaction.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/files-field-hard-delete-audit.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-files.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-delete-effects.ts`
- `packages/twenty-server/src/engine/twenty-orm/repository/workspace-repository.ts`
- `packages/twenty-server/src/engine/api/common/common-query-runners/common-merge-many-query-runner.service.ts`
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/types/deferred-workspace-migration-action-name.type.ts`
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/types/deferred-workspace-migration-action.type.ts`
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/deferred-action-handlers/services/delete-files-field-files-deferred-action-handler.service.ts`
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/registry/deferred-workspace-migration-action-handler-registry.service.ts`
- `packages/twenty-server/src/engine/core-modules/file/files-field/services/files-field.service.ts`
- `packages/twenty-server/src/engine/core-modules/file/files-field/files-field.module.ts`
- `packages/twenty-server/src/engine/core-modules/file/files-field/listeners/files-field-deletion.listener.ts`
- `packages/twenty-server/src/engine/core-modules/file/files-field/jobs/files-field-deletion.job.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-file-hard-delete.postgres-spec.ts` and 4 updated delete/destroy/merge PG specs.

## Findings and Resolutions

### Blocker
None.

### Major
1. **Missing `attempts` fencing token and reopening of `unsafeOutcome` in `reconcileFilesFieldHardDeleteIntentsWithAudit`**
   - Location: `files-field-hard-delete-audit.ts`.
   - Issue: `FOR UPDATE` inside `runInCoreAuditTransaction`, `markIntentFailed`, and `releaseClaimedIntent` checked `status = 'IN_PROGRESS'` without fencing on `attempts = claimedAttempts`, and `releaseClaimedIntent` did not exclude `payload ? 'unsafeOutcome'`. Under a stale-recovery race, a stalled worker could commit over or release a newer worker's claim, and an in-transaction `unsafeOutcome` discovery could reopen the intent to `PENDING`.
   - Resolution: selected and enforced `Number(lockedIntent[0].attempts) === attempts` in all transactional `FOR UPDATE` / `UPDATE` / `DELETE` queries; added `AND attempts = $6 AND NOT (payload ? 'unsafeOutcome')` to `releaseClaimedIntent` and `AND status = 'IN_PROGRESS' AND attempts = $5` to `markIntentFailed`; introduced `TerminalFilesFieldIntentError` so concurrent `unsafeOutcome` or corrupt payload discovered inside a transaction marks the intent `FAILED` immediately without reopening to `PENDING`. Added PG regression tests for both stale-recovery fencing and concurrent `unsafeOutcome`.

2. **Non-UUID / malformed `FILES` values in `FilesFieldDeletionListener` broke the entire `DESTROYED` batch**
   - Location: `files-field-deletion.listener.ts`.
   - Issue: passing unvalidated `fileId` strings to `ANY($2::uuid[])` or iterating non-array `FILES` values threw before enqueuing either deferred actions or `FilesFieldDeletionJob` for other valid records in the same batch.
   - Resolution: guarded `recordBefore`, `Array.isArray(filesValue)`, object items, and `isValidUuid(candidateId)` (normalizing lowercase), warning and skipping malformed entries so valid files in the batch are never dropped. Added PG regression test with mixed invalid/valid entries.

3. **`MERGE_MANY` did not check for shared `fileId` between `priorityRecord` and deleted duplicates (including under `restrictedFields`)**
   - Location: `common-merge-many-query-runner.service.ts`.
   - Issue: if `priorityRecord` and a duplicate referenced the same `fileId` (especially when the `FILES` field was hidden by `restrictedFields`), deleting the duplicate retired/hard-deleted the file still referenced by `priorityRecord`.
   - Resolution: extracted `assertMergeFilesSupported` (rejecting both duplicate-to-empty-priority transfer and shared `fileId` across priority and duplicates) and added `assertNoSharedFilesAcrossLockedRows` reading raw `FILES` columns on the locked rows inside the transaction (bypassing `restrictedFields`) to refuse shared `fileId` deterministically with `BAD_REQUEST`. Added PG regression test.

### Minor
1. **`dryRun: true` divergence in `CommonMergeManyQueryRunnerService`**
   - Resolution: invoked `assertMergeFilesSupported` in the `dryRun: true` branch as well so dry-run preview matches live merge behavior. Added PG regression test.

2. **Incomplete fail-closed checks on `raw === undefined`, `settings === null`, and `status !== 'UPLOADED'`**
   - Resolution: in `prepareNativeCrmDeleteFiles`, throw on `raw === undefined` and require `row.settings?.isTemporaryFile === false && row.settings?.toDelete === false`; in `assertRetirableFileRow`, select and require `row.status === 'UPLOADED'` and `row.settings?.isTemporaryFile !== true`. Added `settings: null` PG test case.

3. **Terminal handling of malformed payload inside transaction**
   - Resolution: `parseLockedIntentPayload` wraps malformed payload / `unsafeOutcome` in `TerminalFilesFieldIntentError`, marking the intent `FAILED` immediately rather than retrying. Monotonic `attempts` is preserved as the strict fencing token.

## Post-Fix Verification
- Enterprise dependency guard: `status: pass`, `0` violations.
- Migration source guard: `10` sources verified, `33/33` Python guard tests OK.
- Targeted PostgreSQL 17 suites: `7/7` suites, `156/156` tests passed (`52.486s`).
- Differential typecheck: `status: pass-no-new-diagnostics`, `0` new/changed-file/changed-code diagnostics.
