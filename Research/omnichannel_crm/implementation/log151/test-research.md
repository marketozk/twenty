# LOG151 test research

Read-only test boundary analysis for durable post-save message matching intents
and page-level recovery after LOG150 publication (`c3478dde`). No runtime
results are claimed here.

## Existing test fixtures and required extensions

1. `test/fork-migration/omni-native-message.fixture.ts`:
   Creates the `core` schema for `createOmniNativeMessageFixture` and
   `createOmniNativeCleanupFixture`. Adding `core."deferredWorkspaceMigrationAction"`
   to `initialize()`, granting `SELECT, INSERT, UPDATE, DELETE` on
   `core."deferredWorkspaceMigrationAction"` to `roleName`, and truncating
   `core."deferredWorkspaceMigrationAction"` in `reset()` makes the durable
   intent table available to `ordinary-native-sync-run.postgres-spec.ts`,
   `crm-audit-message-import-matching.postgres-spec.ts`,
   `crm-audit-ordinary-message-save.postgres-spec.ts` and the new LOG151 suite.
2. `test/fork-migration/crm-audit-message-import-matching.postgres-spec.ts`:
   In `a failed queue preserves saved rows and identical retry exposes the
   documented lost touched-set gap`, the first save commits a `PENDING` durable
   intent in `core."deferredWorkspaceMigrationAction"`, the second identical
   save still produces an empty touched-participant manifest (`participants: []`)
   without broadly rematching historical rows, and invoking
   `reconcileMessageImportMatchingIntents` afterwards recovers the originally
   touched participant from the persisted intent and deletes the intent row.

## New PostgreSQL and unit cases required for LOG151

1. **Atomic intent creation and rollback on tamper:**
   - Saving a message batch with participants inserts a `PENDING` intent in
     `core."deferredWorkspaceMigrationAction"` inside the save transaction,
     visible when `contacts.add` runs, and deleted once in-band matching
     completes.
   - Saving an empty batch or a message with zero participants inserts no
     intent row.
   - A `BEFORE INSERT` trigger on `core."deferredWorkspaceMigrationAction"` that
     skips (`RETURN NULL`) or rewrites `payload`/`status`/`attempts`, or a
     deferred trigger that deletes the intent row before `COMMIT`, rolls back
     all five native tables and `crmAuditEntry`.
2. **Recovery after contact-queue failure or crash before matching:**
   - When `contacts.add` throws after `saveOrdinaryMessageBatchWithAudit`
     commits, the `PENDING` intent remains in
     `core."deferredWorkspaceMigrationAction"` with `nextPageIndex = 0`.
   - Even if an identical retry of `saveMessagesAndEnqueueContactCreation` runs
     first (producing `participants: []` for the retry itself), calling
     `reconcileMessageImportMatchingIntents` replays the persisted `PENDING`
     intent, links `personId` and `workspaceMemberId`, records `crmRecord`
     audit with the original actor/initiator/`correlationId`, and deletes the
     intent row.
3. **Provider recovery after sync stage transition:**
   - A `provider` import batch commits its save and durable intent, then fails
     during queue/matching and transitions `core."messageChannel"."syncStage"`
     to `FAILED` with a new `syncStageStartedAt`.
   - `reconcileMessageImportMatchingIntents` verifies current live
     `connectedAccount` and `messageChannel` (`isSyncEnabled = true`, matching
     account/type, non-omni ownership) and replays the pending intent
     successfully without requiring the old `MESSAGES_IMPORT_ONGOING` timestamp.
   - If `isSyncEnabled` is set to `false` or the channel is transferred/enrolled
     into omnichannel before recovery, replay refuses and rolls back.
4. **Multi-page progress persistence and resume from `nextPageIndex`:**
   - A batch with 201 touched participants creates a 2-page durable intent
     (`nextPageIndex = 0`).
   - When Page 0 commits and Page 1 fails with an ordinary error, Page 0's
     participant and target updates and audit remain committed, and the intent
     row in `core."deferredWorkspaceMigrationAction"` has `nextPageIndex = 1`
     and `status = 'PENDING'`.
   - Running `reconcileMessageImportMatchingIntents` resumes at Page 1 without
     re-executing Page 0, commits Page 1's participant/target updates and
     audit, and deletes the intent row inside Page 1's commit.
5. **Unsafe-outcome fencing (`NativeTransactionOutcomeUnknownError` /
   `CoreAuditPostCommitError`):**
   - When Page 0 commits and Page 1 loses its `COMMIT` ACK
     (`NativeTransactionOutcomeUnknownError`) or fails after commit, the catch
     block marks any remaining intent row `status = 'FAILED'` with
     `payload.unsafeOutcome = { pageIndex: 1, ... }`, and subsequent automatic
     `reconcileMessageImportMatchingIntents` calls do not blindly replay it.
   - When a single-page intent loses its `COMMIT` ACK after the `COMMIT`
     actually succeeded in PostgreSQL, the intent row was already deleted
     inside that commit, so no duplicate replay is possible.
6. **Competing recovery workers and retry exhaustion:**
   - Two concurrent `reconcileMessageImportMatchingIntents` calls on the same
     workspace claim and process the pending intent once without duplicate
     execution or error.
   - Repeated ordinary failures during recovery increment `attempts` and
     transition `status` from `IN_PROGRESS` to `PENDING` until
     `DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS` (3), at which point
     `status` becomes `'FAILED'`.
