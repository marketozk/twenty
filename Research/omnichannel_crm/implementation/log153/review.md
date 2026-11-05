# LOG153 independent owner implementation review

Reviewed the durable post-save calendar matching intent contract, atomic intent
creation inside the calendar save transaction, in-band and background recovery
claim/completion coordination, unsafe-outcome fencing, live recovery authority
and omnichannel ownership checks, and unit/PostgreSQL test suites against
`Research/omnichannel_crm/implementation/log153/design.md` and
`Research/omnichannel_crm/implementation/log153/design-review.md`. No source or
runtime files were modified during this review.

## Verdict

No remaining blocking defects, race conditions, SQL injection or authority
bypass vectors, or rollback/audit gaps were identified in the inspected working
tree changes:

- `packages/twenty-server/src/engine/core-modules/crm-audit/calendar-save-proof.ts`
- `packages/twenty-server/src/modules/calendar/calendar-event-import-manager/services/calendar-save-events.service.ts`
- `packages/twenty-server/src/modules/calendar/calendar-event-participant-manager/services/calendar-event-participant.service.ts`
- `packages/twenty-server/src/modules/match-participant/match-participant.service.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-calendar-matching-entrypoints.spec.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-calendar-import-recovery.postgres-spec.ts`

All six implementation details raised in `design-review.md` are accurately
implemented.

## Verification of design-review.md findings

1. **Post-commit error wrapping in `CalendarSaveEventsService` vs raw error handling inside `matchCalendarImportParticipantsWithAudit`:**
   `CalendarSaveEventsService.saveCalendarEventsAndEnqueueContactCreationJob`
   persists the `PENDING` `reconcile_calendarImportMatching` intent row in
   `core."deferredWorkspaceMigrationAction"` inside the strict/exclusive save
   transaction before `COMMIT` whenever
   `calendarEventIds.length > 0 || savedParticipantIds.length > 0` and passes
   `intentId` into
   `CalendarEventParticipantService.matchParticipantsAndEnqueueContactCreationJob`.
   When `contacts.add` fails before matching starts, the intent remains
   `PENDING` (`attempts = 0`) and `CalendarSaveEventsService` wraps the error in
   `CoreAuditPostCommitError`. Inside
   `MatchParticipantService.matchCalendarImportParticipantsWithAudit`, ordinary
   errors reset any surviving `IN_PROGRESS` intent row back to
   `status = 'PENDING'` with `"startedAt" = NULL` and `"lastError" = reason`
   before rethrowing to `CalendarSaveEventsService`, while errors matching
   `isTransactionUnsafeToRetry(error)` fence any surviving row into
   `status = 'FAILED'` with
   `payload = jsonb_set(payload, '{unsafeOutcome}', $5::jsonb, true)` and
   propagate unchanged.
2. **Preserving `savedParticipantIds` (`insertSaveRecords`) and first-save intent durability across re-saves:**
   `CalendarSaveEventsService` keeps
   `savedParticipantIds = await this.insertSaveRecords(auditState, 'calendarEventParticipant', participantOperations.participantsToInsert)`
   and records both `participantIds: savedParticipantIds` and
   `eventIds: calendarEventIds` in the durable intent payload. If post-commit
   matching fails and an identical provider batch is re-saved before recovery
   runs, the first save's `PENDING` intent remains intact in
   `core."deferredWorkspaceMigrationAction"`, and
   `reconcileCalendarImportMatchingIntents` replays pending intents in
   `"createdAt" ASC, position ASC, id ASC` order to link the first save's
   participants and reconcile event targets.
3. **Capturing `causationId: auditOperation.operationId` in `intentPayload.operation` and preserving deduplicated array order:**
   `CalendarSaveEventsService` constructs `intentPayload.operation` with
   `{ ...auditOperation, causationId: auditOperation.operationId }`, matching the
   operation built by
   `CalendarEventParticipantService.matchParticipantsAndEnqueueContactCreationJob`.
   `captureCalendarImportMatchingIntentPayload` validates key whitelists, UUID
   identities, workspace agreement, optional `OrdinaryMetadataSyncRun`, and
   optional `unsafeOutcome`, deduplicating and lowercasing `participantIds` and
   `eventIds` in input order while enforcing `eventIds.length <= 1000` and
   `participantIds.length > 0 || eventIds.length > 0` without restricting
   `operation.actor.kind`.
4. **Two-state intent verification in `verifySaveGraph` and `verifyMatchingGraph` and existing test suite compatibility:**
   In `CalendarSaveEventsService`, `auditState.intentId` and
   `auditState.intentPayload` are assigned immediately after the `INSERT ... RETURNING id`
   into `core."deferredWorkspaceMigrationAction"`, and `verifySaveGraph`
   verifies `id`, `workspaceId`, `applicationUniversalIdentifier`, `name`,
   `position = 0`, `runByVersion = null`, `status = 'PENDING'`, `attempts = 0`,
   `lastError = null`, `startedAt = null`, and `canonicalAuditJson(payload)`
   both before `state.audit.flush()` and after `SET CONSTRAINTS ALL IMMEDIATE`.
   In `MatchParticipantService`, `prepareCalendarMatching` locks the intent row
   `FOR UPDATE` and verifies `status === 'IN_PROGRESS'` and payload attribution;
   `verifyMatchingGraph` verifies that the row stays `IN_PROGRESS` with an
   unchanged payload across every participant and target mutation batch; and
   `finishMatchingAudit` deletes the intent row (`DELETE ... RETURNING id`)
   before `state.audit.flush()` and verifies after
   `SET CONSTRAINTS ALL IMMEDIATE` that the row remains absent.
   `CalendarEventParticipantService` conditionally spreads
   `...(intentId === undefined ? {} : { intentId })` so existing entrypoint
   assertions without `intentId` remain unchanged.
5. **Schema-compatible live authority verification during `isRecoveryReplay`:**
   When `isRecoveryReplay === true`, `prepareCalendarMatching` locks
   `core.workspace` `FOR NO KEY UPDATE` and locks `core."connectedAccount"` and
   `core."calendarChannel"` `FOR SHARE`, verifying active workspace status,
   channel-to-account linkage, `account.provider !== 'app'`,
   `account.archivedAt === null`, `channel.isSyncEnabled === true`, and non-omni
   account ownership via `findOmniOwnedConnectedAccountIds`.
   `verifyMatchingGraph` re-verifies the captured account and channel snapshots
   and non-omni ownership before and after every mutation batch, before
   `state.audit.flush()`, and after `SET CONSTRAINTS ALL IMMEDIATE`. Repeated
   ordinary recovery failures increment `attempts` on claim and transition the
   intent to `status = 'FAILED'` once
   `attempts >= DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS`.
6. **Enterprise dependency and typecheck boundaries:**
   `calendar-save-proof.ts` imports only `isUUID`,
   `captureCrmAuditOperation`, `type CrmAuditOperation`,
   `type NativeCrmAuditTableShape`, and `type OrdinaryMetadataSyncRun`.
   `MatchParticipantService` accesses `core."deferredWorkspaceMigrationAction"`
   through parameterized SQL on `coreDataSource` / `executeRawQuery` and imports
   only `DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS`,
   `isTransactionUnsafeToRetry`, and `findOmniOwnedConnectedAccountIds` without
   pulling in Enterprise modules or runner services.

## Security, transactional integrity and test coverage checks

1. **SQL injection and input validation:**
   All queries against `core."deferredWorkspaceMigrationAction"`,
   `core."connectedAccount"`, `core."calendarChannel"`, and workspace tables use
   parameterized `$1..$N` placeholders and verified identifier quoting. Public
   entrypoints validate UUIDs, workspace scope, array bounds, and frozen intent
   payloads before executing transactional work.
2. **Concurrency and claim serialization:**
   `claimInBandCalendarImportMatchingIntent` fast-paths the `PENDING -> IN_PROGRESS`
   transition and falls back to a strict/exclusive workspace transaction with
   `SELECT ... FOR UPDATE` when background recovery has already claimed or
   completed the intent during `contacts.add`, returning
   `{ completedByRecovery: true }` cleanly when the row was already deleted by
   recovery.
3. **Unit and PostgreSQL integration test coverage:**
   `crm-audit-calendar-matching-entrypoints.spec.ts` and
   `crm-audit-calendar-import-recovery.postgres-spec.ts` cover `PENDING` intent
   creation and in-band deletion, empty-batch no-op, `BEFORE INSERT` and
   `DEFERRABLE INITIALLY DEFERRED` trigger tampering on both save and matching
   completion, post-`contacts.add` failure recovery across an intervening
   identical re-save, recovery after `syncStage = 'FAILED'`, refusal on
   disabled sync, archived account, and omnichannel account binding with
   transition to `FAILED` after 3 attempts, `unsafeOutcome` fencing on
   `NativeTransactionOutcomeUnknownError`, lost `COMMIT` ACK after actual
   matching commit, and concurrent recovery worker serialization during
   in-flight `contacts.add`.
