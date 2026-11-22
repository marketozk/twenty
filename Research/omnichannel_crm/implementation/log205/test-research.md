# LOG-205 Test Research

## Real-Path Verification Targets (PostgreSQL 17 on Schrodinger)

### New Suite: `packages/twenty-server/test/fork-migration/crm-audit-file-hard-delete.postgres-spec.ts`
Uses `createOmniNativeMessageFixture` with `coreSchema: 'full'` (real `core.workspace`, `core."deferredWorkspaceMigrationAction"`, `core.application`, `core.file`, `crm_audit."crmAuditEntry"`, plus `company`, `opportunity`, `customCase` with `FILES` columns and `ON DELETE CASCADE` FK).

1. **End-to-end parent & `CASCADE` child `FILES` hard-delete (`DESTROY_ONE`, `DESTROY_MANY`, `MERGE_MANY`, `workspaceRepository.delete`)**:
   - Parent `company` with `files-field/...` file AND `ON DELETE CASCADE` `_customCase` child with `files-field/...` file -> single `DELETE`/`DESTROY`/`MERGE` transaction atomically:
     - deletes parent + `CASCADE` child (`crmRecord:delete`),
     - soft-marks both `core.file` rows (`deletedAt IS NOT NULL`, `settings = { isTemporaryFile: false, toDelete: true }`),
     - writes `crmFile:update` entries under the same `operationId` with exact `fileParent` (`objectMetadataId`, `recordId`, `fieldMetadataId`) and zero leaked filenames/paths/labels,
     - persists ONE durable `PENDING` intent `delete_filesFieldFiles` in `core."deferredWorkspaceMigrationAction"` with `sourceOperationId`, `correlationId`, and sorted `files`.
   - Running `reconcileFilesFieldHardDeleteIntentsWithAudit` (and through `DeleteFilesFieldFilesDeferredActionHandlerService` / `DeferredWorkspaceMigrationActionRunnerService`):
     - deletes storage objects via `deleteFileObject`,
     - deletes both `core.file` rows in strict transactions,
     - emits `crmFile:delete` audit entries with `actor: system:files_field_hard_delete`, `correlationId` matching the original `DESTROY`, `causationId` matching `sourceOperationId`, `before` redacted snapshot, `after: null`, `fileParent`, and `deletedRecord: { access: 'currentWorkspaceAdministration' }`,
     - removes the completed `delete_filesFieldFiles` intent from `core."deferredWorkspaceMigrationAction"`,
     - releases storage stock post-commit (`releaseStorageStock`).
2. **Fail-closed guards and rollback**:
   - Missing `core.file`, already soft-deleted `core.file`, foreign-workspace `core.file`, `status = 'PENDING'`, non-`files-field/` path (e.g. `workspace-logo/...`), duplicate `fileId` across parent and `CASCADE` child, malformed `FILES` JSON -> refuse before `DELETE`, zero mutations, zero audit rows, zero durable intents.
   - `BEFORE DELETE` trigger skipping a parent row -> its `core.file` row stays completely untouched (`deletedAt IS NULL`, `toDelete: false`), no `crmFile:update`, no durable intent for the skipped row's file.
   - Reconciler refuses live `core.file` (`deletedAt IS NULL`), `toDelete: false`, non-`files-field/` path, and missing `core.application` without deleting storage or DB rows.
   - `crmFile:delete` descriptor rejects missing `deletedRecord`, missing `fileParent`, or `deletedRecord` on `crmFile:update`.
3. **Failure modes, idempotency, lost `COMMIT` ACK, and listener/job behavior**:
   - Storage deletion transient error on file #2 of a 2-file intent -> file #1 committed (`crmFile:delete`, `nextFileIndex = 1`), file #2 remains in `core.file`, intent stays `PENDING` at `nextFileIndex = 1`; retry completes file #2 (`FILE_NOT_FOUND` treated idempotently) without duplicate `crmFile:delete` for file #1.
   - Already-removed `core.file` row on replay -> advances/removes intent without false `crmFile:delete`.
   - Lost `COMMIT` ACK during strict hard-delete transaction -> throws `NativeTransactionOutcomeUnknownError`, does NOT call `releaseStorageStock`, marks intent with `payload.unsafeOutcome` + `status = 'FAILED'`, and `DeferredWorkspaceMigrationActionRecoveryService` (`resetStaleInProgressActions`, `enqueueWorkspacesWithPendingActions`, `retryFailedActions`) refuses to auto-retry it.
   - Inactive/deleted workspace -> cleans non-fenced `PENDING` intent and refuses fenced `unsafeOutcome` intent.
   - `FilesFieldDeletionListener`: covered object enqueues `RunDeferredWorkspaceMigrationActionsJob` on `workspaceQueue` (NOT `FilesFieldDeletionJob`); uncovered object enqueues `FilesFieldDeletionJob`. `FilesFieldDeletionJob` rethrows failures instead of swallowing them.

### Existing Suites to Re-verify
- `crm-audit-native-files.postgres-spec.ts`
- `crm-audit-native-delete.postgres-spec.ts`
- `crm-audit-delete-set-null.postgres-spec.ts`
- `crm-audit-public-destroy.postgres-spec.ts`
- `crm-audit-public-merge.postgres-spec.ts`
- `crm-audit-import-matching-deferred-runner.postgres-spec.ts`
- Full PG regression (`141/141` suites).
