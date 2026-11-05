# LOG155 independent owner implementation review

Reviewed the transactional import-policy and blocklist freshness implementation
for provider and inbound message save, provider calendar event save, and
ordinary sync calendar association cleanup (`import-policy-proof.ts`,
`MessagingSaveMessagesAndEnqueueContactCreationService`,
`InboundEmailImportService`, `CalendarSaveEventsService`, and
`deleteOrdinarySyncCalendarAssociationsWithAudit`), Enterprise dependency
isolation, unit entrypoint tests, and PostgreSQL integration test suites against
`Research/omnichannel_crm/implementation/log155/design.md` and
`Research/omnichannel_crm/implementation/log155/design-review.md`. No source or
runtime files were modified during this review.

## Verdict

No remaining blocking defects, race conditions, SQL injection or authority
bypass vectors, or Enterprise dependency violations were identified in the
inspected working tree changes:

- `packages/twenty-server/src/engine/core-modules/crm-audit/import-policy-proof.ts`
- `packages/twenty-server/src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service.ts`
- `packages/twenty-server/src/modules/messaging/message-import-manager/drivers/inbound-email/services/inbound-email-import.service.ts`
- `packages/twenty-server/src/modules/calendar/calendar-event-import-manager/services/calendar-save-events.service.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/native-calendar-cleanup-with-audit.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-message-import-entrypoints.spec.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-import-policy-freshness.postgres-spec.ts`

All four implementation details raised in `design-review.md` and all five review
check items are accurately implemented.

## Verification of design-review.md findings and review checks

1. **Strict Enterprise dependency isolation (`scripts/omnichannel/check_enterprise_dependencies.py`):**
   `packages/twenty-server/src/engine/core-modules/crm-audit/import-policy-proof.ts`
   imports only `@sniptt/guards`, `class-validator`, `psl`,
   `twenty-shared/application-runtime`, `crm-audit-canonical-json.ts`,
   `native-crm-audit-record.ts`, `omni-native-write-capability.ts`,
   `has-referencing-records.ts`, `is-email-blocklisted.util.ts`,
   `message-direction.enum.ts`, `auto-generated-body-marker.constant.ts`,
   `unsubscribe-command-subject.constant.ts`,
   `unsubscribe-keyword-pattern.constant.ts`,
   `upstream-spam-verdict-headers.constant.ts`, `is-group-email.ts`,
   `get-domain-from-email.ts`, and `is-work-email.ts`. It avoids importing
   `twenty-shared/types`, `twenty-shared/utils`, `message.type.ts`,
   `is-unsubscribe-email.util.ts`, `filter-emails.util.ts`,
   `filter-out-blocklisted-messages.util.ts`,
   `filter-out-ics-attachments.util.ts`, `filter-out-internals.util.ts`,
   `filter-out-unsubscribe-requests.util.ts`,
   `is-excluded-group-email-message.util.ts`, and `is-upstream-spam.util.ts`,
   introducing zero Enterprise dependency edges or opaque/unresolved imports in
   `scripts/omnichannel/check_enterprise_dependencies.py`.
2. **`captureLockedBlocklistPolicyProof` locking, FK verification, member-scope resolution, and pre-commit re-verification:**
   - Resolves standard `'blocklist'` and `'workspaceMember'` table shapes from
     `getIssuedNativeCleanupMetadata(scope)` using
     `STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS` and
     `TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER`, returning
     `{ applicableBlocklistHandles: [], verify: async () => undefined }` when
     `'blocklist'` metadata or the physical `blocklist` table is absent in
     minimal test fixtures.
   - Verifies that `workspaceMember` shares `blocklistShape.schemaName` and,
     when the physical `workspaceMember` table exists, enforces the
     `blocklist."workspaceMemberId" -> workspaceMember.id` foreign key via
     `getIncomingRecordForeignKeys`.
   - Locks `blocklist` and `workspaceMember` (when physically present) in sorted
     order with `LOCK TABLE ... IN SHARE MODE`.
   - Locks and snapshots all `blocklist` rows (`ORDER BY id FOR SHARE` +
     `readNativeCrmAuditRows`), referenced `workspaceMember` rows for
     non-`WORKSPACE` rules (`WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE` +
     `readNativeCrmAuditRows`), and `core."userWorkspace"` rows
     (`WHERE "workspaceId"=$1 AND ("userId"=ANY($2::uuid[]) OR id=ANY($3::uuid[])) ORDER BY id FOR SHARE`).
   - Resolves active `WORKSPACE` rules and active member-scoped rules whose
     single active `core."userWorkspace"` row matches normalized
     `userWorkspaceId`, throwing
     `'Import blocklist policy ambiguous member policy source'` when multiple
     active memberships exist for the same `userId`.
   - Re-reads `blocklist`, `workspaceMember`, and `core."userWorkspace"` in
     `verify()` and throws
     `'Import blocklist policy sources changed before commit'` if any snapshot
     drifts before `COMMIT`.
3. **`captureLockedMessageImportPolicyProof` projections, live channel/account refresh, and admission checks:**
   - Snapshots `to_jsonb` projections of `core.workspace` (`id`, `deletedAt`,
     `isInternalMessagesImportEnabled`), `core."connectedAccount"` (`id`,
     `workspaceId`, `userWorkspaceId`, `handle`, `handleAliases`), and
     `core."messageChannel"` (`id`, `workspaceId`, `connectedAccountId`,
     `handle`, `isContactAutoCreationEnabled`, `contactAutoCreationPolicy`,
     `excludeNonProfessionalEmails`, `excludeGroupEmails`), validating
     `handleAliases` and delegating blocklist locking to
     `captureLockedBlocklistPolicyProof`.
   - Schema-tolerantly refreshes `messageChannel` and `connectedAccount` from
     the locked DB rows when the projected fields are present, falling back to
     the caller's values when optional columns are omitted in minimal test
     fixtures.
   - In `saveOrdinaryMessageBatchWithAudit`, registers `policyProof.verify` in
     `state.validators`, updates `messageChannel`, `connectedAccount`, and
     `handleAliases` from the locked proof so `shouldCreateContact` and
     `CreateCompanyAndContactJob` dispatch use the transactionally locked
     policy, and declines the batch (`return undefined`) before any native write
     when `policyProof.areMessagesAdmitted(context.authority.kind, messagesToSave)`
     returns `false`.
   - Enforces `.ics` attachment filtering, unsubscribe request filtering,
     blocklist filtering, `excludeGroupEmails` filtering, and
     `isInternalMessagesImportEnabled === false` + `isWorkEmail` internal-email
     filtering on `'provider'` saves, and upstream spam header +
     `excludeGroupEmails` filtering on `'inbound'` saves.
   - Re-verifies the `to_jsonb` projections and `blocklistProof` in `verify()`
     before `state.audit.flush()` and after `SET CONSTRAINTS ALL IMMEDIATE`.
4. **External source cleanup and `'excluded'` outcome in `InboundEmailImportService.importInboundMessage`:**
   When `saveMessagesAndEnqueueContactCreation` returns `undefined` under live
   transaction policy or authority checks, `InboundEmailImportService.importInboundMessage`
   calls `await messageSource.cleanup(messageReference.reference)` and returns
   `{ kind: 'excluded', workspaceId, messageChannelId: messageChannel.id }`,
   while still skipping external source cleanup when
   `saveMessagesAndEnqueueContactCreation` throws.
5. **Transactional blocklist/policy proof and stale-batch rejection in `CalendarSaveEventsService` and `deleteOrdinarySyncCalendarAssociationsWithAudit`:**
   - `CalendarSaveEventsService.readSaveSources` extracts
     `to_jsonb(account)->>'userWorkspaceId' AS "userWorkspaceId"` alongside the
     locked channel and account policy columns. When `expectedRun` is defined,
     `saveCalendarEventsAndEnqueueContactCreationJob` captures
     `captureLockedBlocklistPolicyProof`, registers `blocklistProof.verify` on
     `auditState.verifyPolicy` (checked in `verifySaveGraph` before every write
     batch, before `state.audit.flush()`, and after
     `SET CONSTRAINTS ALL IMMEDIATE`), and evaluates
     `filterEventsAndReturnEventsToRemove(channelHandles, fetchedCalendarEvents, blocklistProof.applicableBlocklistHandles, Boolean(calendarChannel.excludePrivateEvents))`.
     If `filteredEvents.length !== fetchedCalendarEvents.length`, it returns
     `null` (`{ calendarEventIds: [], applied: false }`) before any native write
     or deferred intent insert.
   - `lockCalendarSyncAuthority` in
     `packages/twenty-server/src/engine/core-modules/crm-audit/native-calendar-cleanup-with-audit.ts`
     snapshots `to_jsonb("connectedAccount")->>'userWorkspaceId'`,
     `to_jsonb("connectedAccount")->'handleAliases'`,
     `to_jsonb("calendarChannel")->>'handle'`, and
     `to_jsonb("calendarChannel")->'excludePrivateEvents'` together with
     `captureLockedBlocklistPolicyProof`, and re-verifies both in
     `session.validators` across every cleanup stage and before `COMMIT`.

## Security, transactional integrity and test coverage checks

1. **SQL injection and identifier safety:**
   All SQL queries in `import-policy-proof.ts`,
   `MessagingSaveMessagesAndEnqueueContactCreationService`,
   `CalendarSaveEventsService`, and `native-calendar-cleanup-with-audit.ts` use
   parameterized placeholders (`$1..$N`), strict UUID validation (`isUUID`), and
   quoted schema/table identifiers from verified standard metadata shapes.
2. **Pre-commit drift protection:**
   Both message save (`state.validators` in `verifyMessageSaveGraph`) and
   calendar save/cleanup (`auditState.verifyPolicy` in `verifySaveGraph` and
   `session.validators` in `finalizeCalendarCleanupSession`) re-verify the
   locked workspace/account/channel policy projections and the locked
   `blocklist` / `workspaceMember` / `core."userWorkspace"` snapshots before
   `audit.flush()` and after `SET CONSTRAINTS ALL IMMEDIATE`, ensuring any
   mid-transaction policy or blocklist drift aborts the transaction and rolls
   back all native writes, durable matching intents, and audit entries.
3. **Unit and PostgreSQL integration test coverage:**
   - `crm-audit-message-import-entrypoints.spec.ts` verifies that
     `InboundEmailImportService.importInboundMessage` cleans up the external
     message source and returns `{ kind: 'excluded', workspaceId, messageChannelId }`
     when `saveMessagesAndEnqueueContactCreation` returns `undefined`.
   - `crm-audit-import-policy-freshness.postgres-spec.ts` verifies against real
     PostgreSQL that provider message save declines blocklisted participants for
     workspace and matching member rules while ignoring other members' rules,
     enforces live DB `excludeGroupEmails`, `isInternalMessagesImportEnabled`,
     and `isContactAutoCreationEnabled` across provider and inbound saves, rolls
     back message save + durable intent + audit on late blocklist drift via
     trigger injection, declines provider calendar event save on live blocklist
     or `excludePrivateEvents`, and rolls back
     `deleteOrdinarySyncCalendarAssociationsWithAudit` on late blocklist drift.
