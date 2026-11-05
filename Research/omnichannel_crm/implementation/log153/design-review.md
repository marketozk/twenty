# LOG153 independent design review

Reviewed `Research/omnichannel_crm/implementation/log153/design.md`,
`Research/omnichannel_crm/implementation/log153/test-research.md` and the
actual `calendar-save-proof`, `CalendarSaveEventsService`,
`CalendarEventParticipantService`, `MatchParticipantService` and PostgreSQL/unit
test files after LOG152 (`e75e4fb5`). This report covers the proposed durable
post-save calendar matching intent and recovery slice (part of ROB-765). Runtime
and source implementation acceptance belong to the following step.

## Verdict

The proposed architecture is sound and closes the post-save calendar participant
matching and target reconciliation durability gap without introducing a new
database migration or broadening replay to historical untouched participants.
Persisting a `PENDING` `reconcile_calendarImportMatching` intent in
`core."deferredWorkspaceMigrationAction"` inside
`CalendarSaveEventsService.saveCalendarEventsAndEnqueueContactCreationJob`
before `COMMIT` and atomically deleting the completed intent inside
`MatchParticipantService.matchCalendarImportParticipantsWithAudit` before
`COMMIT` and `SET CONSTRAINTS ALL IMMEDIATE` eliminates the post-commit window.

Six concrete source-level details require explicit handling during
implementation:

1. **Post-commit error wrapping in `CalendarSaveEventsService` vs raw error handling inside `matchCalendarImportParticipantsWithAudit`:**
   In `CalendarSaveEventsService.saveCalendarEventsAndEnqueueContactCreationJob`
   (lines 561-564), the `catch (error)` block wraps any ordinary error
   (`!isTransactionUnsafeToRetry(error)`) thrown by
   `matchParticipantsAndEnqueueContactCreationJob` into
   `new CoreAuditPostCommitError(error)` so the outer sync caller
   (`CalendarEventsImportService.processCalendarEventsImport`) knows the
   calendar save transaction already committed.
   - When `contacts.add` throws an ordinary error before
     `matchCalendarImportParticipantsWithAudit` is entered, the durable intent
     row remains `status = 'PENDING'` (`attempts = 0`) in
     `core."deferredWorkspaceMigrationAction"`, while
     `CalendarSaveEventsService` throws `CoreAuditPostCommitError(error)` to its
     caller.
   - When an ordinary error occurs inside
     `matchCalendarImportParticipantsWithAudit`'s matching transaction,
     `matchCalendarImportParticipantsWithAudit`'s own `catch` block observes the
     raw ordinary error (`!isTransactionUnsafeToRetry(error)`), resets any
     surviving `IN_PROGRESS` intent row back to `status = 'PENDING'` with
     `"startedAt" = NULL, "lastError" = reason`
     (`WHERE status = 'IN_PROGRESS' AND NOT (payload ? 'unsafeOutcome')`), and
     rethrows the raw error; `CalendarSaveEventsService` then wraps that raw
     error into `CoreAuditPostCommitError(error)` for the outer caller.
   - When `matchCalendarImportParticipantsWithAudit` throws
     `NativeTransactionOutcomeUnknownError` or `CoreAuditPostCommitError`,
     `isTransactionUnsafeToRetry(error)` is `true` inside
     `matchCalendarImportParticipantsWithAudit`, so it fences any surviving
     intent row into `status = 'FAILED'` with
     `payload = jsonb_set(payload, '{unsafeOutcome}', $5::jsonb, true)` and
     rethrows `error` unchanged, which `CalendarSaveEventsService` also rethrows
     unchanged (`if (isTransactionUnsafeToRetry(error)) throw error`). If
     `COMMIT` ACK was lost after the matching transaction actually committed in
     PostgreSQL, the intent row was already deleted inside that commit and the
     fencing `UPDATE` is a no-op.
2. **Preserving `savedParticipantIds` (`insertSaveRecords`) and first-save intent durability across re-saves:**
   `buildCalendarEventParticipantSaveOperations` only updates `displayName`,
   `responseStatus` and `isOrganizer` on existing participants
   (`participantsToUpdate`) and inserts newly discovered
   `(calendarEventId, handle)` rows (`participantsToInsert`). Keeping
   `savedParticipantIds = await this.insertSaveRecords(auditState, 'calendarEventParticipant', participantOperations.participantsToInsert)`
   preserves existing `calendar-save-audit.postgres-spec.ts` assertions and
   avoids re-matching already-linked participants on routine metadata updates.
   Because the first save's `PENDING` intent durably records both
   `participantIds: savedParticipantIds` and `eventIds: calendarEventIds` inside
   the save transaction, a subsequent re-save of the same provider event batch
   (which sees the participants as already existing and produces
   `savedParticipantIds = []`) does not overwrite or lose the first save's
   `PENDING` intent; `reconcileCalendarImportMatchingIntents` replays pending
   intents in creation order (`ORDER BY "createdAt" ASC, position ASC, id ASC`)
   and links the newly inserted participants from the first save.
3. **Capturing `causationId: auditOperation.operationId` in `intentPayload.operation` and preserving deduplicated array order:**
   - In `CalendarEventParticipantService.matchParticipantsAndEnqueueContactCreationJob`,
     the matching operation is constructed with
     `causationId: auditOperation.operationId` (linking the matching audit
     entries to the save operation's `operationId`). When
     `CalendarSaveEventsService` builds `intentPayload`, it must pass
     `operation: { ...auditOperation, causationId: auditOperation.operationId }`
     so that both in-band `verifyClaimedCalendarIntentPayload` checks and
     background `reconcileCalendarImportMatchingIntents` replays verify and
     record the exact same `actor`, `initiator`, `correlationId` and
     `causationId`.
   - `captureCalendarImportMatchingIntentPayload` must deduplicate and lowercase
     `participantIds` and `eventIds` while preserving input order
     (`[...new Set(ids.map((id) => uuid(id)))]`, matching
     `matchCalendarImportParticipantsWithAudit` lines 611-612) rather than
     sorting them, and allow `eventIds` of length `0..1000` whenever
     `eventIds.length > 0 || participantIds.length > 0`.
   - Do not restrict `operation.actor.kind` based on whether `authority.run` is
     present: `calendar-save-audit.postgres-spec.ts` line 831 exercises the
     no-run manual persistence mode with
     `actor: { kind: 'system', id: 'calendar-save-audit-test' }` and
     `expectedRun = undefined`.
4. **Two-state intent verification in `verifyMatchingGraph(state)` and existing test suite compatibility:**
   - In `MatchParticipantService`, `verifyMatchingGraph(state)` runs before and
     after each participant and target mutation batch as well as twice inside
     `finishMatchingAudit(state)` (before `state.audit.flush()` and after
     `SET CONSTRAINTS ALL IMMEDIATE`). When `state.intentId` is present,
     `verifyMatchingGraph(state)` must verify that the intent row remains
     present with `status = 'IN_PROGRESS'` and unchanged `payload` while
     `state.intentCompleted === false`, and once the intent row is deleted right
     before `finishMatchingAudit(state)` (`state.intentCompleted = true`),
     verify that
     `SELECT id FROM core."deferredWorkspaceMigrationAction" WHERE id = $1`
     returns zero rows.
   - In `CalendarSaveEventsService`, `auditState.intentId` and
     `auditState.intentPayload` are set only after `savedParticipantIds` and
     `calendarEventIds` are computed right before `finishSaveAudit(auditState)`,
     so earlier `verifySaveGraph(auditState)` calls during record mutations are
     unaffected while both `verifySaveGraph` calls inside `finishSaveAudit`
     (before `audit.flush()` and after `SET CONSTRAINTS ALL IMMEDIATE`) verify
     the persisted `PENDING` intent row.
   - In `CalendarEventParticipantService.matchParticipantsAndEnqueueContactCreationJob`,
     spread `...(intentId === undefined ? {} : { intentId })` into
     `matchCalendarImportParticipantsWithAudit` so
     `crm-audit-calendar-matching-entrypoints.spec.ts` line 107
     (`expect(input).toEqual({ workspaceId, participantIds, eventIds, operation })`
     when `intentId` is omitted) continues to pass without modification.
   - In `calendar-save-audit.postgres-spec.ts` and
     `calendar-import-matching-audit.postgres-spec.ts`,
     `createOmniNativeMessageFixture` already creates, grants and truncates
     `core."deferredWorkspaceMigrationAction"`, and `graph()` / `audits()` only
     inspect the workspace tables and `crm_audit."crmAuditEntry"`, so inserting
     the intent row during `save()` does not break any existing assertions
     (including when `PART` `BEFORE INSERT` returns `NULL` in line 391, where
     `savedParticipantIds` is `[]` and `calendarEventIds` has 1 event ID).
5. **Schema-compatible live authority verification during `isRecoveryReplay`:**
   When `isRecoveryReplay === true` inside `MatchParticipantService`, lock and
   read `core."connectedAccount"`
   (`SELECT id, "workspaceId", provider, "applicationId", "connectionProviderId", "archivedAt"::text AS "archivedAt" FROM core."connectedAccount" WHERE id = $1 AND "workspaceId" = $2 FOR SHARE`)
   and `core."calendarChannel"`
   (`SELECT id, "workspaceId", "connectedAccountId", "isSyncEnabled" FROM core."calendarChannel" WHERE id = $1 AND "workspaceId" = $2 FOR SHARE`)
   using only columns present in both production and
   `calendar-save-audit.postgres-spec.ts`. Refuse and roll back if
   `!account || !channel || channel.connectedAccountId !== account.id || account.provider === 'app' || account.archivedAt !== null || channel.isSyncEnabled !== true`
   or
   `(await findOmniOwnedConnectedAccountIds(state.scope, state.scope.workspaceId, [authority.connectedAccountId])).size > 0`,
   and re-verify those snapshots and non-omni ownership inside
   `verifyMatchingGraph(state)`.
6. **Enterprise dependency and typecheck boundaries:**
   - Keep `calendar-save-proof.ts` importing only `isUUID` from
     `class-validator`, `captureCrmAuditOperation` from
     `src/engine/core-modules/crm-audit/crm-audit-transaction-context`,
     `type CrmAuditOperation` from
     `src/engine/core-modules/crm-audit/crm-audit.types`,
     `type NativeCrmAuditTableShape` from
     `src/engine/core-modules/crm-audit/native-crm-audit-record` and
     `type OrdinaryMetadataSyncRun` from
     `src/modules/omnichannel/services/ordinary-metadata-sync-run`.
   - Access `core."deferredWorkspaceMigrationAction"` via `executeRawQuery` /
     `coreDataSource.query` and import only
     `DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS`,
     `isTransactionUnsafeToRetry` and `findOmniOwnedConnectedAccountIds` in
     `MatchParticipantService`, avoiding any import of
     `DeferredWorkspaceMigrationActionRunnerService` or Enterprise modules.
