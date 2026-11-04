# LOG150 independent design review

Reviewed `Research/omnichannel_crm/implementation/log150/design.md` and the actual
messaging save services, closed audit owners, canonical omnichannel receipt
callers and PostgreSQL test suites after LOG149. This report covers the proposed
ordinary initial Message save slice. Runtime and source implementation
acceptance belong to the following step.

## Verdict

The proposed Option 3 architecture is sound and aligns with `CalendarSaveEventsService`
(LOG143) and `executeNativeMessageMatchingWithAudit` (LOG149). Extracting pure or
read-only planning methods from `MessagingMessageService`,
`MessagingMessageParticipantService` and `MessagingMessageFolderAssociationService`
while keeping `CrmAuditTransactionContext`, expected row images and raw verification
private to `MessagingSaveMessagesAndEnqueueContactCreationService` avoids new DI
cycles and preserves the canonical receipt save helpers.

Four concrete source-level details require explicit handling during
implementation:

1. In `MessagingMessageService`, a batch with duplicate `externalId` values currently
   overwrites `messageAccumulatorMap[externalId].messageToCreate` while leaving the
   first iteration's orphan entry in `associationToCreateByMessageId`, and a batch
   where a newly created Thread is shared by multiple messages currently lets the
   second message seed `threadSubjectUpdates` without comparing against the first
   message's `receivedAt`.
2. In `WorkspaceRepository.attachToOneRelation`, loading `relations: { message: true }`
   on `messageChannelMessageAssociationsReferencingMessageThread` queries the target
   `message` repository with `withDeleted: true`, whereas the non-canonical branch of
   `saveMessagesWithinTransaction` does not filter out soft-deleted joined messages
   the way the canonical branch does.
3. Read-only planners must not call `assertIssuedOmniNativeScope` or
   `getIssuedNativeCleanupMetadata` on their `transactionScope` parameter, because
   `applyOmniSentReceipt` and `applyOmniIncomingReceiptWithinTransaction` pass a
   `withOmniRepositoryOptions` wrapper object rather than the raw registered scope.
4. Existing PostgreSQL tests in `ordinary-native-sync-run.postgres-spec.ts` and
   `crm-audit-message-import-matching.postgres-spec.ts` have fixture and assertion
   assumptions written before initial save enforced LOG149 authority or emitted
   initial-save audit rows.

## Source-confirmed contracts

`MessagingSaveMessagesAndEnqueueContactCreationService` currently runs the initial
save transaction with `commitOutcome: 'strict'` only when `expectedRun` is defined,
and without `nativeOwnershipLock: 'exclusive'`. Upgrading
`saveOrdinaryMessageBatchWithAudit` to `{ commitOutcome: 'strict',
nativeOwnershipLock: 'exclusive' }` for all five ordinary origins is required by
`getIssuedNativeCleanupMetadata` and coordinates with the existing omnichannel
native ownership fence.

The aggregate computes `shouldCreateContact` from `messageChannel`
(`excludeNonProfessionalEmails`, `excludeGroupEmails`, `contactAutoCreationPolicy`,
`isContactAutoCreationEnabled`, `type`) and `connectedAccount` (`handle`, `handleAliases`),
where `MessagingMessagesImportService` refreshes `handleAliases` in memory before
calling save. Capturing the full input and these channel/account settings before
the first `await` preserves existing contact auto-creation semantics while
`message-import-authority-proof` verifies the live core authority rows.

The two canonical receipt callers (`applyOmniSentReceipt` and
`applyOmniIncomingReceiptWithinTransaction`) run inside their own strict/exclusive
transactions, wrap the scope with `withOmniRepositoryOptions`, invoke
`saveMessagesWithinTransaction` with `canonicalThreadIdByThreadExternalId` and then
invoke `saveMessageParticipants`. Delegating discovery to the extracted planners
while keeping the existing write path in `saveMessagesWithinTransaction` and
`saveMessageParticipants` preserves their postconditions, avoids a second
transaction and prevents duplicate `crmRecord` audit entries alongside their
domain `omniMessage`/`omniMessageThread`/`omniMessageParticipant`/`omniMessageAssociation`
audit.

## Locking, graph proofs and batch edge cases

Taking sorted `SHARE ROW EXCLUSIVE` table locks on `messageThread`, `message`,
`messageChannelMessageAssociation`, `messageParticipant` and
`messageChannelMessageAssociationMessageFolder` plus `SHARE` on `messageThreadTarget`
before discovery is necessary and sufficient to fence absent deduplication
candidates. Standard metadata defines no unique index on `message.headerMessageId`,
on `messageChannelMessageAssociation(messageChannelId, messageExternalId)`, on
`messageChannelMessageAssociation(messageChannelId, messageThreadExternalId)` or
on `messageParticipant(messageId, handle, role)`, so row locks alone cannot prevent
concurrent raw inserts from racing deduplication lookups across channels.

The `readSaveGraph` predicates for `message-save-proof.ts` must cover the actual
join paths and fixed lookup predicates of the five write tables and one
read-only target table:

- `messageThread`: `id = ANY(rootThreadIds) OR id = ANY(originalThreadIds)`, where
  `rootThreadIds` includes discovered existing thread IDs and planned new thread
  IDs.
- `message`: `"messageThreadId" = ANY(rootThreadIds) OR "headerMessageId" =
  ANY(headerMessageIds) OR id = ANY(originalMessageIds)`, so a same-transaction
  trigger inserting a matching `headerMessageId` under another thread cannot
  escape verification.
- `messageParticipant`: `"messageId" = ANY(messageIds) OR id =
  ANY(originalParticipantIds)`.
- `messageChannelMessageAssociation`: `"messageId" = ANY(messageIds) OR
  ("messageChannelId" = $channelId AND ("messageExternalId" = ANY(externalIds) OR
  "messageThreadExternalId" = ANY(threadExternalIds))) OR id =
  ANY(originalAssociationIds)`.
- `messageChannelMessageAssociationMessageFolder`:
  `"messageChannelMessageAssociationId" = ANY(associationIds) OR id =
  ANY(originalJunctionIds)`.
- `messageThreadTarget`: `"messageThreadId" = ANY(rootThreadIds) OR id =
  ANY(originalTargetIds)`, locked `FOR SHARE` and verified unchanged from before
  Stage 1 through post-flush constraint drain.

Batch and planner edge cases to address in the extracted planners and owner:

- Duplicate `externalId` or shared `existingMessageInDB` in one batch:
  `messageAccumulatorMap` is keyed by `externalId` while `associationToCreateByMessageId`
  is keyed by `messageId`. Reject duplicate `externalId`s upfront and verify that
  every `externalId` mapping resolves to an actual persisted live row in the
  captured channel.
- Shared Thread subject updates within one batch:
  Seed `createdThreadReceivedAt` from `threadToCreate` so subsequent messages in
  the same batch for a newly created Thread compare against the initial message's
  `receivedAt`. Stage 1b updates the newly inserted thread in `state.expected` via
  `updateMany` so `finishSaveAudit` emits a single `create` audit from `null` to
  the final image, while existing threads emit a single `update` audit from the
  original image to the final image without using `upsert`.
- Soft-deleted relation targets and update parents:
  `WorkspaceRepository.attachToOneRelation` loads `message` on
  `messageChannelMessageAssociationsReferencingMessageThread` with `withDeleted:
  true`. Filter out associations whose joined `message` has `deletedAt !== null`
  and verify all resolved parents are live (`deletedAt === 'null'`).
- Repeated participant update criteria:
  Split `updateSaveRecords` batches whenever a `criteria` ID repeats in the
  current chunk (matching `CalendarSaveEventsService.updateSaveRecords`) so
  `messageSaveActualIds` never sees duplicate `RETURNING` IDs in one batch.
- Full expected images vs skipped or rewritten DML:
  Use `castCalendarProofImage` from `calendar-target-proof.ts` (which includes
  both non-generated column defaults and generated columns such as `searchVector`)
  and compare full row snapshots after `insert` and `updateMany`. Required creates
  verify `RETURNING` count and actual row presence; skipped optional updates
  retain the old image without fabricating audit or returning untouched
  participants to post-save matching.

## Authority and source proofs

- Factored LOG149 authority proof (`message-import-authority-proof.ts`):
  Reuse `verifyMessageImportAuthority`'s exact lock order (`user` -> `userWorkspace`
  -> `application` -> `agent` -> `connectedAccount` -> `messageChannel`) and
  re-run its verifier before writes and after `SET CONSTRAINTS ALL IMMEDIATE`.
- Native `Person` and `WorkspaceMember` source `SHARE` locks:
  Lock `person` and `workspaceMember` when supplied participant inputs or
  discovered existing participants reference them. Supplied `personId` and
  `workspaceMemberId` references must exist with `deletedAt === null`, while
  existing participant references must exist and remain unchanged through
  finalization.
- `core.messageFolder` proof:
  Validate UUID format on all supplied `messageFolderIds`, lock the requested
  `core.messageFolder` rows `FOR SHARE` using `SELECT id, "workspaceId",
  "messageChannelId"`, verify `workspaceId = scope.workspaceId` and
  `messageChannelId = authority.channelId`, verify no folder or native record is
  omni-owned, and re-verify the folder snapshot through finalization.

## Test suite and caller compatibility

1. `ordinary-native-sync-run.postgres-spec.ts` schema and seed setup:
   Extend `core.connectedAccount` with `scope` and `"userWorkspaceId"`,
   `core.messageChannel` with `handle`, create `core."user"`,
   `core."userWorkspace"`, `core.application` and `core.agent`, seed valid
   authority rows for non-provider test calls, and use a `BEFORE INSERT` trigger
   on `messageParticipant` for the participant write failure test (matching the
   calendar branch).
2. `crm-audit-message-import-matching.postgres-spec.ts` aggregate tests:
   Update the three end-to-end aggregate handoff tests to expect the committed
   initial-save `crmRecord` audit entries before the contact queue runs and when
   post-save matching fails, and arm the matching-failure trigger inside
   `contacts.add` so it fails only the post-save matching transaction.

## Acceptance emphasis

- Ordinary initial save records exact `create`/`update` `crmRecord` audit entries
  with redacted field hashes, `implicitUpdatedAtFieldId` on genuine updates and
  one flush before `COMMIT`, while canonical receipt callers produce no duplicate
  `crmRecord` audit or nested transactions.
- Shared new and existing Thread subject updates in a multi-message batch produce
  one `create` audit (`null` to final image) for newly created threads and one
  `update` audit (original image to final image) for existing threads, using
  proven existing-row `updateMany` semantics instead of `upsert`.
- Silent `BEFORE INSERT` / `BEFORE UPDATE` triggers that skip (`RETURN NULL`) or
  rewrite columns (including defaulted or generated `searchVector` columns) are
  caught: skipped required creates fail the batch, rewritten rows fail image
  verification, and skipped optional updates retain the old image without
  fabricating audit or returning untouched participants to post-save matching.
- Mutating incoming foreign key actions on `messageThread` or `messageParticipant`
  updates are rejected by `assertNoReferentialUpdateEffects` before DML executes.
- Any immediate or deferred trigger mutation to read-only `messageThreadTarget`,
  `Person`, `WorkspaceMember`, `core.messageFolder` or authority rows rolls back
  the save and its audit entries after `SET CONSTRAINTS ALL IMMEDIATE`.
- Supplied `core.messageFolder` IDs from a missing row, foreign workspace,
  foreign channel or omni-owned channel/folder are rejected before junction writes.
- Supplied `Person` and `WorkspaceMember` IDs on ingested participants must be
  live rows in the workspace, while concurrent raw inserts on the five write
  tables block on the `SHARE ROW EXCLUSIVE` table locks.
- Lost `COMMIT` acknowledgement surfaces `NativeTransactionOutcomeUnknownError`
  so provider import callers skip cache requeue and status progression, and
  `sent` / `sent-tool` callers preserve the single confirmed external send.
