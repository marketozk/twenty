# LOG155 - transactional import-policy and blocklist freshness on message and calendar save

Proposed concrete design for independent review. Source inspection used
`MessagingMessagesImportService`, `InboundEmailImportService`,
`MessagingSaveMessagesAndEnqueueContactCreationService` (`LOG150`),
`CalendarEventsImportService`, `CalendarSaveEventsService` (`LOG143`), and
`deleteOrdinarySyncCalendarAssociationsWithAudit` (`LOG141`). No repository or
runtime changes are claimed by this document.

## Problem and scope

`MessagingMessagesImportService.processAdmittedBatch`,
`InboundEmailImportService.importInboundMessage`, and
`CalendarEventsImportService.processCalendarEventsImport` fetch provider
messages/events over the network and filter them outside the database save
transaction using previously read channel/account/workspace policy fields and
`blocklist` entries:

1. **Message save (`saveOrdinaryMessageBatchWithAudit`, `LOG150`):**
   - `MessagingMessagesImportService` filters `allMessages` via `filterEmails`
     outside the save transaction using pre-fetch `messageChannel.handle`,
     `connectedAccount.handleAliases`, `messageChannel.excludeGroupEmails`,
     `workspace.isInternalMessagesImportEnabled` and `blocklist`.
   - `InboundEmailImportService` checks `isUpstreamSpam` and
     `messageChannel.excludeGroupEmails && isExcludedGroupEmailMessage` outside
     the save transaction before calling `saveMessagesAndEnqueueContactCreation`.
   - Inside `saveOrdinaryMessageBatchWithAudit`, `shouldCreateContact` and
     `isContactAutoCreationEnabled` are currently evaluated from the caller's
     in-memory `messageChannel` and `connectedAccount` objects rather than the
     locked `core."messageChannel"` and `core."connectedAccount"` rows, and the
     save transaction does not lock/verify `blocklist` or re-check whether a
     concurrent policy/blocklist change before lock acquisition would now
     exclude a message in `messagesToSave`.
2. **Calendar save (`CalendarSaveEventsService`, `LOG143`) and sync cleanup (`deleteOrdinarySyncCalendarAssociationsWithAudit`, `LOG141`):**
   - `CalendarEventsImportService` filters `calendarEvents` via
     `filterEventsAndReturnEventsToRemove` outside the save transaction using
     pre-fetch `calendarChannel.handle`, `connectedAccount.handleAliases`,
     `calendarChannel.excludePrivateEvents` and `blocklist`.
   - Inside `CalendarSaveEventsService.saveCalendarEventsAndEnqueueContactCreationJob`,
     although `lockSaveSources` refreshes `calendarChannel.handle`,
     `calendarChannel.excludePrivateEvents` and `connectedAccount.handleAliases`
     from the locked DB rows, it does not lock/verify `blocklist` (`core."userWorkspace"`,
     `workspaceMember`, `blocklist`) or decline the batch when the locked live
     policy (`excludePrivateEvents`, `channelHandles`, `blocklist`) excludes an
     event in `fetchedCalendarEvents`.
   - Inside `deleteOrdinarySyncCalendarAssociationsWithAudit`,
     `lockCalendarSyncAuthority` does not snapshot/re-verify the channel/account
     policy fields (`handle`, `excludePrivateEvents`, `handleAliases`) or
     `blocklist` sources across the cleanup transaction.

## Proposed design

1. **Shared transactional import-policy and blocklist proof helper (`import-policy-proof.ts`):**
   - Create `packages/twenty-server/src/engine/core-modules/crm-audit/import-policy-proof.ts`
     providing `captureLockedBlocklistPolicyProof`:
     - Resolves optional `'blocklist'` and `'workspaceMember'` table shapes from
       `getIssuedNativeCleanupMetadata(scope)`.
     - Locks `workspaceMember` and `blocklist` tables `IN SHARE MODE`.
     - When `userWorkspaceId` is a UUID and `to_regclass('core."userWorkspace"')`
       is non-null, reads and locks `core."userWorkspace"` (`FOR SHARE` where
       `id = $1 AND "workspaceId" = $2`), and if active (`deletedAt === null`),
       reads and locks `workspaceMember` rows (`WHERE "userId" = $1 ORDER BY id FOR SHARE`)
       via `readNativeCrmAuditRows`.
     - Reads and locks all `blocklist` rows (`ORDER BY id FOR SHARE`) via
       `readNativeCrmAuditRows`.
     - Computes `applicableBlocklistHandles` for `scope === 'WORKSPACE'` and
       active member-scoped rules matching `userWorkspaceId` (throwing if
       multiple active `workspaceMember` rows exist for the same `userId`,
       matching `LOG137`).
     - Returns `{ applicableBlocklistHandles, verify }` where `verify()`
       re-reads `core."userWorkspace"`, `workspaceMember` and `blocklist` and
       throws if any snapshot drifted before `COMMIT`.
2. **Enforcing live policy and blocklist in `saveOrdinaryMessageBatchWithAudit` and `InboundEmailImportService`:**
   - Inside `saveOrdinaryMessageBatchWithAudit`:
     - Read `SELECT to_jsonb(w) AS row FROM core.workspace w WHERE w.id=$1`,
       `SELECT to_jsonb(a) AS row FROM core."connectedAccount" a WHERE a.id=$1 AND a."workspaceId"=$2`,
       and `SELECT to_jsonb(c) AS row FROM core."messageChannel" c WHERE c.id=$1 AND c."workspaceId"=$2`,
       and push a validator to `state.validators` verifying those policy fields
       remain unchanged before `audit.flush()` and after
       `SET CONSTRAINTS ALL IMMEDIATE`.
     - Refresh `messageChannel` (`handle`, `isContactAutoCreationEnabled`,
       `contactAutoCreationPolicy`, `excludeNonProfessionalEmails`,
       `excludeGroupEmails`) and `connectedAccount` (`handle`, `handleAliases`)
       from the locked DB rows when those columns are non-null, and return the
       refreshed `isContactAutoCreationEnabled` and `connectedAccount` from
       `saveOrdinaryMessageBatchWithAudit` so contact-creation queue dispatch
       uses the transactionally locked values.
     - When `context.authority.kind === 'provider'` or `'inbound'`:
       - Capture the locked blocklist proof via `captureLockedBlocklistPolicyProof`
         and register its `verify` callback in `state.validators`.
       - On `'provider'`: verify that every message in `messagesToSave` is
         admitted by `filterOutIcsAttachments`, `filterOutUnsubscribeRequests`,
         `filterOutBlocklistedMessages` (using the locked `channelHandle`,
         `handleAliases` and `applicableBlocklistHandles`),
         `!isExcludedGroupEmailMessage` (when locked `excludeGroupEmails === true`),
         and `filterOutInternals` (when locked
         `workspace.isInternalMessagesImportEnabled === false` and
         `isWorkEmail(channelHandle)`). If any message is excluded by the live
         locked policy, return `undefined` before any native write.
       - On `'inbound'`: verify that every message in `messagesToSave` passes
         `!isUpstreamSpam` and, when locked `excludeGroupEmails === true`,
         `!isExcludedGroupEmailMessage(message, [effectiveAccountHandle, ...effectiveHandleAliases])`.
         If excluded by the live locked policy, return `undefined`, and in
         `InboundEmailImportService.importInboundMessage`, when
         `saveMessagesAndEnqueueContactCreation` returns `undefined`, clean up
         the external source and return `{ kind: 'excluded', workspaceId, messageChannelId: messageChannel.id }`.
3. **Enforcing live policy and blocklist in `CalendarSaveEventsService` and `deleteOrdinarySyncCalendarAssociationsWithAudit`:**
   - Inside `CalendarSaveEventsService.saveCalendarEventsAndEnqueueContactCreationJob`,
     when `expectedRun` is defined:
     - Capture the locked blocklist proof via `captureLockedBlocklistPolicyProof`
       (using `userWorkspaceId` from `core."connectedAccount"`) and re-verify it
       in `verifySaveGraph(auditState)` before `audit.flush()` and after
       `SET CONSTRAINTS ALL IMMEDIATE`.
     - Verify via `filterEventsAndReturnEventsToRemove(channelHandles, fetchedCalendarEvents, applicableBlocklistHandles, Boolean(calendarChannel.excludePrivateEvents))`
       that `filteredEvents.length === fetchedCalendarEvents.length`; if any
       event in `fetchedCalendarEvents` is excluded by the live locked policy or
       blocklist, return `null` (`{ calendarEventIds: [], applied: false }`)
       before any native write.
   - Inside `deleteOrdinarySyncCalendarAssociationsWithAudit`, extend
     `lockCalendarSyncAuthority` to snapshot `to_jsonb` policy fields on
     `core."connectedAccount"` and `core."calendarChannel"` plus
     `captureLockedBlocklistPolicyProof` and re-verify them in
     `session.validators` before `audit.flush()` and after
     `SET CONSTRAINTS ALL IMMEDIATE`.
