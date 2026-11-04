# LOG150 test research

Read-only source review of the ordinary Message save path and existing PostgreSQL
and unit test suites after LOG149 publication. No source or runtime changes are
claimed by this document.

## Existing suites and their current boundaries

| Suite | Current coverage | Gap for LOG150 |
|---|---|---|
| `test/fork-migration/ordinary-native-sync-run.postgres-spec.ts` | Real aggregate save and provider expectedRun checks for message and calendar, concurrent same-channel save serialization, lost COMMIT ACK, nullable participants, APP targetsOnly handoff | Message branch previously executed without an audit owner or general non-provider authority proof inside the initial save transaction, and simulated participant failure with a service spy rather than a database trigger |
| `test/fork-migration/crm-audit-message-import-matching.postgres-spec.ts` | Post-save matching owner, five authority descriptors, paging, deferred authority drift, and three end-to-end aggregate handoff cases | The three aggregate handoff cases expected zero audit rows after initial save because only post-save matching was audited in LOG149 |
| `test/fork-migration/omni-native-message.postgres-spec.ts` | Direct `MessagingMessageService.saveMessagesWithinTransaction` and `MessagingMessageParticipantService.saveMessageParticipants` canonical thread and conflict behavior | Must remain green when read-only planners are extracted from the three services |
| `test/fork-migration/omni-history-apply.postgres-spec.ts` and `omni-history-first-conversation.postgres-spec.ts` | Canonical incoming/history receipt apply through `saveMessagesWithinTransaction` and `saveMessageParticipants` | Regression control proving canonical omni receipt callers do not acquire a duplicate audit owner or lose canonical conflict checks |
| `test/fork-migration/omni-sent-apply-facade.spec.ts` | Canonical sent receipt apply facade and postconditions | Regression control for canonical sent receipt caller |

## Fixture and schema requirements

The ordinary save owner writes five native workspace tables (`messageThread`,
`message`, `messageChannelMessageAssociation`, `messageParticipant`,
`messageChannelMessageAssociationMessageFolder`) and holds `messageThreadTarget`
as a read-only graph table. Referenced `person` and `workspaceMember` records are
read-only native sources when participant inputs or existing rows carry those IDs.
`core.messageFolder` is a core table referenced by folder junction inputs.

In `ordinary-native-sync-run.postgres-spec.ts`, the message branch now enters the
same authority proof as LOG149. Its `core` test schema needs the `scope` and
`userWorkspaceId` columns on `core.connectedAccount`, `handle` on
`core.messageChannel`, and `core.user`, `core.userWorkspace` and
`core.application` tables for non-provider (`sent` and `application`) test calls,
plus `workspaceMember` in the native fixture table list. Its participant-failure
rollback test can use a real `BEFORE INSERT ON messageParticipant` trigger on par
with the calendar branch.

In `crm-audit-message-import-matching.postgres-spec.ts`, the three aggregate
handoff cases (`actual aggregate commits save before contact queue and actual
audited matching`, `a failed queue preserves saved rows and identical retry
exposes the documented lost touched-set gap`, and `actual matching failure rolls
back matching while the aggregate save remains committed`) will now observe the
committed initial-save audit entries before the contact queue and when post-save
matching fails. The matching-failure trigger should fail only the post-save
matching transaction (or target/participant matching audit) so it continues to
prove that initial save and its audit remain committed when matching rolls back.

## New PostgreSQL and unit cases required for LOG150

1. **Five-table atomic save and audit:** Ordinary save creates `messageThread`,
   `message`, `messageChannelMessageAssociation`, `messageParticipant` and
   `messageChannelMessageAssociationMessageFolder` in one strict/exclusive
   transaction and emits redacted `crmRecord` audit entries with one shared
   `operationId` and `correlationId` before `COMMIT`.
2. **Thread subject resolution and existing-thread updates:** Multiple new
   messages sharing a newly created Thread in one batch record a single `create`
   audit entry with the latest `receivedAt` subject, while new messages arriving
   in an existing Thread update its subject once from the original image to the
   latest `receivedAt` subject without allowing an unexpected upsert insert.
3. **Deduplication and cross-channel reuse:** Re-delivery of an existing
   channel `externalId` or global `headerMessageId` reuses the existing native
   `message` and `messageThread`, creates only missing channel associations,
   participants or folder junctions, and emits no fabricated `message` or
   `messageThread` audit diff.
4. **Participant create vs identity/displayName update:** Re-ingesting an
   existing participant with newly supplied `personId`, `workspaceMemberId` or
   non-empty `displayName` records an `update` audit entry and includes the row
   in the touched manifest; an unchanged existing participant emits no audit and
   is omitted from the touched manifest; a skipped update retains the old image
   and is omitted from the touched manifest.
5. **Required create skip and rewritten row refusal:** A `BEFORE INSERT` trigger
   that skips (`RETURN NULL`) a planned `messageThread`, `message`,
   `messageChannelMessageAssociation`, `messageParticipant` or folder junction,
   or rewrites a planned column value, fails the transaction atomically rather
   than returning a nonexistent planned UUID in the output maps.
6. **Read-only `messageThreadTarget` and source proofs:** Any trigger on the five
   write tables or `crmAuditEntry` that mutates `messageThreadTarget`, referenced
   `person` or `workspaceMember` rows, or `core.messageFolder` workspace/channel
   binding rolls back the entire save transaction.
7. **Foreign or missing `core.messageFolder` refusal:** Referencing a nonexistent
   folder ID or a folder belonging to another workspace or another
   `messageChannelId` fails before junction DML and rolls back all earlier stages.
8. **Input capture before awaits:** Mutating caller arrays, `receivedAt` `Date`
   instances, participant objects, `messageFolderIds`, channel flags or account
   `handleAliases` after invocation does not alter saved rows, contact-creation
   filtering or audit attribution.
9. **Five-origin authority proof at initial save:** Provider stale `expectedRun`
   returns `undefined` without DML or audit; `inbound` recipient/channel drift,
   `sent` / `sent-tool` archived or unusable account or disabled user/member,
   `application` disabled sync or hidden private connection, and omni-owned
   channels refuse before native writes; deferred authority drift rolls back at
   finalization.
10. **Canonical omni receipt compatibility:** Existing `applyOmniSentReceipt` and
    `applyOmniHistoryReceipt` / `applyOmniIncomingTextReceipt` paths continue to
    use `saveMessagesWithinTransaction` and `saveMessageParticipants` without
    creating a second transaction or duplicate audit entries.
