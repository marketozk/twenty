# LOG155 test research

Read-only test boundary analysis for transactional import-policy and blocklist
freshness on message and calendar save after LOG154 publication (`3c2d4521`). No
runtime results are claimed here.

## Existing test suites and compatibility

1. `test/fork-migration/crm-audit-ordinary-message-save.postgres-spec.ts`,
   `test/fork-migration/ordinary-native-sync-run.postgres-spec.ts`,
   `test/fork-migration/calendar-save-audit.postgres-spec.ts`:
   - Reading optional policy columns via `SELECT to_jsonb(...)` on
     `core.workspace`, `core."connectedAccount"`, `core."messageChannel"` and
     `core."calendarChannel"` works across minimal test schemas without
     requiring every test to alter all policy columns onto `core` tables.
   - Only enforcing `filterOutInternals` when
     `workspaceJson.isInternalMessagesImportEnabled === false` (explicitly
     `false` on the `core.workspace` row) preserves existing synthetic test
     cases in `crm-audit-ordinary-message-save.postgres-spec.ts` and
     `ordinary-native-sync-run.postgres-spec.ts` where `core.workspace` has no
     `isInternalMessagesImportEnabled` column and both channel and participant
     handles use `@example.test`.
   - Resolving `'blocklist'` and `'workspaceMember'` shapes optionally when
     present in `getIssuedNativeCleanupMetadata(scope).objects` preserves
     fixtures that do not include `'blocklist'` or `'workspaceMember'` in
     `additionalTables` (such as `calendar-save-audit.postgres-spec.ts` and
     `ordinary-native-sync-run.postgres-spec.ts`).
2. `test/fork-migration/crm-audit-message-import-entrypoints.spec.ts`:
   - In `InboundEmailImportService.importInboundMessage`, `saveStub()` returns a
     truthy object `{ messageExternalIdsAndIdsMap, messageExternalIdToMessageThreadIdMap }`,
     so existing `kind: 'imported'` assertions pass unchanged while a `undefined`
     return when live `excludeGroupEmails` excludes the message returns
     `{ kind: 'excluded', workspaceId, messageChannelId }`.

## New PostgreSQL cases required for LOG155

1. **Provider message save (`saveOrdinaryMessageBatchWithAudit`) policy & blocklist freshness:**
   - Declines a provider message batch (`returns undefined`, 0 native writes, 0
     audit entries, 0 durable intents) when a workspace-scoped or member-scoped
     `blocklist` rule (`@blocked.test` or exact email) is present in DB at lock
     time even if the caller passed the message into
     `saveMessagesAndEnqueueContactCreation`.
   - Declines a provider message batch when `core."messageChannel"."excludeGroupEmails"`
     is `true` in DB (even if caller's in-memory `messageChannel.excludeGroupEmails`
     was `false`) and the batch contains a group/bulk email, or when
     `core.workspace."isInternalMessagesImportEnabled"` is `false` in DB and the
     batch contains an internal same-domain work email.
   - Refreshes `isContactAutoCreationEnabled`, `contactAutoCreationPolicy` and
     `excludeNonProfessionalEmails` from the locked `core."messageChannel"` row
     so disabling `isContactAutoCreationEnabled` in DB before the save
     transaction locks the channel prevents `CreateCompanyAndContactJob`
     enqueue even if caller's in-memory `messageChannel.isContactAutoCreationEnabled`
     was `true`.
   - Rolls back all five native tables, durable intent and audit if an `AFTER INSERT`
     trigger on `crm_audit."crmAuditEntry"` mutates `blocklist`,
     `core."messageChannel"."excludeGroupEmails"` or
     `core.workspace."isInternalMessagesImportEnabled"` before `COMMIT`.
2. **Inbound email save (`InboundEmailImportService` / `saveOrdinaryMessageBatchWithAudit`) policy freshness:**
   - Declines an inbound email (`returns undefined` from
     `saveMessagesAndEnqueueContactCreation` and `{ kind: 'excluded' }` from
     `InboundEmailImportService.importInboundMessage`) if
     `core."messageChannel"."excludeGroupEmails"` is flipped to `true` in DB
     before the save transaction locks the channel.
3. **Calendar save (`CalendarSaveEventsService`) and sync cleanup (`deleteOrdinarySyncCalendarAssociationsWithAudit`) policy & blocklist freshness:**
   - Declines a provider calendar event batch (`{ calendarEventIds: [], applied: false }`,
     0 native writes, 0 audit entries, 0 durable intents) when a workspace-scoped
     or member-scoped `blocklist` rule blocks an attendee at lock time or when
     `core."calendarChannel"."excludePrivateEvents"` is `true` in DB and the
     batch contains a private event (`isPrivate: true`), even if the caller's
     in-memory `calendarChannel.excludePrivateEvents` was `false`.
   - Rolls back `calendarEvent`, `calendarChannelEventAssociation`,
     `calendarEventParticipant`, durable intent and `crmAuditEntry` (and rolls
     back `deleteOrdinarySyncCalendarAssociationsWithAudit`) if an `AFTER INSERT`
     trigger on `crm_audit."crmAuditEntry"` mutates `blocklist` or
     `core."calendarChannel"."excludePrivateEvents"` before `COMMIT`.
