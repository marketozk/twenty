# LOG154 - deferred action runner and recovery integration for import matching intents

Proposed concrete design for independent review. Source inspection used
`DeferredWorkspaceMigrationActionRunnerService`,
`DeferredWorkspaceMigrationActionRecoveryService`,
`DeferredWorkspaceMigrationActionHandlerRegistryService`,
`SyncWorkflowRunSharesDeferredActionHandlerService` (`LOG114`), and
`MatchParticipantService` (`LOG151`, `LOG153`). No repository or runtime changes
are claimed by this document.

## Problem and scope

`LOG151` and `LOG153` persist durable post-save matching intents
(`reconcile_messageImportMatching` and `reconcile_calendarImportMatching`) in
`core."deferredWorkspaceMigrationAction"`. In production,
`DeferredWorkspaceMigrationActionRecoveryCronJob` periodically calls
`DeferredWorkspaceMigrationActionRecoveryService.resetStaleInProgressActions()`
and `enqueueWorkspacesWithPendingActions()`, which enqueues
`RunDeferredWorkspaceMigrationActionsJob` ->
`DeferredWorkspaceMigrationActionRunnerService.runPendingActions(workspaceId)`
whenever any `PENDING` row exists in `core."deferredWorkspaceMigrationAction"`.

Three integration gaps currently exist between the generic deferred-action
runner/recovery services and the `LOG151`/`LOG153` import matching intents:

1. **Missing handler registration:**
   `reconcile_messageImportMatching` and `reconcile_calendarImportMatching` are
   not registered in `DeferredWorkspaceMigrationActionHandlerRegistryService`.
   When `runPendingActions(workspaceId)` encounters a `PENDING` import matching
   intent, `loadFlatEntityMaps` throws
   `DeferredWorkspaceMigrationActionException(HANDLER_NOT_FOUND)` and blocks
   subsequent deferred actions in that workspace.
2. **Outer claim/delete vs self-managed transactional cursor/completion:**
   `DeferredWorkspaceMigrationActionRunnerService.claimAndExecute` wraps standard
   handlers in outer `update({ status: 'IN_PROGRESS' })` and `delete(...)` calls,
   whereas `MatchParticipantService.reconcileMessageImportMatchingIntentsWithAudit`
   and `reconcileCalendarImportMatchingIntentsWithAudit` atomically claim
   `IN_PROGRESS`, advance `nextPageIndex` per committed page or delete the row
   inside the strict/exclusive workspace transaction before `COMMIT`, and record
   `PENDING` / `FAILED` / `unsafeOutcome` states on failure.
3. **Un-fencing `unsafeOutcome` rows in recovery and manual retry:**
   `DeferredWorkspaceMigrationActionRecoveryService.retryFailedActions`
   currently resets all `status = 'FAILED'` rows in a workspace back to
   `status = 'PENDING'` without checking `NOT (payload ? 'unsafeOutcome')`, and
   `resetStaleInProgressActions` / `findWorkspaceIdsByStatus` do not filter on
   `payload ? 'unsafeOutcome'`.

## Proposed design

1. **Action names and handler contract:**
   - Extend `DeferredWorkspaceMigrationActionName` and
     `DeferredWorkspaceMigrationActionPayloadByName` with
     `reconcile_messageImportMatching` and `reconcile_calendarImportMatching`.
   - Extend `DeferredWorkspaceMigrationActionExecutionArgs` with optional
     `actionId?: string` and `DeferredWorkspaceMigrationActionHandler` with
     optional `managesOwnPersistence?: boolean`.
2. **Self-managed handlers via injection token (`IMPORT_MATCHING_INTENT_RECONCILIATION`):**
   - Create `src/engine/workspace-manager/workspace-migration/workspace-migration-runner/deferred-action-handlers/services/reconcile-import-matching-deferred-action-handler.service.ts`
     defining `IMPORT_MATCHING_INTENT_RECONCILIATION`,
     `ReconcileMessageImportMatchingDeferredActionHandlerService`
     (`@DeferredWorkspaceMigrationActionHandlerDecorator('reconcile_messageImportMatching')`)
     and `ReconcileCalendarImportMatchingDeferredActionHandlerService`
     (`@DeferredWorkspaceMigrationActionHandlerDecorator('reconcile_calendarImportMatching')`),
     following the `SyncWorkflowRunSharesDeferredActionHandlerService` (`LOG114`)
     token pattern so `DeferredWorkspaceMigrationActionHandlerRegistryService`
     never imports `MatchParticipantService` directly.
   - Both handlers declare `readonly metadataNamesToLoad = []` and
     `readonly managesOwnPersistence = true`.
   - Before delegating to `MatchParticipantService`, each handler checks
     `SELECT "deletedAt" FROM core.workspace WHERE id=$1` on `queryRunner`; if
     the workspace is missing or soft-deleted, it deletes the obsolete `PENDING`
     intent row (`WHERE id=$1 AND "workspaceId"=$2 AND name=$3 AND status='PENDING' AND NOT (payload ? 'unsafeOutcome')`)
     and returns cleanly.
   - Register both handlers in `MatchParticipantModule` (providing
     `{ provide: IMPORT_MATCHING_INTENT_RECONCILIATION, useExisting: MatchParticipantService }`)
     and discover them in
     `DeferredWorkspaceMigrationActionHandlerRegistryService.onModuleInit()`.
3. **Self-managed execution branch in `DeferredWorkspaceMigrationActionRunnerService`:**
   - In `claimAndExecute`, look up `handler = this.deferredWorkspaceMigrationActionHandlerRegistry.getHandler(pendingAction.name)`.
   - When `handler.managesOwnPersistence === true`, invoke
     `handler.execute({ ..., actionId: id })` without performing the outer
     `update({ status: 'IN_PROGRESS' })` or post-execution `delete(...)`, and on
     failure record metrics/logs and return `false` without overwriting the row's
     self-managed `PENDING` / `FAILED` / `unsafeOutcome` state.
4. **Fencing `unsafeOutcome` in `MatchParticipantService` and `DeferredWorkspaceMigrationActionRecoveryService`:**
   - In `MatchParticipantService.reconcileMessageImportMatchingIntentsWithAudit`
     and `reconcileCalendarImportMatchingIntentsWithAudit`, if any row matching
      the target scope has `status = 'PENDING' AND (payload ? 'unsafeOutcome')`,
     immediately fence it to `status = 'FAILED', "startedAt" = NULL` and throw
     `'... matching intent fenced by unsafe outcome'`.
   - In `DeferredWorkspaceMigrationActionRecoveryService`:
     - `resetStaleInProgressActions()`: transition stale `IN_PROGRESS` rows to
       `FAILED` (`startedAt: null`) when
       `attempts >= DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS OR (payload ? 'unsafeOutcome')`,
       and transition remaining stale `IN_PROGRESS` rows to `PENDING`
       (`startedAt: null`) only when `NOT (payload ? 'unsafeOutcome')`.
     - `findWorkspaceIdsByStatus(status)`: exclude rows with
       `payload ? 'unsafeOutcome'`.
     - `retryFailedActions(workspaceId?)`: update only `status = 'FAILED'` rows
       satisfying `NOT (payload ? 'unsafeOutcome')` to `status = 'PENDING', attempts = 0, startedAt = null`.
