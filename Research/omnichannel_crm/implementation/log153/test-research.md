# LOG153 test research

Read-only test boundary analysis for durable post-save calendar matching intents
and recovery after LOG152 publication (`e75e4fb5`). No runtime results are
claimed here.

## Existing test suites and compatibility

1. `test/fork-migration/calendar-save-audit.postgres-spec.ts` and
   `test/fork-migration/calendar-import-matching-audit.postgres-spec.ts`:
   Both use `createOmniNativeMessageFixture`, which already creates and grants
   `core."deferredWorkspaceMigrationAction"`.
   In `calendar-save-audit.postgres-spec.ts`, `match` spies on
   `participants.matchParticipantsAndEnqueueContactCreationJob` and mocks it in
   some tests; passing `intentId` as an additional property on the argument
   object preserves existing `expect(match).toHaveBeenCalledWith(expect.objectContaining(...))`
   assertions.
2. `test/fork-migration/crm-audit-calendar-matching-entrypoints.spec.ts`:
   Tests `CalendarEventParticipantService.matchParticipantsAndEnqueueContactCreationJob`.
   When `intentId` is omitted, `matchCalendarImportParticipantsWithAudit` is
   called with `{ workspaceId, participantIds, eventIds, operation }` unchanged;
   when `intentId` is provided, it forwards `intentId`.

## New PostgreSQL and unit cases required for LOG153

1. **Atomic intent creation in `CalendarSaveEventsService` and rollback on
   tamper:**
   - Saving calendar events with participants inserts a `PENDING`
     `reconcile_calendarImportMatching` intent in
     `core."deferredWorkspaceMigrationAction"` inside the save transaction,
     visible when `contacts.add` runs, and deleted inside the matching
     transaction commit.
   - A `BEFORE INSERT` trigger on `core."deferredWorkspaceMigrationAction"` that
     skips (`RETURN NULL`) or rewrites `status`/`payload`, or a deferred trigger
     that deletes the intent row before `COMMIT`, rolls back `calendarEvent`,
     `calendarChannelEventAssociation`, `calendarEventParticipant` and
     `crmAuditEntry`.
   - A deferred trigger that resurrects the deleted intent row during the
     matching transaction rolls back `calendarEventParticipant` updates,
     `calendarEventTarget` mutations and `crmAuditEntry`.
2. **Recovery after contact-queue or matching failure (`CoreAuditPostCommitError`
   wrapping in `CalendarSaveEventsService`):**
   - When `contacts.add` or `matchCalendarImportParticipantsWithAudit` fails with
     an ordinary error after the calendar save commits, `CalendarSaveEventsService`
     still throws `CoreAuditPostCommitError`, while the durable intent remains
     `PENDING` in `core."deferredWorkspaceMigrationAction"`!
   - Even if an identical re-save of the same calendar event batch runs first
     (producing `savedParticipantIds = []` because the participants already
     exist), calling `reconcileCalendarImportMatchingIntents` replays the
     persisted `PENDING` intent from the first save, links `personId` and
     `workspaceMemberId`, reconciles `calendarEventTarget`, records `crmRecord`
     audit with the original actor/initiator/`correlationId` and `causationId`,
     and deletes the intent row.
3. **Live authority verification during recovery replay:**
   - Recovery replay succeeds after `core."calendarChannel"."syncStage"`
     transitions to `FAILED` with a new `syncStageStartedAt`.
   - Recovery replay refuses and rolls back if `core."calendarChannel"."isSyncEnabled"`
     is set to `false`, `core."connectedAccount"` is archived or changed to
     `provider = 'app'`, or the account is enrolled into omnichannel
     (`core."omniAccountBinding"`).
4. **Unsafe-outcome fencing (`NativeTransactionOutcomeUnknownError`):**
   - When `matchCalendarImportParticipantsWithAudit` fails with
     `NativeTransactionOutcomeUnknownError` before commit, the intent row is
     fenced into `status = 'FAILED'` with `payload.unsafeOutcome`, and
     subsequent `reconcileCalendarImportMatchingIntents` calls do not blindly
     replay it.
   - When `COMMIT` ACK is lost after the matching transaction actually committed
     in PostgreSQL, the intent row was already deleted inside that commit.
5. **Concurrent workers and retry exhaustion:**
   - Two concurrent `reconcileCalendarImportMatchingIntents` calls serialize
     cleanly and apply the intent once.
   - Repeated ordinary failures during recovery increment `attempts` and mark
     `status = 'FAILED'` after `DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS` (3).
   - If background recovery completes while `contacts.add` is still awaiting,
     in-band `matchCalendarImportParticipantsWithAudit` observes the completed
     intent cleanly under the exclusive workspace lock without duplicate work.
