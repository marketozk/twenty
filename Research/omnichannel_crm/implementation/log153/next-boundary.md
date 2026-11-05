# Next boundary after LOG153 - deferred action runner and recovery integration for import matching intents

Read-only boundary analysis for the step following LOG153. No runtime or
acceptance claim is made here.

## What LOG151 and LOG153 closed

1. **LOG151 (`reconcile_messageImportMatching`):**
   - Persists a `PENDING` durable message-matching intent in
     `core.deferredWorkspaceMigrationAction` inside
     `saveOrdinaryMessageBatchWithAudit` (`LOG150`) before `COMMIT`.
   - Atomically advances `nextPageIndex` or deletes the completed intent row
     inside each `applyNativeMessageImportMatchingWithAudit` (`LOG149`) page
     transaction before `COMMIT`.
   - Fences `NativeTransactionOutcomeUnknownError` and `CoreAuditPostCommitError`
     into `status = 'FAILED'` with `payload.unsafeOutcome` via `jsonb_set`.
   - Provides `MatchParticipantService.reconcileMessageImportMatchingIntentsWithAudit`
     and `MessagingMessageParticipantService.reconcileMessageImportMatchingIntents`.
2. **LOG153 (`reconcile_calendarImportMatching`):**
   - Persists a `PENDING` durable calendar-matching intent in
     `core.deferredWorkspaceMigrationAction` inside
     `CalendarSaveEventsService.saveCalendarEventsAndEnqueueContactCreationJob`
     (`LOG143`) before `COMMIT`.
   - Atomically claims `status = 'IN_PROGRESS'` and deletes the completed intent
     row inside `MatchParticipantService.matchCalendarImportParticipantsWithAudit`
     (`LOG144`) before `COMMIT`.
   - Fences `NativeTransactionOutcomeUnknownError` and `CoreAuditPostCommitError`
     into `status = 'FAILED'` with `payload.unsafeOutcome` via `jsonb_set`.
   - Provides `MatchParticipantService.reconcileCalendarImportMatchingIntentsWithAudit`
     and `CalendarEventParticipantService.reconcileCalendarImportMatchingIntents`.

## Remaining integration boundary in the deferred-action runner and recovery cron

Because both `reconcile_messageImportMatching` (`LOG151`) and
`reconcile_calendarImportMatching` (`LOG153`) store their durable intents in
`core.deferredWorkspaceMigrationAction`:

1. `DeferredWorkspaceMigrationActionRecoveryCronJob` periodically calls
   `DeferredWorkspaceMigrationActionRecoveryService.resetStaleInProgressActions()`
   and `enqueueWorkspacesWithPendingActions()`, which enqueues
   `RunDeferredWorkspaceMigrationActionsJob` ->
   `DeferredWorkspaceMigrationActionRunnerService.runPendingActions(workspaceId)`
   whenever any `PENDING` row exists in `core.deferredWorkspaceMigrationAction`.
2. Currently, `DeferredWorkspaceMigrationActionRunnerService.runPendingActions`
   attempts to look up every `PENDING` row's `name` in
   `DeferredWorkspaceMigrationActionHandlerRegistryService` and wraps handler
   execution in outer `update({ status: 'IN_PROGRESS' })` / `delete(...)` calls,
   whereas `reconcile_messageImportMatching` and
   `reconcile_calendarImportMatching` manage their own `IN_PROGRESS` claims,
   page-cursor progression (`nextPageIndex`), atomic transactional completion
   deletes, and `unsafeOutcome` fencing inside `MatchParticipantService`.
3. Furthermore, `DeferredWorkspaceMigrationActionRecoveryService.retryFailedActions`
   currently resets all `status = 'FAILED'` rows in a workspace back to
   `status = 'PENDING'` without checking `NOT (payload ? 'unsafeOutcome')`, which
   would un-fence an intent that failed with an ambiguous commit outcome
   (`NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`).

## Recommended next slice (LOG154)

Connect `DeferredWorkspaceMigrationActionRunnerService` and
`DeferredWorkspaceMigrationActionRecoveryService` (as well as channel import
recovery entrypoints) to `reconcile_messageImportMatching` and
`reconcile_calendarImportMatching`:

- Dispatch `reconcile_messageImportMatching` and
  `reconcile_calendarImportMatching` through `MatchParticipantService` (or
  registered self-claiming handlers) so `RunDeferredWorkspaceMigrationActionsJob`
  drains pending message and calendar matching intents without outer
  claim/delete interference or `HANDLER_NOT_FOUND` failures blocking other
  deferred workspace migration actions.
- Guard `DeferredWorkspaceMigrationActionRecoveryService.retryFailedActions` and
  `resetStaleInProgressActions` with `NOT (payload ? 'unsafeOutcome')` so intents
  fenced after `NativeTransactionOutcomeUnknownError` or `CoreAuditPostCommitError`
  are never automatically re-queued as `PENDING`.
