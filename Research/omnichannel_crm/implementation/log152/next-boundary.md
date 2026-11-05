# Next boundary after LOG152 - durable post-save calendar matching intent and recovery

Read-only boundary analysis for the step following LOG152. No runtime or
acceptance claim is made here.

## What LOG143-LOG152 closed across messaging and calendar imports

1. **Ordinary messaging import pipeline (`LOG148`-`LOG151`):**
   - `LOG150`: Closed initial ordinary message batch persistence across five
     native write tables and read-only `messageThreadTarget` in one
     strict/exclusive transaction.
   - `LOG151`: Closed durable post-save message matching intent
     (`reconcile_messageImportMatching` in `core.deferredWorkspaceMigrationAction`),
     atomic page-progress and completion updates inside each `LOG149` matching
     page commit, unsafe-outcome fencing, and background recovery replay.
   - `LOG149` & `LOG148`: Closed post-save message participant/target matching
     and background `personOnly`/`workspaceMemberOnly` rematch pages.
2. **Automatic company and contact creation (`LOG152`):**
   - Closed `CreateCompanyAndContactJob` and `CreateCompanyAndPersonService`
     under a two-phase strict/exclusive `company` + `person` audit owner with
     external HTTP domain prefetch outside DB locks, fresh core authority and
     non-omni ownership proofs, deduplicated company/person restores, and
     unsafe-outcome propagation.
3. **Calendar event import pipeline (`LOG143`-`LOG147`):**
   - `LOG143`: Closed initial calendar event batch persistence (`calendarEvent`,
     `calendarChannelEventAssociation`, `calendarEventParticipant`) in one
     strict/exclusive transaction.
   - `LOG144`, `LOG145`, `LOG146`: Closed post-save calendar participant and
     `calendarEventTarget` matching, background rematch pages and person-company
     target reconciliation.

## Remaining durability gap on the calendar import path

In `CalendarSaveEventsService.saveCalendarEventsAndEnqueueContactCreationJob`
(`LOG143`) -> `CalendarEventParticipantService.matchParticipantsAndEnqueueContactCreationJob`
(`LOG144`):

1. `CalendarSaveEventsService` commits the `calendarEvent`,
   `calendarChannelEventAssociation` and `calendarEventParticipant` rows in the
   save transaction, then calls
   `calendarEventParticipantService.matchParticipantsAndEnqueueContactCreationJob`.
2. If the process crashes after the calendar save transaction commits, or if
   `messageQueueService.add(CreateCompanyAndContactJob.name, ...)` or
   `matchCalendarImportParticipantsWithAudit` fails, the saved
   `calendarEventParticipant` IDs and `calendarEventIds` from that save batch
   have no durable post-save matching intent in
   `core.deferredWorkspaceMigrationAction` (unlike ordinary message save after
   `LOG151`).
3. Furthermore, `CalendarEventParticipantService.matchParticipantsAndEnqueueContactCreationJob`
   currently passes all `savedParticipantIds` and `calendarEventIds` (up to 1000
   events) to `matchCalendarImportParticipantsWithAudit` in a single call
   without durable intent persistence or recovery replay.

## Recommended next slice (LOG153)

Close durable post-save calendar matching intent and recovery (mirroring
`LOG151` for the calendar import pipeline):

- Persist a `PENDING` durable intent (`reconcile_calendarImportMatching`) in
  `core.deferredWorkspaceMigrationAction` inside the `LOG143`
  `CalendarSaveEventsService` save transaction before `COMMIT` whenever
  `savedParticipantIds` or `calendarEventIds` is non-empty, and verify the
  inserted intent row before `audit.flush()` and after
  `SET CONSTRAINTS ALL IMMEDIATE`.
- Coordinate in-band and recovery execution via `status = 'IN_PROGRESS'` and
  delete the completed intent inside the `LOG144`
  `matchCalendarImportParticipantsWithAudit` transaction before `COMMIT`.
- Fence `NativeTransactionOutcomeUnknownError` and `CoreAuditPostCommitError`
  into `status = 'FAILED'` with `payload.unsafeOutcome` via `jsonb_set`, and
  provide `reconcileCalendarImportMatchingIntentsWithAudit` to replay pending
  calendar matching intents with live workspace/account/channel authority checks.
