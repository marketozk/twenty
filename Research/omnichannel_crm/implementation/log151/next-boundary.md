# Next boundary after LOG151 - audited contact and company auto-creation

Read-only boundary analysis for the step following LOG151. No runtime or
acceptance claim is made here.

## What LOG148-LOG151 closed

1. **LOG148 (`rematchNativeMessageParticipantsWithAudit`):** Closed background
   `personOnly` and `workspaceMemberOnly` message participant rematch pages (200
   records per page) with selector and parent proofs.
2. **LOG149 (`applyNativeMessageImportMatchingWithAudit`):** Closed post-save
   message import participant and `messageThreadTarget` matching across all five
   ordinary origins (`provider`, `inbound`, `sent`, `sent-tool`, `application`).
3. **LOG150 (`saveOrdinaryMessageBatchWithAudit`):** Closed initial ordinary
   message batch persistence across five native write tables (`messageThread`,
   `message`, `messageChannelMessageAssociation`, `messageParticipant`,
   `messageChannelMessageAssociationMessageFolder`) and read-only
   `messageThreadTarget` in one strict/exclusive transaction.
4. **LOG151 (`reconcile_messageImportMatching` durable intent):** Closed the
   durability gap between initial save and post-save matching by persisting the
   bounded page manifest and origin context in
   `core.deferredWorkspaceMigrationAction` inside the initial save commit,
   advancing `nextPageIndex` or deleting the completed intent inside each
   matching page commit, fencing `NativeTransactionOutcomeUnknownError` and
   `CoreAuditPostCommitError`, and providing `reconcileMessageImportMatchingIntentsWithAudit`.

## Remaining gap in the import pipeline

Between `saveOrdinaryMessageBatchWithAudit` and `matchMessageParticipants` (and
parallel to calendar event import in `LOG143`/`LOG144`),
`MessagingSaveMessagesAndEnqueueContactCreationService` and
`CalendarSaveEventsService` enqueue `CreateCompanyAndContactJob`, which calls
`CreateCompanyAndContactService` to create `company` and `person` records for
external handles when `isContactAutoCreationEnabled` is true:

1. `CreateCompanyAndContactService` currently writes `company` and `person` rows
   through unclosed repository calls without a single strict/exclusive audit
   owner, source/account authority verification, full expected PostgreSQL row
   images or `RETURNING` verification.
2. When `person` rows are created by `CreateCompanyAndContactService`, the
   resulting creation events trigger `MessageParticipantMatchParticipantJob`
   (`LOG148`) and `CalendarEventParticipantMatchParticipantJob` (`LOG145`), so
   closing the contact/company auto-creation owner connects the entire ordinary
   message and calendar import -> contact creation -> participant/target rematch
   chain under audited native owners.

## Recommended next slice (LOG152)

Close `CreateCompanyAndContactService` / `CreateCompanyAndContactJob` under a
strict/exclusive workspace audit owner that:

- Captures and verifies `connectedAccount` and channel/workspace authority and
  actor/source attribution (`EMAIL` / `CALENDAR`) before creating `company` and
  `person` rows.
- Locks existing candidate `company` (by domain) and `person` (by primary/additional
  emails) rows `FOR SHARE` / `FOR UPDATE`, computes full expected PostgreSQL row
  images, verifies actual `RETURNING` IDs and `FILES` invariants, and flushes
  `crmRecord` create audit before `COMMIT` and `SET CONSTRAINTS ALL IMMEDIATE`.
- Preserves unsafe-outcome classification (`NativeTransactionOutcomeUnknownError`
  / `CoreAuditPostCommitError`) so ambiguous commits are not blindly retried by
  the queue.
