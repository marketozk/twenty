# LOG155 independent design review

Reviewed `Research/omnichannel_crm/implementation/log155/design.md`,
`Research/omnichannel_crm/implementation/log155/test-research.md`, and the
actual `MessagingSaveMessagesAndEnqueueContactCreationService`,
`InboundEmailImportService`, `MessagingMessagesImportService`,
`CalendarSaveEventsService`, `CalendarEventsImportService`,
`deleteOrdinarySyncCalendarAssociationsWithAudit`,
`native-message-cleanup-with-audit.ts`, `message-import-authority-proof.ts`,
`filter-emails.util.ts`, `filter-events-and-return-events-to-remove.util.ts`,
`crm-audit-ordinary-message-save.postgres-spec.ts`,
`ordinary-native-sync-run.postgres-spec.ts`,
`calendar-save-audit.postgres-spec.ts`, and
`scripts/omnichannel/check_enterprise_dependencies.py` files after LOG154
(`3c2d4521`). This report covers transactional import-policy and blocklist
freshness on message and calendar save (part of ROB-765). Runtime and source
implementation acceptance belong to the following step.

## Verdict

The proposed architecture is sound and closes the fetch-to-save policy and
blocklist race across provider message import, inbound email import, provider
calendar event import, and calendar sync cleanup without introducing a database
migration or breaking existing fork-migration suites.

Four concrete source-level details require explicit handling during
implementation:

1. **Strict Enterprise dependency isolation (`scripts/omnichannel/check_enterprise_dependencies.py`) for `import-policy-proof.ts` and message save:**
   - In `check_enterprise_dependencies.py`, `packages/twenty-shared/src/types/index.ts`
     (`twenty-shared/types`) and `packages/twenty-shared/src/utils/index.ts`
     (`twenty-shared/utils`) are inside `runtime_enterprise_reachable` (`True`).
   - Because `filter-emails.util.ts`, `filter-out-blocklisted-messages.util.ts`,
     `filter-out-ics-attachments.util.ts`, `filter-out-internals.util.ts`,
     `filter-out-unsubscribe-requests.util.ts`,
     `is-excluded-group-email-message.util.ts`, and `is-upstream-spam.util.ts`
     import `message.type.ts`, `twenty-shared/types`, or `twenty-shared/utils`,
     all seven files are in `runtime_enterprise_reachable` (`True`). Importing
     any of those seven files into `import-policy-proof.ts` or
     `messaging-save-messages-and-enqueue-contact-creation.service.ts` creates a
     new `enterprise_edges` entry and fails `check_enterprise_dependencies.py`.
   - By contrast, `twenty-shared/application-runtime`,
     `crm-audit-canonical-json.ts`, `native-crm-audit-record.ts`,
     `omni-native-write-capability.ts`, `has-referencing-records.ts`,
     `filter-events-and-return-events-to-remove.util.ts`,
     `is-email-blocklisted.util.ts`, `is-group-email.ts`, `is-work-email.ts`,
     `get-domain-from-email.ts`, `message-direction.enum.ts`,
     `auto-generated-body-marker.constant.ts`,
     `unsubscribe-command-subject.constant.ts`,
     `unsubscribe-keyword-pattern.constant.ts`,
     `upstream-spam-verdict-headers.constant.ts`, `@sniptt/guards`, `psl`, and
     `class-validator` are all outside `runtime_enterprise_reachable` (`False`).
   - Therefore, `import-policy-proof.ts` must not import `twenty-shared/types`,
     `twenty-shared/utils`, `message.type.ts`, or the `filter-*.util.ts` /
     `is-excluded-group-email-message.util.ts` / `is-upstream-spam.util.ts`
     wrappers. Instead, `import-policy-proof.ts` should expose self-contained
     provider and inbound message policy admission helpers built directly on the
     non-Enterprise-reachable primitives above.

2. **`captureLockedBlocklistPolicyProof` lock ordering, member-scope resolution, and optional fixture metadata:**
   - Resolve `'blocklist'` and `'workspaceMember'` shapes from
     `getIssuedNativeCleanupMetadata(scope).objects` using
     `STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS` and
     `TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER`. When `'blocklist'` is
     absent from the fixture's `additionalTables` (such as
     `ordinary-native-sync-run.postgres-spec.ts`,
     `calendar-save-audit.postgres-spec.ts`, and
     `crm-audit-calendar-sync-cleanup.postgres-spec.ts`), return
     `{ applicableBlocklistHandles: [], verify: async () => undefined }`.
   - When both `'blocklist'` and `'workspaceMember'` shapes exist, verify they
     share `schemaName` and that `getIncomingRecordForeignKeys` confirms the
     `blocklist."workspaceMemberId" -> workspaceMember.id` foreign key, matching
     `LOG137` (`native-message-cleanup-with-audit.ts`, lines 1700-1706).
   - Acquire `LOCK TABLE ... IN SHARE MODE` on `workspaceMember` (when present)
     and `blocklist`, then lock and snapshot `blocklist` rows
     (`SELECT id FROM <blocklist> ORDER BY id FOR SHARE` +
     `readNativeCrmAuditRows`).
   - Extract `memberIds` from non-`WORKSPACE` `blocklist` rows. If
     `memberIds.length > 0` and `'workspaceMember'` metadata is absent, throw an
     error. When `'workspaceMember'` metadata is present and `memberIds.length > 0`,
     lock and snapshot the referenced `workspaceMember` rows (`FOR SHARE`),
     extract their `userId` values, and when `to_regclass('core."userWorkspace"')`
     is non-null (and `userIds.length > 0` or `isUUID(userWorkspaceId)`), lock
     and read `core."userWorkspace"` (`FOR SHARE` where `"workspaceId" = $1` and
     `("userId" = ANY($2::uuid[]) OR id = ANY($3::uuid[]))` ordered by `id`).
   - Follow `LOG137` (lines 1850-1874) when computing
     `applicableBlocklistHandles`: ignore soft-deleted (`deletedAt !== null`) or
     empty/null-handle `blocklist` rows; include `scope === 'WORKSPACE'` handles;
     for non-`WORKSPACE` rows, require a live `workspaceMember` (`deletedAt === null`),
     reject multiple active `workspaceMember` or `core."userWorkspace"` rows for
     the same `userId` (`'Import blocklist policy ambiguous member policy source'`),
     and include the rule handle only when `userWorkspaceId` is a UUID and the
     member's single active `core."userWorkspace"` row matches
     `userWorkspaceId.toLowerCase()` (or, if `core."userWorkspace"` is absent in
     a minimal fixture, when no `core."userWorkspace"` table exists).
   - In `verify()`, re-read `blocklist`, `workspaceMember`, and
     `core."userWorkspace"` and throw `'Import blocklist policy sources changed before commit'`
     if any snapshot drifted.

3. **Schema-tolerant policy refresh and `filterOutInternals` gating in `saveOrdinaryMessageBatchWithAudit`:**
   - Read `SELECT to_jsonb(w) AS row FROM core.workspace w WHERE w.id=$1`,
     `SELECT to_jsonb(a) AS row FROM core."connectedAccount" a WHERE a.id=$1 AND a."workspaceId"=$2`,
     and `SELECT to_jsonb(c) AS row FROM core."messageChannel" c WHERE c.id=$1 AND c."workspaceId"=$2`,
     and register a validator in `state.validators` asserting that the locked
     workspace, account, and channel policy fields do not drift before `COMMIT`.
   - Refresh `messageChannel` (`handle`, `isContactAutoCreationEnabled`,
     `contactAutoCreationPolicy`, `excludeNonProfessionalEmails`,
     `excludeGroupEmails`) and `connectedAccount` (`handle`, `handleAliases`)
     from the locked DB rows only when the respective `to_jsonb` property is
     present and non-null (for example, `typeof channelJson.excludeGroupEmails === 'boolean'`).
     This ensures DB-level policy changes override stale in-memory caller values
     while preserving minimal test fixtures such as
     `ordinary-native-sync-run.postgres-spec.ts` (lines 661-662) and
     `crm-audit-ordinary-message-save.postgres-spec.ts` (lines 739-740), where
     `core."messageChannel"` omits those optional columns.
   - Only enforce internal-email exclusion (`filterOutInternals`) on `'provider'`
     saves when `workspaceJson.isInternalMessagesImportEnabled === false`
     (explicitly `false` in `core.workspace`), preserving synthetic `@example.test`
     fixtures where `core.workspace` has no `isInternalMessagesImportEnabled`
     column.
   - Return the refreshed `isContactAutoCreationEnabled` and `connectedAccount`
     from `saveOrdinaryMessageBatchWithAudit` so `saveMessagesAndEnqueueContactCreation`
     gates and dispatches `CreateCompanyAndContactJob` using the transactionally
     locked values.

4. **Schema-tolerant `userWorkspaceId` and policy proof in `CalendarSaveEventsService` and `deleteOrdinarySyncCalendarAssociationsWithAudit`:**
   - Because `core."connectedAccount"` in `calendar-save-audit.postgres-spec.ts`,
     `crm-audit-calendar-import-recovery.postgres-spec.ts`, and
     `crm-audit-calendar-sync-cleanup.postgres-spec.ts` does not define a
     `"userWorkspaceId"` column, `CalendarSaveEventsService.readSaveSources` and
     `lockCalendarSyncAuthority` in `native-calendar-cleanup-with-audit.ts` must
     extract `to_jsonb(account)->>'userWorkspaceId' AS "userWorkspaceId"` (and in
     `lockCalendarSyncAuthority`, `to_jsonb(account)->'handleAliases'` and
     `to_jsonb(channel)->'excludePrivateEvents'`, `to_jsonb(channel)->>'handle'`)
     rather than referencing those optional columns directly in SQL.
   - In `CalendarSaveEventsService.saveCalendarEventsAndEnqueueContactCreationJob`,
     when `expectedRun` is defined, capture `captureLockedBlocklistPolicyProof`
     after `lockSaveSources`, verify it inside `verifySaveGraph(auditState)`,
     and check `filterEventsAndReturnEventsToRemove(channelHandles, fetchedCalendarEvents, blocklistProof.applicableBlocklistHandles, Boolean(calendarChannel.excludePrivateEvents)).filteredEvents.length === fetchedCalendarEvents.length`,
     returning `null` (`{ calendarEventIds: [], applied: false }`) before any
     native write if any event is excluded.
