# LOG-209 Code Review

## Verdict

- Round 1 (independent adversarial review): `NEEDS_REVISION` (0 Blocker, 5 Major, 3 Minor).
- Round 2 (verification of fixes): `NEEDS_REVISION` on 1 test sub-case (`task` `duplicateCriteria` + `transactionScope` propagation in subtest 4; production code clean).
- Final state after subtest 4/5 fixes and real PostgreSQL 17 re-run: `PASS`.

## Findings and Resolutions

### Major

1. **Fail-open on missing ownership column or future `OMNI_NATIVE_REPOSITORIES` table in `assertChildMutationAllowed`**
   - File: `packages/twenty-server/src/engine/twenty-orm/repository/workspace-repository.ts`
   - Resolution: Explicitly require `row.messageId !== undefined` for `messageParticipant` and `row.messageThreadId !== undefined` for `messageThreadTarget` (throwing `OMNI_INVALID_NATIVE_OWNERSHIP_REFERENCE` on missing column), and fail closed with `OMNI_INVALID_NATIVE_OWNERSHIP_SCOPE` for any other `OMNI_NATIVE_REPOSITORIES` table.
2. **Untested `setNullBefore` omni refusal branch in `prepareNativeCrmDeleteEffects`**
   - Files: `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-delete-effects.ts`, `packages/twenty-server/test/fork-migration/crm-audit-fk-delete-effects-coverage.postgres-spec.ts`
   - Resolution: Added `messageParticipant.targetCustomCase` (`ON DELETE SET NULL` -> `_customCase`) in the PG 17 test fixture so `findOmniProtectedParentIds` does not short-circuit and `assertChildMutationAllowed(group.shape, setNullBefore, 'set-null')` throws `OMNI_NATIVE_MUTATION_REQUIRES_DOMAIN_COMMAND` with post-rollback `denied` audit (`crm.mutation.domain_command_required`).
3. **Real `FilesFieldDeletionListener.handleDestroyedEvent` wakeup path untested for parent without own `FILES` fields**
   - File: `packages/twenty-server/test/fork-migration/crm-audit-fk-delete-effects-coverage.postgres-spec.ts`
   - Resolution: Added `company` destroy with cascaded `attachment.file`, invoked `FilesFieldDeletionListener.handleDestroyedEvent` with the emitted `company.destroyed` batch, and asserted `workspaceQueue` receives `RUN_DEFERRED_WORKSPACE_MIGRATION_ACTIONS_JOB_NAME` while legacy `deleteCascadeQueue` is not called, followed by full intent reconciliation.
4. **Live `attachment` with populated `FILES` field untested during `MERGE_MANY` migration**
   - File: `packages/twenty-server/test/fork-migration/crm-audit-fk-delete-effects-coverage.postgres-spec.ts`
   - Resolution: Seeded a real `core.file` on `liveAttachmentId` and verified post-merge that `core.file` stays `status = 'UPLOADED'`, `deletedAt IS NULL`, `settings.toDelete === false`, with no `crmFile` audit entry and no hard-delete intent.
5. **Missing regression for uncovered parent `MERGE_MANY` inside proven outer `nativeAudit` scope and post-rollback `denied` check on omni-owned child merge**
   - File: `packages/twenty-server/test/fork-migration/crm-audit-fk-delete-effects-coverage.postgres-spec.ts`
   - Resolution: Added `task` `duplicateCriteria` and `transactionScope` forwarding to test both `mergeMany.execute(..., queryContext('task', scope))` and direct `mergeMany.run(...)` inside proven `nativeAudit` scope (failing closed with `Native audit coverage excludes this object or mutation`), plus asserted post-rollback `outcome: 'denied'` / `reasonCode: 'crm.mutation.domain_command_required'` on omni-owned `messageThreadTarget` merge refusal.

### Minor

1. **Narrow `NativeCrmMergeChildGrant` to least-privilege discriminated union**
   - Files: `native-crm-audit-transaction.ts`, `native-crm-audit-record.ts`, `common-merge-many-query-runner.service.ts`
   - Resolution: Split grant into `{ objectMetadataId, kind: 'soft-delete' }` for `idsToSoftDelete` and `{ objectMetadataId, kind: 'update', allowedJoinColumnName, allowedTargetRecordId: priorityRecordId }` for `idsToMigrate`, with negative PG 17 tests for wrong target ID and `update` under a `soft-delete` grant.
2. **Use `Object.hasOwn` for `shape.columnShapeByColumnName` lookup**
   - File: `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-record.ts`
   - Resolution: Guarded both `allowFkChildDeleteEffect` and `mergeGrant` column lookups with `Object.hasOwn(shape.columnShapeByColumnName, columnName)`.
3. **Missing RBAC refusal test on child table during `MERGE_MANY`**
   - File: `packages/twenty-server/test/fork-migration/crm-audit-fk-delete-effects-coverage.postgres-spec.ts`
   - Resolution: Added `taskTarget: { canUpdateObjectRecords: false }` test asserting `PermissionsExceptionMessage.PERMISSION_DENIED`, rollback of `company`, `0` success audit rows, and post-rollback `denied` entry.

## Post-Fix Verification

- Targeted PG 17 suites: 10/10 PASS, 233/233 tests (re-run of `crm-audit-fk-delete-effects-coverage.postgres-spec.ts`: 5/5 PASS in 12.364 s).
- Differential typecheck (`ts 5.8.3`): `pass-no-new-diagnostics` (`baselineDiagnostics: 274`, `currentDiagnostics: 274`, `0` new/changed-file/changed-code).
- Guards: `check_enterprise_dependencies.py --verify-baseline` PASS (`0` violations, `34819` code files, `21468` runtime files, `137987` edges), `10` fork migration sources verified, `33/33` Python unit tests OK.
