# LOG-205 Design - Transactional Audit and Durable Hard-Delete Owner for Covered CRM `FILES`

## 1. Problem Statement and Boundary
Under `ROB-765` (`Research/omnichannel_crm/implementation/rob765-progress.md`, row `File hard-delete`), covered CRM `CREATE`/`UPDATE` mutations already synchronize `core.file` on the same transaction executor and emit `crmFile:update` audit entries (`LOG-092`/`093`/`096`). However, physical record deletion (`WorkspaceRepository.delete`, public `DESTROY_ONE`/`DESTROY_MANY`, and `MERGE_MANY` duplicate removal) currently fails closed whenever any deleted parent record or `ON DELETE CASCADE` child has a non-empty `FILES` column (`assertNativeCrmDeleteFilesEmpty` throws `'Native audit delete excludes linked files'`). Meanwhile, the stock `FilesFieldDeletionListener` only reacts post-commit through in-memory `EventEmitter` and enqueues `FilesFieldDeletionJob`, which:
- is lost on process crash or Redis failure after `COMMIT`,
- misses `ON DELETE CASCADE` child `FILES` links,
- runs `FileStorageService.deleteByFileId` without any `crmFile:delete` audit entry,
- fails on already soft-deleted `core.file` rows (`findOneOrFail` filters `deletedAt IS NULL`), and
- swallows per-file errors silently (`catch { this.logger.log(...) }`).

`LOG-205` closes this boundary by introducing:
1. `crmFile:delete` audit descriptor validation in `crm-audit-transaction-context.ts` (preserving `fileParent` and requiring `deletedRecord: { access: 'currentWorkspaceAdministration' }`).
2. Transactional `FILES` retirement + durable `delete_filesFieldFiles` intent persistence inside the same database transaction as covered CRM `DELETE` (covering both deleted parent rows and `ON DELETE CASCADE` child rows, respecting `BEFORE DELETE` triggers that skip rows).
3. A durable post-commit hard-delete owner (`files-field-hard-delete-audit.ts` + `DeleteFilesFieldFilesDeferredActionHandlerService`) executing storage deletion + strict audited `DELETE FROM core.file` + `crmFile:delete` + atomic intent advancement/deletion + `unsafeOutcome` fencing on lost `COMMIT` ACK + post-commit storage stock release.
4. Wiring `FilesFieldDeletionListener` (enqueue durable deferred actions instead of un-audited `FilesFieldDeletionJob` for covered objects) and hardening `FilesFieldDeletionJob` error propagation for uncovered objects.

Out of scope for `LOG-205`:
- Changing `UPDATE` `toRemove` behavior (covered `UPDATE` already soft-deletes `core.file` and audits `crmFile:update`; adding durable physical deletion for `toRemove` requires verifying all existing `coreSchema: 'audit'` fixtures that do not provision `core."deferredWorkspaceMigrationAction"` and can be added in a dedicated follow-up if needed).
- Uncovered non-CRM file folders (`WorkspaceLogo`, `RecordExport`, `PendingFileCleanupService`, `FileWorkspaceFolderDeletionJob`).
- Internal messaging/calendar cleanup owners that already assert `assertNativeCrmDeleteFilesEmpty` on tables without `FILES` fields (keep `assertNativeCrmDeleteFilesEmpty` intact for them).

## 2. Architecture and Invariants

### 2.1 `crmFile:delete` Security Descriptor (`crm-audit-transaction-context.ts`)
- `crmFile` policy remains `{ values: [], redacted: ['settings', 'deletedAt'] }` (no filenames, paths, or labels ever enter audit payloads).
- `descriptor()` allows `crmFile` for:
  - `action === 'update'`: exact `fileParent: { objectMetadataId, recordId, fieldMetadataId }`, NO `deletedRecord`, NO `objectMetadataId`/`bindingId`/`conversationId`/`queueId`/`deletedParent` (preserves 100% of existing `crm-audit-native-files` tests).
  - `action === 'delete'`: `before !== null` and `after === null`, exact `fileParent: { objectMetadataId, recordId, fieldMetadataId }` AND exact `deletedRecord: { access: 'currentWorkspaceAdministration' }`, NO other scope fields.
- Existing negative checks for `crmFile:update` (including rejecting `deletedRecord` on `update`) remain strict.

### 2.2 Transactional File Retirement and Durable Intent on Covered `DELETE`
Files: `native-crm-audit-files.ts`, `native-crm-audit-delete-effects.ts`, `workspace-repository.ts`.

1. **Unified pre-delete capture & lock (`prepareNativeCrmDeleteFiles`)**:
   - Inputs: `executor`, `workspaceId`, `targets: Array<{ shape: NativeCrmAuditTableShape; before: ObjectRecord[] }>` (both the parent table and every `ON DELETE CASCADE` child group from `prepareNativeCrmDeleteEffects`).
   - Parses every `FILES` column on every target row:
     - `null` or `[]` -> ignored.
     - Otherwise must be a JSON array of objects, each with a valid UUID `fileId` (normalized lowercase).
     - Duplicate `fileId` across any row/field/table in the delete batch -> fail closed (`'Native file must have one unambiguous owner'`).
   - **Zero-file fast path**: if `owners.size === 0`, returns a no-op `{ apply: async () => undefined }` immediately without touching `core.file` or `core."deferredWorkspaceMigrationAction"`.
   - **Non-empty path**:
     - Acquires row locks on `core.file` in canonical `ORDER BY id FOR UPDATE`:
       ```sql
       SELECT id, path, "applicationId", settings, status,
         settings::text AS "settingsSnapshot",
         to_jsonb("deletedAt")::text AS "deletedAtSnapshot",
         to_jsonb(file)::text AS "rowSnapshot"
       FROM core.file
       WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) AND "deletedAt" IS NULL
       ORDER BY id FOR UPDATE
       ```
     - Validates `rows.length === owners.size` (missing, already soft-deleted, or foreign-workspace file -> fail closed `'Native file is missing, deleted or outside this workspace'`).
     - Validates every locked row has `row.status === 'UPLOADED'`, `typeof row.path === 'string' && row.path.startsWith('files-field/') && row.path.length > 'files-field/'.length`, `row.settings?.isTemporaryFile !== true`, `row.settings?.toDelete !== true`, and a valid UUID `row.applicationId` (M5).
   - `prepareNativeCrmDeleteEffects` returns `{ cascadeTargets, apply: (deletedParentIds: string[]) => Promise<Map<string, string[]>> }` so `workspace-repository.ts` locks all parent + `CASCADE` child `core.file` rows in one canonical query and applies `nativeDeleteFiles.apply(deletedByObjectMetadataId)` after `nativeDeleteEffects.apply` and `recordNativeCrmDeletes` (m3).
   - In `CommonMergeManyQueryRunnerService.executeMergeWithinScope` (before deleting duplicates), if `resolvedMergedData` introduces a `FILES` `fileId` not already on `priorityRecord`, fail closed deterministically with `CommonQueryRunnerException(..., BAD_REQUEST)` (B3).
2. **Post-`DELETE` actual-row application (`apply(deletedIdsByObjectMetadataId)`)**:
   - Takes the actual deleted record IDs for the parent (from `DELETE ... RETURNING id`) AND actual deleted IDs for every `CASCADE` child group (verified absent by `nativeDeleteEffects`).
   - Partitions locked `owners` into `deletedOwners` (whose `(objectMetadataId, recordId)` was actually deleted) and `skippedOwners` (skipped by a `BEFORE DELETE` trigger).
   - For each `[fileId, owner]` in `deletedOwners` sorted by `fileId`:
     - Marks `core.file` for hard deletion:
       ```sql
       UPDATE core.file
       SET "deletedAt"=CURRENT_TIMESTAMP,
           settings='{"isTemporaryFile":false,"toDelete":true}'::jsonb,
           "updatedAt"=CURRENT_TIMESTAMP
       WHERE "workspaceId"=$1 AND id=$2 AND "deletedAt" IS NULL
       RETURNING ...
       ```
     - Verifies `rows.length === 1`.
   - Re-reads all planned `core.file` rows by `id=ANY($2::uuid[])` and verifies:
     - `skippedOwners` rows have unchanged `rowSnapshot`,
     - `deletedOwners` rows have `deletedAtSnapshot !== null`, `settings.isTemporaryFile === false`, `settings.toDelete === true`.
   - Records `crmFile:update` in `CrmAuditTransactionContext` for each `deletedOwner` (same `operationId`, `before: snapshot(beforeRow)`, `after: snapshot(afterRow)`, `securityDescriptor: { resourceKind: 'crmFile', resourceId: fileId, fileParent: { objectMetadataId, recordId, fieldMetadataId } }`).
   - If `deletedOwners.size > 0`:
     - Atomically inserts ONE durable intent into `core."deferredWorkspaceMigrationAction"`:
       ```sql
       INSERT INTO core."deferredWorkspaceMigrationAction"
         (id, "workspaceId", "applicationUniversalIdentifier", name, payload, position, "runByVersion", status, attempts)
       VALUES ($1, $2, $3, $4, $5::jsonb, 0, NULL, 'PENDING', 0)
       RETURNING id
       ```
       - `applicationUniversalIdentifier`: `TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER` (imported from `twenty-shared/application-runtime`, zero Enterprise edges).
       - `name`: `'delete_filesFieldFiles'`.
       - `payload`:
         ```json
         {
           "version": 1,
           "nextFileIndex": 0,
           "sourceOperationId": "<operation.operationId>",
           "correlationId": "<operation.correlationId if defined>",
           "files": [
             {
               "fileId": "<uuid>",
               "objectMetadataId": "<uuid>",
               "recordId": "<uuid>",
               "fieldMetadataId": "<uuid>"
             }
           ]
         }
         ```
         Sorted canonically by `fileId`. Contains zero filenames, labels, or paths.
     - Note on `operation`: `getNativeCrmAuditOperation(executor)` exposes the active transaction's `operationId` and `correlationId` from `native-crm-audit-transaction.ts` (read-only).

### 2.3 Durable Hard-Delete Owner (`files-field-hard-delete-audit.ts`)
- Exported constants and types (zero Enterprise-reachable imports - B2):
  - `FILES_FIELD_HARD_DELETE_INTENT_NAME = 'delete_filesFieldFiles'`
  - `FILES_FIELD_HARD_DELETE_RECONCILIATION = 'FILES_FIELD_HARD_DELETE_RECONCILIATION'`
  - `FilesFieldHardDeleteIntentPayload`
  - `captureFilesFieldHardDeleteIntentPayload(payload: unknown): FilesFieldHardDeleteIntentPayload`
- `reconcileFilesFieldHardDeleteIntentsWithAudit`:
  - Inputs: `{ coreDataSource: DataSource; workspaceId: string; intentId?: string; deleteFileObject: (params: { workspaceId: string; applicationUniversalIdentifier: string; fileFolder: 'files-field'; resourcePath: string }) => Promise<void>; releaseStorageStock: (params: { workspaceId: string; applicationId: string; bytes: number; quantity: number }) => Promise<void> }`.
  - Validates `workspaceId` (and `intentId` if provided) as UUID.
  - Checks `core.workspace` (`SELECT "deletedAt" FROM core.workspace WHERE id=$1`):
    - If workspace is missing or `deletedAt IS NOT NULL`: fences any intent with `payload ? 'unsafeOutcome'` to `FAILED` and throws; deletes non-fenced `PENDING` intents and returns.
  - First fences any `PENDING` intent matching `payload ? 'unsafeOutcome'` to `status='FAILED'`, `"startedAt"=NULL`, `"lastError"=...` and throws `'Files field hard-delete intent fenced by unsafe outcome'` (B1).
  - Loads candidate `PENDING` intent IDs ordered by `"createdAt" ASC, position ASC, id ASC` and **atomically claims** each row via:
    ```sql
    UPDATE core."deferredWorkspaceMigrationAction"
    SET status='IN_PROGRESS', attempts=attempts+1, "startedAt"=now(), "updatedAt"=now()
    WHERE id=$1 AND "workspaceId"=$2 AND name=$3 AND status='PENDING' AND NOT (payload ? 'unsafeOutcome')
    RETURNING id, payload, attempts
    ```
    If 0 rows returned, another worker claimed it (`continue`).
  - For each claimed intent row:
    1. Parses and validates `payload` via `captureFilesFieldHardDeleteIntentPayload`; on invalid payload marks `status='FAILED'`, `"startedAt"=NULL`, `"lastError"=...` immediately and throws (prevents head-of-line queue blocking - B1).
    2. Loops `index` from `payload.nextFileIndex` to `payload.files.length - 1`:
       - Pre-reads `core.file` (`SELECT id, path, size, "applicationId", settings, "deletedAt", settings::text AS "settingsSnapshot", to_jsonb("deletedAt")::text AS "deletedAtSnapshot" FROM core.file WHERE "workspaceId"=$1 AND id=$2`) outside the strict commit transaction.
       - **Case A: `core.file` row already absent** (idempotent replay):
         - Runs `runInCoreAuditTransaction(coreDataSource, ...)`:
           - Locks intent `FOR UPDATE`, verifies `status === 'IN_PROGRESS'`, no `unsafeOutcome`, and `nextFileIndex === index`.
           - Double-checks `core.file` is still absent (`SELECT 1 FROM core.file WHERE "workspaceId"=$1 AND id=$2 FOR UPDATE`).
           - Advances `nextFileIndex = index + 1` or deletes the intent if `index + 1 >= payload.files.length` (no false `crmFile:delete` audit entry!).
       - **Case B: `core.file` row exists**:
         - Validates invariants fail-closed: `row.deletedAt !== null`, `row.settings?.toDelete === true`, `typeof row.path === 'string' && row.path.startsWith('files-field/') && row.path.length > 'files-field/'.length`, and valid UUID `row.applicationId` (M5).
         - Looks up `core.application` (`SELECT "universalIdentifier" FROM core.application WHERE id=$1 AND "workspaceId"=$2`). If missing -> fails closed.
         - Calls `deleteFileObject({ workspaceId, applicationUniversalIdentifier, fileFolder: 'files-field', resourcePath: row.path.slice('files-field/'.length) })`.
           - Treats structural `(error as { code?: unknown })?.code === 'FILE_NOT_FOUND'` as idempotent success.
           - Any other storage error propagates -> intent is released back to `PENDING` (or `FAILED` at `DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS`), `core.file` row stays intact, zero false `crmFile:delete` audit entry.
         - Runs strict DB commit via `runInCoreAuditTransaction(coreDataSource, async (runner) => { ... })`:
           - `await runner.query("SET LOCAL lock_timeout = '8s'")`.
           - Locks intent row `WHERE id=$1 AND "workspaceId"=$2 FOR UPDATE`; checks `status === 'IN_PROGRESS'`, no `unsafeOutcome`, `nextFileIndex === index`.
           - Locks `core.file` `WHERE "workspaceId"=$1 AND id=$2 FOR UPDATE`; re-verifies `deletedAt !== null`, `settings.toDelete === true`, `path.startsWith('files-field/')`.
           - Executes `DELETE FROM core.file WHERE "workspaceId"=$1 AND id=$2 RETURNING id, path, size, "applicationId", settings::text AS "settingsSnapshot", to_jsonb("deletedAt")::text AS "deletedAtSnapshot"`; verifies `rows.length === 1`.
           - Creates `new CrmAuditTransactionContext(runner, operation)` (m1) with `actor: { kind: 'system', id: 'files_field_hard_delete' }`, `operationId: randomUUID()`, `correlationId: payload.correlationId`, `causationId: payload.sourceOperationId`.
           - Records `crmFile:delete` (`before: snapshot(deletedRow)`, `after: null`, `securityDescriptor: { resourceKind: 'crmFile', resourceId: entry.fileId, fileParent: { objectMetadataId, recordId, fieldMetadataId }, deletedRecord: { access: 'currentWorkspaceAdministration' } }`) and flushes `audit.flush()`.
           - Advances `payload.nextFileIndex = index + 1` in `core."deferredWorkspaceMigrationAction"` (or `DELETE FROM core."deferredWorkspaceMigrationAction" WHERE id=$1 AND "workspaceId"=$2` when `index + 1 === payload.files.length`).
         - **Unsafe outcome handling (`isTransactionUnsafeToRetry(error)` - covers `NativeTransactionOutcomeUnknownError` and `CoreAuditPostCommitError` - M6)**:
           - Best-effort marks the intent row (if still present) with `status = 'FAILED'`, `"startedAt" = NULL`, `"lastError" = ...`, and `payload = jsonb_set(payload, '{unsafeOutcome}', ...)` so `DeferredWorkspaceMigrationActionRecoveryService` never auto-retries it.
           - Does NOT call `releaseStorageStock`.
           - Rethrows the unsafe error.
         - **Other error handling (B1)**:
           - Releases claimed intent to `attempts >= DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS ? 'FAILED' : 'PENDING'`, `"startedAt" = NULL`, `"lastError" = ...`, and rethrows.
         - **Post-commit storage stock release**:
           - After `runInCoreAuditTransaction` confirms `COMMIT`, validates `const bytes = Number(deletedRow.size); Number.isSafeInteger(bytes) && bytes >= 0` (m4) and calls `releaseStorageStock({ workspaceId, applicationId, bytes, quantity: 1 })` in best-effort try/catch.

### 2.4 Deferred Action Handler, Registry, Listener, and Job Wiring
- `deferred-workspace-migration-action-name.type.ts` & `deferred-workspace-migration-action.type.ts`:
  - Add `'delete_filesFieldFiles'` to `DeferredWorkspaceMigrationActionName` and `DeferredWorkspaceMigrationActionPayloadByName`.
- New `DeleteFilesFieldFilesDeferredActionHandlerService`:
  - `readonly metadataNamesToLoad = []`, `readonly managesOwnPersistence = true`, `@DeferredWorkspaceMigrationActionHandlerDecorator(FILES_FIELD_HARD_DELETE_INTENT_NAME)`, `@Inject(FILES_FIELD_HARD_DELETE_RECONCILIATION)` (identifier token, no string literal - B2).
- `DeferredWorkspaceMigrationActionHandlerRegistryService`:
  - Adds `metatype === DeleteFilesFieldFilesDeferredActionHandlerService`.
- `FilesFieldModule` & `FilesFieldService`:
  - Adds `reconcileFilesFieldHardDeleteIntentsWithAudit` method on `FilesFieldService` and provides `FILES_FIELD_HARD_DELETE_RECONCILIATION` + `DeleteFilesFieldFilesDeferredActionHandlerService`.
  - Hardens `FilesFieldService.deleteFilesFieldFile` to check `findOne` first and return idempotently when the `core.file` row is already deleted/soft-deleted (M2).
- `FilesFieldDeletionListener` (M1, M3):
  - Injects `@InjectMessageQueue(MessageQueue.workspaceQueue)` and `@InjectDataSource()` (or `FileEntity` repository).
  - For covered objects (`isNativeCrmAuditMetadata(flatObjectMetadata, workspaceId)`):
    - Checks `core.file` (including soft-deleted rows) for `fileIds`: any `fileId` still active (`deletedAt IS NULL`, e.g. from un-audited `TrashCleanupService`) is still enqueued to `FilesFieldDeletionJob` (no silent leak - M1).
    - If any destroyed `fileId` is already retired (`deletedAt IS NOT NULL` and `settings.toDelete === true`), OR if a `PENDING` `delete_filesFieldFiles` intent exists for `workspaceId` (handles `CASCADE`-only `FILES` - M3), enqueues `RunDeferredWorkspaceMigrationActionsJob` via `enqueueDeferredWorkspaceMigrationActions`.
  - For uncovered objects: keeps enqueuing `FilesFieldDeletionJob`.
- `FilesFieldDeletionJob`:
  - Collects per-file failures instead of swallowing them silently, logs them, and rethrows after processing the batch (with M2 idempotency preventing retry loops).

## 3. Enterprise Boundary Check
- Zero imports from `twenty-shared/types`, `file-storage-exception.ts`, `remove-file-folder-from-file-entity-path.utils.ts`, or `deferred-workspace-migration-action.type.ts` inside `files-field-hard-delete-audit.ts` or `DeleteFilesFieldFilesDeferredActionHandlerService` (B2).
- `native-crm-audit-files.ts` uses `TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER` from `twenty-shared/application-runtime` (zero Enterprise edges).
- `FilesFieldDeletionListener` imports only `isNativeCrmAuditMetadata` (`native-crm-audit-record.ts`) and `enqueueDeferredWorkspaceMigrationActions` (`workspace-migration-runner/utils/`) (both `in_enterprise_reachable = False`).

## 4. Compatibility With Existing Tests
- Existing delete specs (`crm-audit-native-delete`, `crm-audit-delete-set-null`, `crm-audit-public-destroy`, `crm-audit-public-merge`) get minimal `core.file` DDL + grants and assert `'Native file is missing, deleted or outside this workspace'` for their invalid random `fileId` fixtures (M4).
- New suite `crm-audit-file-hard-delete.postgres-spec.ts` uses `coreSchema: 'fork'` + `core.application` / `core.file` DDL and proves the full lifecycle end-to-end.
