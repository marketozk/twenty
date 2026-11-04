# LOG150 — closed ordinary Message save owner

Proposed concrete design for independent review. Source inspection used the
current MessagingMessageService helpers, ordinary aggregate, canonical receipt
callers, LOG149 authority proof and CalendarSaveEventsService's closed owner.
No repository or runtime changes were made while preparing this document.

## Selected scope

Own the ordinary aggregate's initial save transaction for MessageThread, Message,
MessageChannelMessageAssociation, MessageParticipant and
MessageChannelMessageAssociationMessageFolder. Capture current authority before
writing and record actual changes in one audit flush before COMMIT.

Queue and matching remain after successful save. The durable matching intent is
a separate acceptance criterion. Canonical omni receipt callers keep their own
transaction/audit owner and existing public save-helper contract.

## Alternatives and decision

1. Turn on generic nativeAudit. This fails the existing system-object whitelist
   and would broaden global ORM coverage to unrelated messaging writers.
2. Copy MessageService planning into a new all-purpose service. This duplicates
   matching and threading rules and risks drifting canonical receipt behavior.
3. Extract read-only plans from the existing three services, reuse them in both
   current helpers and a closed ordinary owner in the existing aggregate.

Choose the third option. The aggregate already has all three service dependencies
and WorkspaceOrmManager. No new injectable provider or dependency cycle is needed.
The audit context and expected graph remain private to the ordinary owner.

## APIs and placement

MessagingSaveMessagesAndEnqueueContactCreationService adds a private
saveOrdinaryMessageBatchWithAudit method. It accepts the captured messages,
channel/account settings, workspaceId and validated LOG149 matching context/run.
It enters the existing workspace context and one strict/exclusive transaction.
Its applied result preserves the existing savedMessagesResult shape and adds
only internal verified actual-effect data if needed. A stale provider run returns
undefined consistently with the current aggregate.

MessagingMessageService adds prepareMessageSaveWithinTransaction with the same
scope/input/canonical options as its current save helper. This method performs
the current discovery and accumulator planning only. It returns a typed readonly
MessageGraphSavePlan with the following fields.

- Thread creates and subject updates with predetermined native IDs.
- Message creates and Association creates.
- Existing/native identity references needed to resolve output maps.
- Explicit external-ID -> Message/Thread/Association resolution entries.

The current saveMessagesWithinTransaction delegates discovery/planning to this
method and performs its existing write order. Its signature, canonical validation
and return contract stay available to the two omni receipt callers. The ordinary
owner directly consumes the same plan and performs its audited writes itself.

MessagingMessageParticipantService extracts prepareMessageParticipantsWithinTransaction
from its existing lookup/matching logic. The returned readonly plan contains
creates, identity/name updates and the existing identities referenced by those
decisions. Current saveMessageParticipants consumes this plan with its existing
write path. The ordinary owner assigns deterministic fresh IDs to planned new
participants before expected-image computation and owns their audited writes.

MessagingMessageFolderAssociationService extracts a read-only preparation method
which returns missing Association/Folder pairs using the existing
buildMessageFolderAssociationsToInsert pure helper. The old save method consumes
that plan. The ordinary owner captures new junction IDs and writes them itself.

Planning methods expose no audit context, mutable expected-state object or
write callback. Their inputs and outputs are validated/copied at the owner
boundary. They are read-only internal service methods, not API routes.

Add a small message-save-proof.ts structural leaf for the six native graph names,
the exact writable-column masks and native full-row graph reads. Reuse existing
castCalendarProofImage, actual RETURNING validation, snapshot capture and incoming
FK primitives instead of duplicating their SQL implementations.

Extract LOG149's current authority capture from the native matching module into
a structural read-only message-import-authority-proof.ts helper. Its result is
either applied false or applied true with a read-only verify function. Both
closed owners keep that verifier privately and call it before writes and after
deferred drain. The helper cannot flush audit or mutate domain rows. Existing
scope/captured context validation remains mandatory at each closed entry.

## Captured input and compatibility

The ordinary aggregate copies the entire input before its first await. Include
receivedAt dates, participants, nullable handles/names, identity references,
messageFolderIds, attachments/settings fields it reads, channel settings and
account handleAliases. Use the existing audited-data capture primitive where it
preserves Date representation, and explicitly preserve Date semantics otherwise.
No new message-body normalization or email matching policy is introduced.

Retain the current precedence of channel external-ID matches and global header-ID
matches, Thread reuse, inter-channel behavior, ordinary live-only lookup and
canonical withDeleted/conflict behavior. Tests establish repeated/duplicate input
semantics before an implementation chooses to reject or deduplicate anything.
Input size remains bounded by existing callers, with DML batches split internally
as required by repositories. Do not impose a new 200-message aggregate limit.

Public output maps keep their types and meaning. Ordinary outputs refer only to
verified current rows. A required create skipped by PostgreSQL fails the batch
instead of returning a planned nonexistent ID. For skipped optional updates,
retain the actual old image and omit a fabricated update audit. Return the actual
touched rows used by post-save matching. New targeted tests must distinguish an
unchanged row from a skipped requested update.

## Transaction and lock order

1. Obtain a real SYSTEM strict/exclusive issued workspace scope. Capture the
   complete operation, retaining origin actor/initiator/correlation.
2. Validate exact standard metadata and workspace/schema ownership for all five
   write tables plus read-only MessageThreadTarget. Lock current workspace.
3. Take sorted SHARE ROW EXCLUSIVE locks on the five native write tables before
   deduplication discovery. These protect missing header/external-ID and junction
   matches from raw concurrent DML, including other channels. Take SHARE on the
   read-only Target table. This intentionally serializes ordinary message saves
   within the workspace, consistent with the exclusive native ownership fence.
4. Capture current authority through the factored LOG149 proof using its existing
   user/member/application/agent/account/channel order. A stale provider run exits
   without saving. Sent and sent-tool account archival and principal distinctions
   remain intact. The provider/current channel type must agree with captured mode.
5. Take source SHARE on native Person/WorkspaceMember when supplied or existing
   participant references require them. These sources are read-only. Resolve and
   lock each supplied core.messageFolder row, proving exact workspace/channel.
6. Run the read-only Message plan, then lock existing Thread parents and their
   Message/Participant/Association/Target graph in parent-first order. New IDs and
   fixed external/header predicates remain part of the proof.

Use the established bounded lock timeout. Row locks alone do not protect absent
deduplication candidates because headerMessageId has no global unique constraint.
A per-channel cache lock also cannot protect shared header IDs across channels.
No new index or database constraint is introduced by this slice.

The source/core lock order must be checked against current native writers during
implementation review. Existing canonical owners coordinate through the issued
ownership fence. Raw writers are additionally fenced by native table locks.

## Planning and graph ownership lifecycle

The Message plan can be computed after table locks because no other transaction
can insert/update/delete those native candidates concurrently. Capture full
native rows after plan discovery and before any owner DML. Retain existing roots,
all planned new IDs, fixed header/external-ID predicates and original child IDs.
Original rows moved or deleted by same-transaction triggers remain visible in
the proof through their fixed IDs.

The owner controls this concrete stage order.

1. Insert planned Threads, then apply planned subject updates.
2. Insert planned Messages.
3. Insert planned channel Associations.
4. Build participant inputs from actual verified Message mappings and existing
   contact-creation rules, prepare their read-only plan, then insert/update them.
5. Build folder Association inputs from actual verified maps, prepare missing
   pairs, verify their core Folder authority and insert junctions.
6. Verify the complete final graph and current sources/authority, record the
   aggregate before/after audit, flush once, drain deferred constraints and
   verify again. Return verified maps and touched participants.

The fixed read-only Target proof starts before stage 1 and remains unchanged to
finalization. A Thread/Message/Participant/Association/junction or audit trigger
changing a target must cause rollback. Source Person/WorkspaceMember/core Folder
snapshots and absence requirements remain verified around every stage.

Subject updates preserve the existing latest-receivedAt rule. A Thread created
earlier in the same batch can receive a later Message's subject through the old
upsert path. In the closed owner its final audit is one create from null to final
image. Existing Thread updates produce one update from the original image to
the final image. Use proven existing-row update semantics instead of allowing an
upsert to create a missing parent unexpectedly.

## Expected images and actual effects

For each table enforce a fixed mask of the fields already written by its planner.
Message fields include headerMessageId, subject, receivedAt, text, messageThreadId
and isDraft. Thread writes are id/subject. Association writes contain channel,
message, external IDs and direction. Participant writes preserve the current
handle/displayName/role/identity contract. Junction writes are the two references.

Compute complete expected PostgreSQL images through the existing structural image
primitive, including defaults, timestamps and generated columns. Validate incoming
mutating FK effects against the complete changed-column set before updates.
Only actual RETURNING IDs can advance expected state. Reject unknown or duplicate
IDs and missing required creates. Verify the final actual row images immediately.

Record audit from full before/final expected maps after all stages. The existing
crmRecord capture hashes every native field value, so message text and names
remain redacted in durable audit. Preserve object/record security descriptors and
implicit updatedAt suppression for genuine updates.

Returned createdMessages and created Thread IDs are based on actual verified
creates. Existing mapping entries are reread and checked against the captured
resolved relationships. Association mappings must identify actual current rows in
the captured channel. Never infer persistence solely from a UUID in a plan.

## Existing callers and failure handling

The ordinary aggregate replaces only its initial transaction body with the
closed save method. Its postcommit queue and LOG149 matching call remain in their
current order and use the verified save result. The caller adapters already
capture all five origin variants, including sent-tool, and can reuse that context.

The two canonical omni receipt call sites continue calling
saveMessagesWithinTransaction with canonical options and their domain scope.
The extraction must preserve their observed messages/maps, canonical conflict
checks and audit ownership. Regression tests must detect duplicate audit creation
or a second transaction introduced by the refactor.

Unknown COMMIT acknowledgement propagates as the existing strict unsafe outcome.
Provider callers stop cache replay/status progression for recognized unsafe
outcomes. Application/inbound callers preserve their current error/cleanup
behavior. Sent and sent-tool flows preserve irreversible provider success and
perform no second external send after a persistence/audit failure.

## Durable intent follow-on

LOG150 produces a trustworthy actual-save manifest inside its transaction. It
does not add the deferred matching action yet. The existing deferred-action
framework retries all errors and deletes its record after handler completion,
which requires a separate receipt/page-progress design for unknown commit and
crash windows. Persisted original touched IDs, attribution, authority rechecks,
queue failure and matching replay remain explicit open criteria.

## Implementation and acceptance order

1. Extract read-only planners with narrow behavior regression tests, preserving
   old canonical signatures and outputs. Review the actual call graph and new
   dependency edges before adding the owner.
2. Extract the read-only LOG149 authority proof with unchanged matching tests.
3. Implement the private ordinary owner and fixed structural proof leaf, then
   replace the one ordinary aggregate transaction body.
4. Real PostgreSQL tests cover actual create/update maps, silent skipped or
   rewritten inserts/updates, generated defaults, incoming FK effects, audit
   failure and deferred source/Target mutation.
5. Cover shared Thread subjects, repeated external/header IDs, cross-channel
   deduplication, mutable input, tombstones, nullable participants, APP identities,
   large supported batches and folder junction/core Folder authority.
6. Verify raw absence fences, concurrent ownership/channel changes, exact actor
   propagation, stale provider runs and true lost COMMIT acknowledgement.
7. Run all canonical receipt, rematch, post-save matching, import and sent/tool
   regressions, differential types, dependency/migration guards and source hashes.
   Record fixes and limits, then commit/push and synchronize Linear. ROB765 remains
   In Progress until its full acceptance table is satisfied.

No runtime success or deployment is asserted by this design document.
