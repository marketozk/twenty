# LOG-205 Independent Design Review

## Verdict
APPROVED WITH MANDATORY REVISIONS (3 Blocker, 6 Major, 4 Minor - all resolved below before implementation).

## Findings and Resolutions

### Blocker
1. **B1 - Missing claim/lifecycle (`IN_PROGRESS`, `attempts`, `MAX_ATTEMPTS`, `FAILED`) in `reconcileFilesFieldHardDeleteIntentsWithAudit`**
   - Problem: `DeferredWorkspaceMigrationActionRunnerService.claimAndExecute` skips claim/attempt/fail handling when `handler.managesOwnPersistence === true`. Without atomic claiming, concurrent workers race on `deleteFileObject` and any permanent failure causes permanent head-of-line blocking of the workspace deferred action queue.
   - Resolution: Mirror `match-participant.service.ts` lifecycle:
     - Fence any `PENDING` intent with `payload ? 'unsafeOutcome'` to `status = 'FAILED'` and throw.
     - Atomically claim each intent: `UPDATE core."deferredWorkspaceMigrationAction" SET status='IN_PROGRESS', attempts=attempts+1, "startedAt"=now(), "updatedAt"=now() WHERE id=$1 AND "workspaceId"=$2 AND name=$3 AND status='PENDING' AND NOT (payload ? 'unsafeOutcome') RETURNING id, payload, attempts`; skip if 0 rows returned.
     - Inside the strict transaction verify `status = 'IN_PROGRESS'`.
     - On invalid payload immediately mark `status = 'FAILED'`, `"startedAt" = NULL`, `"lastError" = ...`.
     - On `isTransactionUnsafeToRetry(error)` mark `status = 'FAILED'`, `"startedAt" = NULL`, `"lastError" = ...`, `payload = jsonb_set(payload, '{unsafeOutcome}', ...)`.
     - On other errors release to `attempts >= DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS ? 'FAILED' : 'PENDING'`, `"startedAt" = NULL`, `"lastError" = ...`.

2. **B2 - Enterprise boundary violations from importing Enterprise-reachable modules into `files-field-hard-delete-audit.ts`**
   - Problem: `twenty-shared/types`, `file-storage-exception.ts`, `remove-file-folder-from-file-entity-path.utils.ts`, and `deferred-workspace-migration-action.type.ts` are all `runtime_enterprise_reachable = True`.
   - Resolution: Do NOT import any of those 4 modules in `files-field-hard-delete-audit.ts` or `DeleteFilesFieldFilesDeferredActionHandlerService`. Use literal `'files-field'`, `row.path.slice('files-field/'.length)`, structural `(error as { code?: unknown })?.code === 'FILE_NOT_FOUND'`, and identifier token `@Inject(FILES_FIELD_HARD_DELETE_RECONCILIATION)` (never a string literal). Safe imports confirmed `in_enterprise_reachable = False`: `native-crm-audit-record.ts`, `enqueue-deferred-workspace-migration-actions.ts`, `deferred-workspace-migration-action-name.type.ts`, `deferred-workspace-migration-action-handler.decorator.ts`, `deferred-workspace-migration-action-max-attempts.constant.ts`, `is-transaction-outcome-unknown.ts`.

3. **B3 - `MERGE_MANY` when priority record has empty `FILES` and a duplicate has non-empty `FILES`**
   - Problem: `performDeepMerge` copies duplicate `FILES` onto `priorityRecord`, then deletes duplicates (retiring the `fileId`) before updating `priorityRecord` (which would fail in `FilesFieldSync` anyway because permanent files cannot be `toAdd`-attached).
   - Resolution: In `CommonMergeManyQueryRunnerService.executeMergeWithinScope` (before deleting duplicates), check every `FILES` field: if `resolvedMergedData` introduces a `fileId` not already on `priorityRecord`, fail closed deterministically with `CommonQueryRunnerException(..., BAD_REQUEST)` before any mutation. When `priorityRecord` already owns its own `FILES` (or only `CASCADE` children of duplicates have `FILES`), duplicate/child `FILES` are retired and durably hard-deleted through the new owner.

### Major
1. **M1 - Silent file leak in `TrashCleanupService` when `FilesFieldDeletionListener` gates solely on `isNativeCrmAuditMetadata`**
   - Problem: `TrashCleanupService` hard-deletes covered records without `nativeAudit`, so no `delete_filesFieldFiles` intent is created.
   - Resolution: In `FilesFieldDeletionListener.handleDestroyedEvent`, for covered objects inspect `core.file` for the destroyed `fileIds` (with `withDeleted: true`):
     - Any `fileId` still active (`deletedAt === null`) came from an un-audited path (`TrashCleanupService`) and stays routed to `FilesFieldDeletionJob`.
     - If any `fileId` is already retired (`deletedAt !== null` and `settings?.toDelete === true`) OR if a `PENDING` `delete_filesFieldFiles` intent exists for `workspaceId` (also closing **M3** for `CASCADE`-only `FILES`), enqueue `RunDeferredWorkspaceMigrationActionsJob` via `enqueueDeferredWorkspaceMigrationActions`.

2. **M2 - `FilesFieldDeletionJob` retry loop after partial batch failure due to `findOneOrFail`**
   - Resolution: In `FilesFieldService.deleteFilesFieldFile`, check `fileRepository.findOne(workspaceId, { where: { id: fileId, path: Like(`${FileFolder.FilesField}/%`) } })` first and return idempotently when already deleted/soft-deleted before calling `deleteByFileId`.

3. **M3 - `CASCADE`-only `FILES` (and `shouldSkipEventEmission: true`) immediate enqueue**
   - Resolution: Handled in M1 via cheap indexed check (`WHERE "workspaceId"=$1 AND name='delete_filesFieldFiles' AND status='PENDING' LIMIT 1`) in `FilesFieldDeletionListener` on any covered `DESTROYED` event; `shouldSkipEventEmission: true` relies on durable `DeferredWorkspaceMigrationActionRecoveryCronJob` (documented explicitly).

4. **M4 - Fixture `coreSchema: 'fork'` (not `'full'`) and missing `core.file` in existing delete specs**
   - Resolution: New spec uses `coreSchema: 'fork'` + explicit `core.application` / `core.file` DDL and grants. Existing delete specs (`crm-audit-native-delete`, `crm-audit-delete-set-null`, `crm-audit-public-destroy`, `crm-audit-public-merge`) get minimal `core.file` DDL + grants so their invalid/missing `fileId` cases verify `'Native file is missing, deleted or outside this workspace'` cleanly.

5. **M5 - Incomplete fail-closed checks in `prepareNativeCrmDeleteFiles`**
   - Resolution: Also select `"applicationId"` and enforce `row.status === 'UPLOADED'`, `row.path.startsWith('files-field/') && row.path.length > 'files-field/'.length`, `row.settings?.isTemporaryFile !== true`, `row.settings?.toDelete !== true`, and `UUID` `row.applicationId` (also verified in reconciler before querying `core.application`).

6. **M6 - `CoreAuditPostCommitError` not treated as unsafe outcome**
   - Resolution: Use `isTransactionUnsafeToRetry(error)` in `reconcileFilesFieldHardDeleteIntentsWithAudit`.

### Minor
- **m1**: Pass TypeORM `runner` directly to `new CrmAuditTransactionContext(runner, operation)` (no `createCrmAuditQueryRunnerExecutor`).
- **m2**: Guard `before !== null && after === null` for `crmFile:delete` in `descriptor()` with `hasSnapshots` so `appendCrmAuditAttempt` continues to work.
- **m3**: Update `prepareNativeCrmDeleteEffects` to return `{ cascadeTargets, apply: (deletedParentIds: string[]) => Promise<Map<string, string[]>> }` so `workspace-repository.ts` locks all parent + `CASCADE` child `core.file` rows in one canonical `ORDER BY id FOR UPDATE` and applies retirement after `recordNativeCrmDeletes` + `nativeDeleteEffects.apply`.
- **m4**: Validate `Number.isSafeInteger(bytes) && bytes >= 0` for raw SQL `bigint` `size` before `releaseStorageStock`, and use identical `settings::text AS "settingsSnapshot", to_jsonb("deletedAt")::text AS "deletedAtSnapshot"` projections so `crmFile:delete.before` matches `crmFile:update.after`.
