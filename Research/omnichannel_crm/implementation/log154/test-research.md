# LOG154 test research

Read-only test boundary analysis for connecting
`DeferredWorkspaceMigrationActionRunnerService` and
`DeferredWorkspaceMigrationActionRecoveryService` to
`reconcile_messageImportMatching` (`LOG151`) and
`reconcile_calendarImportMatching` (`LOG153`) after LOG153 publication
(`60ae5ae2`). No runtime results are claimed here.

## Existing test suites and compatibility

1. `test/fork-migration/crm-audit-membership-cleanup.postgres-spec.ts`:
   Exercises `DeferredWorkspaceMigrationActionRunnerService`,
   `DeferredWorkspaceMigrationActionRecoveryService`,
   `DeferredWorkspaceMigrationActionHandlerRegistryService` and
   `SyncWorkflowRunSharesDeferredActionHandlerService` against a real PostgreSQL
   `core."deferredWorkspaceMigrationAction"` table.
   Using `.createQueryBuilder()` in `retryFailedActions` with
   `.andWhere('NOT (payload ? :unsafeOutcomeKey)', { unsafeOutcomeKey: 'unsafeOutcome' })`
   is compatible with `scopedDeferredRepository.createQueryBuilder()` in
   `crm-audit-membership-cleanup.postgres-spec.ts`.
2. `test/fork-migration/crm-audit-message-import-recovery.postgres-spec.ts` and
   `test/fork-migration/crm-audit-calendar-import-recovery.postgres-spec.ts`:
   Exercise `MatchParticipantService` recovery for message and calendar matching
   intents.

## New PostgreSQL and unit cases required for LOG154

1. **Registry discovery and module wiring:**
   - `DeferredWorkspaceMigrationActionHandlerRegistryService` discovers
     `ReconcileMessageImportMatchingDeferredActionHandlerService`
     (`reconcile_messageImportMatching`),
     `ReconcileCalendarImportMatchingDeferredActionHandlerService`
     (`reconcile_calendarImportMatching`) and
     `SyncWorkflowRunSharesDeferredActionHandlerService` (`sync_workflowRunShares`)
     from `MatchParticipantModule` and `WorkflowRunRecordShareModule`.
2. **End-to-end execution through `DeferredWorkspaceMigrationActionRunnerService.runPendingActions`:**
   - A `PENDING` `reconcile_messageImportMatching` intent and a `PENDING`
     `reconcile_calendarImportMatching` intent in the same workspace (alongside
     `sync_workflowRunShares`) are executed in creation/position order by
     `runner.runPendingActions(workspaceId)`, linking message and calendar
     participants, reconciling thread and event targets, recording `crmRecord`
     audit entries, and deleting the completed rows.
   - Multi-page `reconcile_messageImportMatching` partial failure during
     `runner.runPendingActions(workspaceId)`: when Page 0 commits and Page 1
     fails with an ordinary error, `runner.runPendingActions` throws
     `DeferredWorkspaceMigrationActionException`, while the row in
     `core."deferredWorkspaceMigrationAction"` preserves `status = 'PENDING'`,
     `attempts = 1` and `payload.nextPageIndex = 1` (not overwritten or deleted
     by the outer runner); a subsequent `runner.runPendingActions(workspaceId)`
     resumes from Page 1 and deletes the completed intent.
   - Soft-deleted workspace (`core.workspace."deletedAt" IS NOT NULL`):
     `runner.runPendingActions(workspaceId)` deletes obsolete `PENDING`
     `reconcile_messageImportMatching` and `reconcile_calendarImportMatching`
     rows without invoking `MatchParticipantService`.
3. **Unsafe-outcome fencing across runner and recovery services:**
   - When `reconcile_messageImportMatching` or `reconcile_calendarImportMatching`
     fails with `NativeTransactionOutcomeUnknownError` inside
     `runner.runPendingActions(workspaceId)`, the intent row remains
     `status = 'FAILED'` with `payload.unsafeOutcome`.
   - `recovery.retryFailedActions(workspaceId)` resets ordinary exhausted
     `FAILED` actions (`sync_workflowRunShares` or ordinary failed matching
     intents without `unsafeOutcome`) back to `status = 'PENDING', attempts = 0`,
     while leaving `FAILED` rows with `payload.unsafeOutcome` untouched in
     `status = 'FAILED'`.
   - `recovery.resetStaleInProgressActions()` resets ordinary stale
     `IN_PROGRESS` rows (`startedAt < staleBefore`, `attempts < 3`, no
     `unsafeOutcome`) to `status = 'PENDING', startedAt = null`, while
     transitioning stale `IN_PROGRESS` rows that have `payload.unsafeOutcome`
     (even with `attempts < 3`) or `attempts >= 3` to
     `status = 'FAILED', startedAt = null`.
   - If a row in `core."deferredWorkspaceMigrationAction"` is tampered to have
     both `status = 'PENDING'` and `payload.unsafeOutcome`,
     `runner.runPendingActions(workspaceId)` immediately fences it back to
     `status = 'FAILED'` and throws without executing matching.
