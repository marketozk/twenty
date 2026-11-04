# LOG150 independent owner implementation review

Reviewed the closed ordinary initial Message save owner, extracted read-only
planners, factored import authority proof and PostgreSQL test suites against
`Research/omnichannel_crm/implementation/log150/design.md` and
`Research/omnichannel_crm/implementation/log150/design-review.md`. No source or
runtime files were modified during this review.

## Verdict

No remaining blocking defects, race conditions or authority/ownership gaps were
identified in the inspected working tree changes:

- `packages/twenty-server/src/engine/core-modules/crm-audit/message-import-authority-proof.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/message-save-proof.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/native-message-cleanup-with-audit.ts`
- `packages/twenty-server/src/modules/messaging/message-import-manager/services/messaging-message.service.ts`
- `packages/twenty-server/src/modules/messaging/message-participant-manager/services/messaging-message-participant.service.ts`
- `packages/twenty-server/src/modules/messaging/message-import-manager/services/messaging-message-folder-association.service.ts`
- `packages/twenty-server/src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-ordinary-message-save.postgres-spec.ts`
- `packages/twenty-server/test/fork-migration/ordinary-native-sync-run.postgres-spec.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-message-import-matching.postgres-spec.ts`

All four implementation details raised in `design-review.md` (duplicate
`externalId` rejection and shared-Thread `createdThreadReceivedAt` seeding,
filtering soft-deleted joined messages on thread associations, keeping read-only
planners free of raw scope metadata assertions, and updating existing PostgreSQL
test fixtures/assertions) are properly implemented.

## Introduced flow and ownership verification

`MessagingSaveMessagesAndEnqueueContactCreationService.saveMessagesAndEnqueueContactCreation`
validates workspace, channel, account and provider sync-run alignment and
captures an immutable copy of the input batch (`receivedAt` `Date` instances,
participants, lowercase validated `personId`/`workspaceMemberId`/`messageFolderIds`,
and channel/account contact auto-creation settings) before the first `await`.
Batches with missing or duplicate `externalId` values are rejected upfront.

`saveOrdinaryMessageBatchWithAudit` enters one strict/exclusive workspace
transaction (`{ commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' }`)
with a fresh `operationId` preserving caller actor, initiator and
`correlationId`. `prepareMessageSaveAudit` verifies issued system cleanup
metadata and exact standard object shapes for all five write tables
(`messageThread`, `message`, `messageChannelMessageAssociation`,
`messageParticipant`, `messageChannelMessageAssociationMessageFolder`),
read-only `messageThreadTarget` and optional source tables (`person`,
`workspaceMember`) within a single workspace schema. It sets an `8s` local lock
timeout, locks `core.workspace` `FOR NO KEY UPDATE`, acquires sorted
`SHARE ROW EXCLUSIVE` table locks on the five write tables plus `SHARE` on
`messageThreadTarget`, and verifies the five required parent-child foreign key
definitions before discovery.

`captureMessageImportAuthorityProof` enforces the exact LOG149 lock and
validation order (`user` -> `userWorkspace` -> `application` -> `agent` ->
`connectedAccount` -> `messageChannel`) plus `lockOrdinaryNativeSyncRun` for
provider runs and `findOmniOwnedMessageChannelIds` for channel ownership. Stale
provider runs return `{ applied: false }` so the aggregate exits with
`undefined` before any native reads, writes, audit, contact queue or matching.

After `prepareMessageSaveWithinTransaction` computes the read-only message plan,
the owner queries any additional thread IDs referenced by raw/soft-deleted
header or channel external-ID matches, locks the six-table native graph in
parent-first order (`FOR UPDATE` on the five write tables, `FOR SHARE` on
`messageThreadTarget`), locks referenced `person` and `workspaceMember` source
rows `FOR SHARE` (requiring live rows for supplied IDs and unchanged snapshots
for all referenced rows), and locks supplied `core.messageFolder` rows `FOR SHARE`
while proving workspace, channel and non-omni ownership.

## Expected images, RETURNING IDs, FK effects and constraint drain

1. Writable masks and full expected PostgreSQL images:
   `messageSaveColumns` restricts writes to the exact planned column set per
   table and rejects composite or `FILES` fields. `insertMessageSaveRecords` and
   `updateMessageSaveRecords` compute complete expected row images through
   `castCalendarProofImage`, covering column defaults, `updatedAt` and generated
   columns (`searchVector`). Inserted rows are re-read via
   `readNativeCrmAuditRows`, checked column-by-column against the planned image
   and verified with `assertNativeCrmDeleteFilesEmpty`.
2. Actual `RETURNING` ID verification:
   `messageSaveActualIds` validates `result.raw` array presence, UUID format,
   membership in the requested ID set, uniqueness and `result.affected` count
   agreement. Skipped required inserts on any of the five write tables or
   skipped required thread subject updates fail the transaction immediately.
   `updateMessageSaveRecords` splits batches when a `criteria` ID repeats so
   sequential updates to the same participant row never collide in one
   `RETURNING` set. When a `BEFORE UPDATE` trigger skips an optional participant
   update, the owner retains the original image in `state.expected`, emits no
   fabricated update audit, and omits the untouched row from
   `savedMessageParticipants`.
3. Incoming FK update effects:
   Before each `updateMany` batch on `messageThread` or `messageParticipant`,
   `updateMessageSaveRecords` computes the full changed-column set from the
   cast expected image and calls `assertNoReferentialUpdateEffects`, rejecting
   any `ON UPDATE CASCADE` / `SET NULL` / `SET DEFAULT` child reference before
   DML executes.
4. Read-only `MessageThreadTarget`, source/folder proofs and deferred drain:
   `verifyMessageSaveGraph` runs before and after every insert/update batch,
   before audit recording, and again after `await state.audit.flush()` and
   `SET CONSTRAINTS ALL IMMEDIATE`. It re-verifies workspace activity, authority
   rows, channel ownership, folder rows and folder ownership, participant source
   snapshots, full six-table graph snapshots (including unchanged
   `messageThreadTarget`), and `findOmniOwnedMessageThreadIds` /
   `findOmniOwnedMessageIds`. Any immediate or deferred trigger mutation to
   targets, sources, folders or authority rolls back the transaction and its
   audit entries.
5. Aggregate audit recording:
   `finishMessageSaveAudit` diffs `state.before` against `state.expected` across
   `MESSAGE_SAVE_WRITE_TABLES`, emitting a single `create` audit (`null` to
   final image) for newly created threads updated in the same batch and a single
   `update` audit with `implicitUpdatedAtFieldId` for existing rows whose image
   changed.

## Canonical omnichannel receipt callers

`applyOmniSentReceipt` and `applyOmniIncomingReceiptWithinTransaction` remain
untouched in their transaction and audit ownership. Both keep their own
strict/exclusive transaction and `withOmniRepositoryOptions` scope wrapper, and
both continue calling `MessagingMessageService.saveMessagesWithinTransaction`
(with `canonicalThreadIdByThreadExternalId`) and
`MessagingMessageParticipantService.saveMessageParticipants`. The extracted
`prepareMessageSaveWithinTransaction`,
`prepareMessageParticipantsWithinTransaction` and
`prepareMessageFolderAssociationsWithinTransaction` methods are read-only,
perform no issued-scope metadata assertions that would reject the omni wrapper,
open no nested transaction and record no duplicate `crmRecord` audit entries.

## Runtime evidence still needed from parent

The parent workflow must run and record the PostgreSQL suites
(`crm-audit-ordinary-message-save.postgres-spec.ts`,
`ordinary-native-sync-run.postgres-spec.ts`,
`crm-audit-message-import-matching.postgres-spec.ts` and canonical receipt
regressions) plus typecheck and dependency/migration guards on the final working
tree before closing the slice. Durable post-save matching intent across crash or
queue failure windows remains the documented follow-on acceptance item under
ROB-765.
