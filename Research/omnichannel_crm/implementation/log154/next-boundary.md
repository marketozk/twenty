# Next boundary after LOG154 - transactional import-policy and blocklist freshness on message and calendar save

Read-only boundary analysis for the step following LOG154. No runtime or
acceptance claim is made here.

## What LOG143-LOG154 closed across ordinary messaging and calendar imports

1. **Initial batch persistence (`LOG143`, `LOG150`):**
   - `LOG143`: Closed `CalendarSaveEventsService` (`calendarEvent`,
     `calendarChannelEventAssociation`, `calendarEventParticipant`) in one
     strict/exclusive transaction.
   - `LOG150`: Closed `saveOrdinaryMessageBatchWithAudit` (`messageThread`,
     `message`, `messageChannelMessageAssociation`, `messageParticipant`,
     `messageChannelMessageAssociationMessageFolder`, read-only
     `messageThreadTarget`) in one strict/exclusive transaction.
2. **Post-save participant/target matching and background rematch (`LOG144`-`LOG149`):**
   - Closed post-save matching, background `personOnly`/`workspaceMemberOnly`
     rematch pages, and person-company target reconciliation for both calendar
     and messaging.
3. **Audited company and contact auto-creation (`LOG152`):**
   - Closed two-phase `CreateCompanyAndContactJob` /
     `CreateCompanyAndPersonService` with external HTTP domain prefetch outside
     DB locks and strict/exclusive `company` + `person` batch transactions.
4. **Durable post-save matching intents and runner/recovery integration (`LOG151`, `LOG153`, `LOG154`):**
   - `LOG151` and `LOG153` persist `reconcile_messageImportMatching` and
     `reconcile_calendarImportMatching` in
     `core.deferredWorkspaceMigrationAction` inside the initial save transaction
     before `COMMIT`, advance page cursors or delete completed intents inside
     each matching transaction before `COMMIT`, and fence `unsafeOutcome`.
   - `LOG154` connects `DeferredWorkspaceMigrationActionRunnerService`,
     `DeferredWorkspaceMigrationActionRecoveryService` and
     `DeferredWorkspaceMigrationActionHandlerRegistryService` to both intents
     while preserving self-managed persistence and preventing `unsafeOutcome`
     rows from being un-fenced by recovery or manual retry.

## Remaining import-policy freshness gap (`rob765-progress.md`)

In `MessagingMessagesImportService.processAdmittedBatch` and
`CalendarEventsImportService.processCalendarEventsImport`:

1. Both services fetch provider messages/events over the network
   (`messagingGetMessagesService.getMessages` /
   `calendarImportEventsService.getCalendarEvents`), then read `userWorkspace`,
   `workspaceMember`, `blocklist` and `workspace.isInternalMessagesImportEnabled`
   outside the save transaction and run `filterEmails` /
   `filterEventsAndReturnEventsToRemove` using channel/account fields captured
   before the provider fetch.
2. If `blocklist` entries, `handleAliases`, `excludeGroupEmails`,
   `isInternalMessagesImportEnabled` or `excludePrivateEvents` change while the
   provider fetch is in flight (or between the pre-save reads and the save
   transaction's locks), the save transaction can persist messages or calendar
   events that would have been excluded by the current policy at commit time.

## Recommended next slice (LOG155)

Enforce transactional import-policy and blocklist freshness inside the message
and calendar save transactions (or verify the policy/blocklist snapshot under
transaction locks before committing native writes).
