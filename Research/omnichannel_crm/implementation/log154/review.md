# LOG154 independent owner implementation review

Reviewed the deferred action runner and recovery integration for durable
message and calendar import matching intents
(`reconcile_messageImportMatching` and `reconcile_calendarImportMatching`),
self-managed handler persistence in
`DeferredWorkspaceMigrationActionRunnerService`, `unsafeOutcome` fencing in
`DeferredWorkspaceMigrationActionRecoveryService` and `MatchParticipantService`,
soft-deleted workspace teardown cleanup, Enterprise dependency isolation, and
PostgreSQL integration test suites against
`Research/omnichannel_crm/implementation/log154/design.md` and
`Research/omnichannel_crm/implementation/log154/design-review.md`. No source or
runtime files were modified during this review.

## Verdict

No remaining blocking defects, race conditions, SQL injection or authority
bypass vectors, or Enterprise dependency violations were identified in the
inspected working tree changes:

- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/types/deferred-workspace-migration-action-name.type.ts`
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/types/deferred-workspace-migration-action.type.ts`
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/types/deferred-workspace-migration-action-execution-args.type.ts`
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/deferred-action-handlers/interfaces/deferred-workspace-migration-action-handler.interface.ts`
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/deferred-action-handlers/services/reconcile-import-matching-deferred-action-handler.service.ts`
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/registry/deferred-workspace-migration-action-handler-registry.service.ts`
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-runner.service.ts`
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-recovery.service.ts`
- `packages/twenty-server/src/modules/match-participant/match-participant.module.ts`
- `packages/twenty-server/src/modules/match-participant/match-participant.service.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-import-matching-deferred-runner.postgres-spec.ts`

All five implementation details raised in `design-review.md` are accurately
implemented.

## Verification of design-review.md findings

1. **Empty `metadataNamesToLoad` and self-managed persistence in `DeferredWorkspaceMigrationActionRunnerService.claimAndExecute`:**
   `ReconcileMessageImportMatchingDeferredActionHandlerService` and
   `ReconcileCalendarImportMatchingDeferredActionHandlerService` declare
   `readonly metadataNamesToLoad = []` and
   `readonly managesOwnPersistence = true`. In
   `DeferredWorkspaceMigrationActionRunnerService.claimAndExecute`, the runner
   resolves the handler before any repository write and branches on
   `handler.managesOwnPersistence === true`. In that branch, it connects a
   `queryRunner` from `deferredActionDataSource` and invokes
   `handler.execute({ ..., actionId: id })` without performing the outer
   `IN_PROGRESS` claim `update`, outer post-execution `delete`, or outer `catch`
   `update`, while still recording
   `recordExecutionDuration({ status: 'success' | 'fail', ... })`, logging
   completion or error with the attempt count, releasing `queryRunner` in
   `finally`, and returning `false` on error so `runPendingActions` throws
   `DeferredWorkspaceMigrationActionException` (`EXECUTION_FAILED`).
2. **`actionId` scoping, soft-deleted workspace teardown, and `PENDING` + `unsafeOutcome` fencing:**
   `DeferredWorkspaceMigrationActionExecutionArgs` adds `actionId?: string`,
   which `claimAndExecute` populates with `actionId: id` while
   `executeInProcess` omits it. In
   `reconcile-import-matching-deferred-action-handler.service.ts`:
   - Both handlers validate `workspaceId` and optional `actionId` with `isUUID`
     and normalize them to lowercase.
   - When `actionId === undefined` (in-process execution), the handlers validate
     `payload` directly via `captureMessageImportMatchingIntentPayload` /
     `captureCalendarImportMatchingIntentPayload` and reject any `unsafeOutcome`.
     When `actionId` is defined, payload validation is delegated to
     `MatchParticipantService` after atomic row claim so malformed payloads
     increment `attempts` and transition to `status = 'FAILED'`.
   - `handleInactiveWorkspaceIntent` checks
     `SELECT "deletedAt" FROM core.workspace WHERE id=$1`. When
     `!workspace || workspace.deletedAt`, it first fences any target row with
     `status = 'PENDING' AND (payload ? 'unsafeOutcome')` to
     `status = 'FAILED', "startedAt" = NULL, "lastError" = fencedErrorMessage`
     and throws `new Error(fencedErrorMessage)`; otherwise it deletes obsolete
     `PENDING` rows without `unsafeOutcome` in the target scope and returns
     cleanly.
   - In `MatchParticipantService.reconcileMessageImportMatchingIntentsWithAudit`
     and `reconcileCalendarImportMatchingIntentsWithAudit`, an initial
     `UPDATE ... WHERE ... status = 'PENDING' AND (payload ? 'unsafeOutcome') RETURNING id`
     fences any tampered `PENDING` + `unsafeOutcome` row in scope to
     `status = 'FAILED'` and throws before candidate selection.
3. **TypeORM `createQueryBuilder()` compatibility and `unsafeOutcome` exclusion in `DeferredWorkspaceMigrationActionRecoveryService`:**
   - `resetStaleInProgressActions()` uses `.createQueryBuilder().update()` to
     transition stale `IN_PROGRESS` rows to `FAILED` when
     `attempts >= :maxAttempts OR (payload ? :unsafeOutcomeKey)` and to
     `PENDING` only when `NOT (payload ? :unsafeOutcomeKey)`.
   - `findWorkspaceIdsByStatus(status)` filters with
     `.andWhere('NOT (deferredWorkspaceMigrationAction.payload ? :unsafeOutcomeKey)', { unsafeOutcomeKey: 'unsafeOutcome' })`,
     preventing `enqueueWorkspacesWithPendingActions()` and
     `retryFailedActions()` from selecting workspaces whose only matching rows
     are fenced with `unsafeOutcome`.
   - `retryFailedActions(workspaceId?: string)` uses
     `.createQueryBuilder().update()` with
     `.andWhere('NOT (payload ? :unsafeOutcomeKey)', { unsafeOutcomeKey: 'unsafeOutcome' })`
     so explicit per-workspace retries never reset `unsafeOutcome` rows to
     `PENDING` or re-enqueue them.
4. **Strict Enterprise dependency isolation (`scripts/omnichannel/check_enterprise_dependencies.py`):**
   `reconcile-import-matching-deferred-action-handler.service.ts` imports only
   `@nestjs/common`, `class-validator`, `typeorm`, `calendar-save-proof`,
   `message-import-matching-context`, and
   `DeferredWorkspaceMigrationActionHandlerDecorator`, binding
   `MatchParticipantService` through the `IMPORT_MATCHING_INTENT_RECONCILIATION`
   token in `MatchParticipantModule`. Running
   `python scripts/omnichannel/check_enterprise_dependencies.py` passes with
   zero violations and `runtime_license_proof: false`.
5. **Existing test suite compatibility (`crm-audit-membership-cleanup.postgres-spec.ts`):**
   `DeferredWorkspaceMigrationActionHandlerRegistryService` discovers
   `ReconcileMessageImportMatchingDeferredActionHandlerService` and
   `ReconcileCalendarImportMatchingDeferredActionHandlerService` alongside
   `SyncWorkflowRunSharesDeferredActionHandlerService`, and all repository
   operations in `DeferredWorkspaceMigrationActionRecoveryService` use
   `.createQueryBuilder(...)` supported by the existing test harness.

## Security, transactional integrity and test coverage checks

1. **SQL injection and scope validation:**
   All SQL queries in
   `reconcile-import-matching-deferred-action-handler.service.ts`,
   `MatchParticipantService`, and
   `DeferredWorkspaceMigrationActionRecoveryService` use parameterized
   placeholders (`$1..$N` or `:named` parameters) and strict UUID validation
   before execution.
2. **Self-managed pagination and retry safety:**
   Because `claimAndExecute` delegates persistence for
   `managesOwnPersistence === true` handlers, multi-page message import matching
   intents retain `payload.nextPageIndex` across partial failures, ordinary
   failures release back to `PENDING` until
   `DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS` (3) is reached, and
   `isTransactionUnsafeToRetry` errors fence the intent into `FAILED` with
   `payload.unsafeOutcome` so neither runner execution nor recovery cron jobs
   can replay a transaction with an unknown commit outcome.
3. **PostgreSQL integration test coverage:**
   `crm-audit-import-matching-deferred-runner.postgres-spec.ts` verifies Nest
   `DiscoveryModule` registration from `MatchParticipantModule`, end-to-end
   execution of `reconcile_messageImportMatching`,
   `reconcile_calendarImportMatching`, and `sync_workflowRunShares` via
   `runner.runPendingActions`, multi-page `nextPageIndex` preservation and
   resume after partial failure, soft-deleted workspace cleanup vs tampered
   `PENDING` + `unsafeOutcome` fencing, `unsafeOutcome` immutability across
   `retryFailedActions`, `resetStaleInProgressActions`, and
   `enqueueWorkspacesWithPendingActions`, ordinary 3-attempt exhaustion and
   `retryFailedActions()` recovery, and direct handler payload validation when
   `actionId` is omitted.
