# LOG154 independent design review

Reviewed `Research/omnichannel_crm/implementation/log154/design.md`,
`Research/omnichannel_crm/implementation/log154/test-research.md`, and the
actual `DeferredWorkspaceMigrationActionRunnerService`,
`DeferredWorkspaceMigrationActionRecoveryService`,
`DeferredWorkspaceMigrationActionHandlerRegistryService`,
`SyncWorkflowRunSharesDeferredActionHandlerService`, `MatchParticipantModule`,
`MatchParticipantService`, `WorkspaceScopedRepository`,
`crm-audit-membership-cleanup.postgres-spec.ts`, and
`scripts/omnichannel/check_enterprise_dependencies.py` files after LOG153
(`60ae5ae2`). This report covers the proposed deferred action runner and
recovery integration for import matching intents (part of ROB-765). Runtime and
source implementation acceptance belong to the following step.

## Verdict

The proposed architecture is sound and closes the three integration gaps between
the generic deferred-action runner/recovery pipeline and the `LOG151`/`LOG153`
durable post-save import matching intents (`reconcile_messageImportMatching` and
`reconcile_calendarImportMatching`) without introducing a new database migration
or creating any Enterprise dependency edges.

Five concrete source-level details require explicit handling during
implementation:

1. **`loadFlatEntityMaps` with empty `metadataNamesToLoad` and self-managed persistence in `DeferredWorkspaceMigrationActionRunnerService.claimAndExecute`:**
   - In `deferred-workspace-migration-action-runner.service.ts` (lines 196-222),
     when `pendingActions` contains only handlers declaring
     `readonly metadataNamesToLoad = []` (`sync_workflowRunShares`,
     `reconcile_messageImportMatching`, `reconcile_calendarImportMatching`),
     `getMetadataNamesToLoadForWorkspaceMigration([])` returns `[]` and
     `flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps({ workspaceId, flatMapsKeys: [] })`
     passes `[]` without recomputing workspace flat entity caches, matching
     existing `sync_workflowRunShares` behavior.
   - In `claimAndExecute` (lines 224-307), looking up
     `const handler = this.deferredWorkspaceMigrationActionHandlerRegistry.getHandler(pendingAction.name)`
     and branching on `handler.managesOwnPersistence === true` to skip the outer
     `update(workspaceId, { id, status: 'PENDING' }, { status: 'IN_PROGRESS', attempts: attempt, startedAt: new Date() })`,
     outer post-execution `delete(workspaceId, { id, status: 'IN_PROGRESS', attempts: attempt })`,
     and outer `catch` `update(workspaceId, { id, status: 'IN_PROGRESS', attempts: attempt }, ...)`
     is essential:
     - `MatchParticipantService.reconcileMessageImportMatchingIntentsWithAudit`
       and `reconcileCalendarImportMatchingIntentsWithAudit` select
       `WHERE ... status = 'PENDING' AND NOT (payload ? 'unsafeOutcome')` and
       atomically claim `status = 'IN_PROGRESS', attempts = attempts + 1, "startedAt" = now()`.
       An outer `IN_PROGRESS` update before `handler.execute` would cause
       `MatchParticipantService` to see zero `PENDING` candidates and return
       `{ processedIntents: 0, completedIntents: 0 }` without executing
       matching.
     - Skipping the outer `delete` and outer `catch` `update` preserves
       `MatchParticipantService`'s per-page `payload.nextPageIndex` advancement,
       transactional completion `DELETE` before `audit.flush()` and
       `SET CONSTRAINTS ALL IMMEDIATE`, `PENDING` release when
       `attempts < DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS`, `FAILED`
       transition when
       `attempts >= DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS`, and
       `status = 'FAILED'` + `payload.unsafeOutcome` fencing on
       `isTransactionUnsafeToRetry(error)`, while `claimAndExecute` still
       records `recordExecutionDuration({ status: 'success' | 'fail', ... })`,
       logs the outcome, and returns `false` on error so `runPendingActions`
       throws `DeferredWorkspaceMigrationActionException` (`EXECUTION_FAILED`).

2. **`actionId` scoping (`claimAndExecute` vs `executeInProcess`), soft-deleted workspace teardown, and `PENDING` + `unsafeOutcome` fencing:**
   - Passing `actionId: id` from `claimAndExecute` (while `executeInProcess`
     omits `actionId`) allows
     `ReconcileMessageImportMatchingDeferredActionHandlerService.execute` and
     `ReconcileCalendarImportMatchingDeferredActionHandlerService.execute` to
     forward `{ workspaceId, ...(actionId === undefined ? {} : { intentId: actionId }) }`
     to `reconcileMessageImportMatchingIntentsWithAudit` and
     `reconcileCalendarImportMatchingIntentsWithAudit`.
   - Before delegating to `MatchParticipantService` (which requires an active
     workspace with `deletedAt IS NULL`), each handler must query
     `SELECT "deletedAt" FROM core.workspace WHERE id=$1` on `queryRunner`. When
     `!workspace || workspace.deletedAt`:
     - First fence any tampered row in the target scope that has
       `status = 'PENDING' AND (payload ? 'unsafeOutcome')` to
       `status = 'FAILED', "startedAt" = NULL, "lastError" = '... matching intent fenced by unsafe outcome'`
       and throw `new Error('... matching intent fenced by unsafe outcome')`.
     - Otherwise delete the obsolete `PENDING` row
       (`DELETE FROM core."deferredWorkspaceMigrationAction" WHERE id=$1 AND "workspaceId"=$2 AND name=$3 AND status='PENDING' AND NOT (payload ? 'unsafeOutcome')`
       when `actionId` is defined, or workspace/name scope when `actionId` is
       `undefined`) and return cleanly so workspace teardown cleans up pending
       import matching intents just like `sync_workflowRunShares`.
   - Likewise, at the start of
     `MatchParticipantService.reconcileMessageImportMatchingIntentsWithAudit`
     and `reconcileCalendarImportMatchingIntentsWithAudit`, before selecting
     `NOT (payload ? 'unsafeOutcome')` candidates, execute an `UPDATE` fencing
     any row in the target scope with
     `status = 'PENDING' AND (payload ? 'unsafeOutcome')` to
     `status = 'FAILED', "startedAt" = NULL, "lastError" = '... matching intent fenced by unsafe outcome', "updatedAt" = now() RETURNING id`,
     and if any row was fenced, throw
     `new Error('... matching intent fenced by unsafe outcome')`.
   - Do not pre-validate `payload` in `handler.execute` before calling
     `MatchParticipantService` when `actionId` is defined: delegating to
     `MatchParticipantService` is what claims the row (`attempts = attempts + 1`)
     and transitions malformed payloads in
     `core."deferredWorkspaceMigrationAction"` to `FAILED`. Only validate
     `payload` directly in `handler.execute` when `actionId === undefined`.

3. **TypeORM `createQueryBuilder()` compatibility in `DeferredWorkspaceMigrationActionRecoveryService`:**
   - `scopedDeferredRepository` in
     `crm-audit-membership-cleanup.postgres-spec.ts` implements `find`,
     `update`, `delete`, and `createQueryBuilder`, so all query-builder calls in
     `DeferredWorkspaceMigrationActionRecoveryService` must use
     `.createQueryBuilder(...)`.
   - In `resetStaleInProgressActions()`:
     - For `failedResult`, use
       `.createQueryBuilder().update().set({ status: 'FAILED', startedAt: null, lastError }).where({ status: 'IN_PROGRESS', startedAt: LessThan(staleBefore) }).andWhere('(attempts >= :maxAttempts OR (payload ? :unsafeOutcomeKey))', { maxAttempts: DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS, unsafeOutcomeKey: 'unsafeOutcome' }).execute()`.
     - For `pendingResult`, use
       `.createQueryBuilder().update().set({ status: 'PENDING', startedAt: null, lastError }).where({ status: 'IN_PROGRESS', startedAt: LessThan(staleBefore) }).andWhere('NOT (payload ? :unsafeOutcomeKey)', { unsafeOutcomeKey: 'unsafeOutcome' }).execute()`.
   - In `findWorkspaceIdsByStatus(status)`:
     - Chain
       `.andWhere('NOT (deferredWorkspaceMigrationAction.payload ? :unsafeOutcomeKey)', { unsafeOutcomeKey: 'unsafeOutcome' })`
       so `enqueueWorkspacesWithPendingActions()` and `retryFailedActions()`
       skip rows fenced with `payload.unsafeOutcome`.
   - In `retryFailedActions(workspaceId?: string)`:
     - Use `.createQueryBuilder().update().set({ status: 'PENDING', attempts: 0, startedAt: null }).where({ workspaceId: workspaceIdToRetry, status: 'FAILED' }).andWhere('NOT (payload ? :unsafeOutcomeKey)', { unsafeOutcomeKey: 'unsafeOutcome' }).execute()`.

4. **Strict Enterprise dependency isolation (`scripts/omnichannel/check_enterprise_dependencies.py`):**
   - `deferred-workspace-migration-action.type.ts`,
     `deferred-workspace-migration-action-execution-args.type.ts`, and
     `deferred-workspace-migration-action-handler.interface.ts` are inside
     `runtime_enterprise_reachable` (`True`), whereas
     `deferred-workspace-migration-action-name.type.ts`,
     `deferred-workspace-migration-action-handler.decorator.ts`,
     `sync-workflow-run-shares-deferred-action-handler.service.ts`,
     `message-import-matching-context.ts`, and `calendar-save-proof.ts` are
     outside `runtime_enterprise_reachable` (`False`).
   - Therefore, `reconcile-import-matching-deferred-action-handler.service.ts`
     must not import `DeferredWorkspaceMigrationActionHandler`,
     `DeferredWorkspaceMigrationActionExecutionArgs`,
     `DeferredWorkspaceMigrationActionPayload`, or `MatchParticipantService`. It
     must follow `sync-workflow-run-shares-deferred-action-handler.service.ts`
     by importing only `@nestjs/common`, `class-validator`, `typeorm`,
     `DeferredWorkspaceMigrationActionHandlerDecorator`,
     `message-import-matching-context.ts`, and `calendar-save-proof.ts`, and
     passing the identifier `IMPORT_MATCHING_INTENT_RECONCILIATION` to
     `@Inject(IMPORT_MATCHING_INTENT_RECONCILIATION)`.

5. **Existing test suite compatibility (`crm-audit-membership-cleanup.postgres-spec.ts`):**
   - Because `reconcile-import-matching-deferred-action-handler.service.ts` has
     only lightweight, non-mocked imports, `jest.requireActual` of
     `DeferredWorkspaceMigrationActionHandlerRegistryService` in
     `crm-audit-membership-cleanup.postgres-spec.ts` loads cleanly without
     breaking existing tests.
