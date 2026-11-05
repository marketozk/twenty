# LOG153 - durable post-save calendar matching intent and recovery

Proposed concrete design for independent review. Source inspection used
`CalendarSaveEventsService` (`LOG143`), `CalendarEventParticipantService` and
`MatchParticipantService` (`LOG144`), and the `LOG151` durable message-matching
intent precedent in `core.deferredWorkspaceMigrationAction`. No repository or
runtime changes are claimed by this document.

## Problem and scope

`CalendarSaveEventsService.saveCalendarEventsAndEnqueueContactCreationJob`
commits `calendarEvent`, `calendarChannelEventAssociation` and
`calendarEventParticipant` rows in one strict/exclusive transaction (`LOG143`),
then calls `CalendarEventParticipantService.matchParticipantsAndEnqueueContactCreationJob`,
which enqueues `CreateCompanyAndContactJob` (`LOG152`) and invokes
`MatchParticipantService.matchCalendarImportParticipantsWithAudit` (`LOG144`).

Today, if a crash, contact-queue failure or matching error occurs after the
calendar save transaction commits:

1. Because `buildCalendarEventParticipantSaveOperations` only inserts newly
   discovered participants and updates changed `displayName`/`responseStatus`/`isOrganizer`
   fields, a subsequent re-save of the same provider event batch sees the
   previously inserted participants as already existing (`participantsToInsert = []`),
   producing `savedParticipantIds = []`.
2. Without a durable post-save matching intent persisted inside the initial
   calendar save transaction, the newly inserted participants from the failed
   post-commit phase are never matched to `person` and `workspaceMember` records
   on a naive re-save.

This slice closes the calendar post-save matching durability gap by:

1. Persisting a `PENDING` durable intent (`reconcile_calendarImportMatching`) in
   `core.deferredWorkspaceMigrationAction` inside the `LOG143`
   `CalendarSaveEventsService` save transaction before `COMMIT` whenever
   `calendarEventIds.length > 0 || savedParticipantIds.length > 0`.
2. Coordinating in-band and background recovery execution via atomic
   `status = 'IN_PROGRESS'` claims and deleting the completed intent inside the
   `LOG144` `matchCalendarImportParticipantsWithAudit` transaction before
   `COMMIT` and `SET CONSTRAINTS ALL IMMEDIATE`.
3. Fencing `NativeTransactionOutcomeUnknownError` and `CoreAuditPostCommitError`
   into `status = 'FAILED'` with `payload.unsafeOutcome` via `jsonb_set` so
   ambiguous commits are never blindly retried.
4. Providing `reconcileCalendarImportMatchingIntentsWithAudit` (and
   `CalendarEventParticipantService.reconcileCalendarImportMatchingIntents`) to
   replay pending calendar matching intents with live workspace, account and
   channel authority checks while preserving the original captured actor,
   initiator, `correlationId` and `causationId`.

## Pure contract in `calendar-save-proof.ts`

Extend `packages/twenty-server/src/engine/core-modules/crm-audit/calendar-save-proof.ts`:

- `CALENDAR_IMPORT_MATCHING_INTENT_NAME = 'reconcile_calendarImportMatching'`
- `CalendarImportMatchingAuthority`:
  - `workspaceId: string`
  - `connectedAccountId: string`
  - `channelId: string`
  - `run?: OrdinaryMetadataSyncRun`
- `CalendarImportMatchingIntentPayload`:
  - `version: 1`
  - `operation: CrmAuditOperation`
  - `authority: CalendarImportMatchingAuthority`
  - `participantIds: readonly string[]`
  - `eventIds: readonly string[]` (1..1000 deduplicated lowercase UUIDs)
  - `unsafeOutcome?: Readonly<{ reason: string }>`
- `captureCalendarImportMatchingIntentPayload(input: unknown)`:
  Validates structural shape, key whitelist, UUIDs, `eventIds` bounds (`<= 1000`),
  non-empty `eventIds` or `participantIds`, `operation`/`authority` workspace
  agreement and optional `unsafeOutcome`, returning a deeply frozen payload.

## Atomic intent creation in `CalendarSaveEventsService`

Inside `saveCalendarEventsAndEnqueueContactCreationJob`'s `runInWorkspaceTransaction`
callback, after `savedParticipantIds` and `calendarEventIds` are computed and
before `finishSaveAudit(auditState)`:

1. When `calendarEventIds.length > 0 || savedParticipantIds.length > 0`:
   - Allocate `intentId = randomUUID()` and build `intentPayload = captureCalendarImportMatchingIntentPayload(...)`
     with `operation: auditOperation`, `authority: { workspaceId, connectedAccountId: connectedAccount.id, channelId: calendarChannel.id, ...(expectedRun ? { run: expectedRun } : {}) }`, `participantIds: savedParticipantIds` and `eventIds: calendarEventIds`.
   - Insert into `core."deferredWorkspaceMigrationAction"` with `id = intentId`,
     `"workspaceId" = workspaceId`, `"applicationUniversalIdentifier" = TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER`,
     `name = CALENDAR_IMPORT_MATCHING_INTENT_NAME`, `payload = intentPayload`,
     `position = 0`, `status = 'PENDING'`, `attempts = 0`.
   - Require `RETURNING id` to match `intentId`.
   - Store `auditState.intentId = intentId` and `auditState.intentPayload = intentPayload`
     so `verifySaveGraph(auditState)` (executed before `audit.flush()` and after
     `SET CONSTRAINTS ALL IMMEDIATE`) re-reads the row and verifies `id`,
     `workspaceId`, `applicationUniversalIdentifier`, `name`, `position = 0`,
     `runByVersion = null`, `status = 'PENDING'`, `attempts = 0`,
     `lastError = null`, `startedAt = null` and `canonicalAuditJson(payload)`.
2. Return `intentId` from the save transaction and pass it into
   `this.calendarEventParticipantService.matchParticipantsAndEnqueueContactCreationJob({ ..., intentId })`.

## Atomic completion, coordination and recovery in `MatchParticipantService`

In `MatchParticipantService.matchCalendarImportParticipantsWithAudit`:

- Accept optional `intentId?: string`.
- When `intentId` is supplied, atomically claim `status = 'IN_PROGRESS'` via
  `claimInBandCalendarImportMatchingIntent` (or serialize under an exclusive
  workspace transaction if background recovery already claimed or completed the
  intent while `contacts.add` was running).
- Inside `runInWorkspaceTransaction`:
  - Lock the intent row in `core."deferredWorkspaceMigrationAction"` `FOR UPDATE`,
    require `status === 'IN_PROGRESS'`, validate `payload` via
    `captureCalendarImportMatchingIntentPayload`, require `unsafeOutcome` to be
    absent, and verify `participantIds`, `eventIds` and `operation` attribution
    match the invocation.
  - During recovery replay (`isRecoveryReplay === true`), lock and verify live
    `core."connectedAccount"` and `core."calendarChannel"` rows (`id`,
    `"workspaceId"`, `"connectedAccountId"`, `provider !== 'app'`,
    `archivedAt === null`, `isSyncEnabled !== false`) and non-omni ownership
    (`findOmniOwnedConnectedAccountIds`), plus re-verify them in
    `verifyMatchingGraph`.
  - Before `finishMatchingAudit(state)` flushes `state.audit`, delete the intent
    row from `core."deferredWorkspaceMigrationAction"`, verify `RETURNING id`,
    and verify in `verifyMatchingGraph(state)` (before `audit.flush()` and after
    `SET CONSTRAINTS ALL IMMEDIATE`) that the row remains absent.
- When an error is thrown and `intentId` is present:
  - If `isTransactionUnsafeToRetry(error)`: update any surviving intent row to
    `status = 'FAILED'` with `jsonb_set(payload, '{unsafeOutcome}', ...)` and
    rethrow `error` unchanged.
  - Otherwise: reset any surviving `IN_PROGRESS` row back to `status = 'PENDING'`
    with `"startedAt" = null, "lastError" = error.message` and rethrow `error`.
