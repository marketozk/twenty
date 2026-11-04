# Next boundary after LOG149 — ordinary message save audit

Read-only source investigation while LOG149 tests run. This report selects the
next writer and identifies the separate durable-matching recovery requirement.
It adds no implementation, runtime test or acceptance claim.

## Recommended next slice

Add a closed ordinary-save owner around the existing save transaction in
MessagingSaveMessagesAndEnqueueContactCreationService. Cover the five native
write tables together and emit one audit before commit. Reuse the now-captured
origin context and current authority checks from LOG149, while preserving
save -> contact queue -> matching order.

The five writers are MessageThread, Message, MessageChannelMessageAssociation,
MessageParticipant and MessageChannelMessageAssociationMessageFolder. Targets are
read-only during initial save and need proof of unexpected trigger effects.
Referenced Person/WorkspaceMember identities and core.messageFolder are relevant
read-only sources. Folder metadata is a core table, not a native workspace object.

Durable matching intent should follow this owner. It needs a trusted actual-save
manifest and explicit replay/unsafe-outcome handling. The existing deferred-action
table is a promising reuse point, but its default retry semantics alone are
insufficient for this command.

## Current ordinary save ownership

Paths below are relative to packages/twenty-server.

The ordinary aggregate in
modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service.ts
owns one workspace transaction. Inside it, MessagingMessageService saves Thread,
Message and channel Association, MessagingMessageParticipantService inserts or
updates participants, and MessagingMessageFolderAssociationService inserts folder
junctions. Queue and matching run after that transaction returns.

Only provider expectedRun currently selects strict commit outcome for this
initial transaction. Other origins use the default option. The new closed save
must establish real strict/exclusive capability for every ordinary origin, retain
origin attribution, and prove current channel/account authority before writing.

The default generic nativeAudit option cannot simply be turned on. In
engine/core-modules/crm-audit/native-crm-audit-record.ts, AUDITED_OBJECTS contains
only Company, Person and Opportunity. Messaging standard/system metadata fails
isNativeCrmAuditMetadata and assertNativeCrmAuditWriteSupported. An explicit
closed owner follows the existing calendar-save and messaging-cleanup pattern
without broadening that global whitelist.

## MessagingMessageService actual behavior

saveMessagesWithinTransaction accepts an already issued scope. It discovers
existing Messages by headerMessageId, channel Associations by external Thread ID,
then Associations for existing Message IDs and this channel. Accumulator helpers
select an existing native Message first by channel external ID, then by global
headerMessageId. Thread reuse follows that Message or an existing channel Thread
association. Ordinary reads use live rows. Canonical options additionally read
deleted rows and reject conflicting/tombstoned canonical identities.

The service allocates UUIDs before inserts. It creates Thread rows, updates
existing Thread.subject through upsert for newly created Messages, creates Message
rows and creates Association rows. For multiple new messages in an existing Thread,
the latest receivedAt subject wins. An existing Message's text/subject is not
rewritten by this path.

All three insert results and the Thread upsert result are currently ignored.
Return maps, createdMessages and createdMessageThreadIds are built from the
planned accumulator, not validated actual RETURNING rows. A skipped or rewritten
insert can therefore leave a mapping that does not prove persistence. This is a
specific prerequisite for the next owner, not evidence that normal inserts fail.

The ordinary input array is not comprehensively copied before async discovery.
Only the canonical option branch currently copies each Message and receivedAt.
The new owner must capture messages, dates, participants, identity references and
folder IDs before awaits. Preserve null/empty fields and existing matching rules.

The helper has two additional production call sites inside the same aggregate
class, used by applyOmniSentReceipt and incoming/history receipt application.
Those call sites use withOmniRepositoryOptions, canonical Thread maps and their
own domain audit/receipt owner. They verify mappings and created-record claims
after the helper returns. A new ordinary-save owner must not add a second audit
owner or alter those canonical receipt contracts accidentally.

## Participant and folder behavior

MessagingMessageParticipantService::saveMessageParticipants reads live existing
participants for all affected Message IDs. Matching uses Message ID, handle and
role, with displayName additionally required when the caller supplied neither
personId nor workspaceMemberId. It creates unmatched rows and updates explicitly
supplied identities for matched rows. Null/omitted identity input retains the old
identity. Empty names retain an earlier supplied name.

Identity updates are chunked by QUERY_MAX_RECORDS. The method inserts remaining
rows, collects returned insert identifiers plus every requested update ID, then
returns those rows through find. It does not verify actual update RETURNING
effects. Therefore the touched manifest needs to distinguish actual changes,
skipped updates and no-op rows after a closed owner is introduced.

MessagingMessageFolderAssociationService reads existing live junctions, delegates
pair deduplication to buildMessageFolderAssociationsToInsert and inserts only new
Association/Folder pairs. The pure deduplication helper should be reused. Insert
results are currently ignored. Existing tombstone behavior follows live find,
and must be established in tests before choosing restoration or recreation rules.

MessageFolderEntity is core.messageFolder with workspaceId and messageChannelId.
The save owner should prove that every referenced folder remains in the intended
workspace/channel before junction insertion and through deferred drain. Existing
folder-action cleanup has current folder/channel proof precedents.

## Minimal implementation choices for the next design

Keep existing entity/repository planning in the established services and introduce
an explicitly ordinary closed save entry with captured context and input. Factor
small pure plan calculations where necessary. Do not copy the full calendar owner
or replace the canonical omni receipt path with an ordinary path.

The owner must control all five write stages and flush only once. A callback that
can arbitrarily write after a public terminal audit helper is unsuitable. Use
private stages or a narrow issued write interface whose allowed operations and
effects remain owned until finalization.

For every planned insert/update, compute full expected PostgreSQL images with
the existing structural image primitive, record actual affected IDs, verify actual
rows, incoming FK/generated effects, unchanged related graph and ownership. Map
return values must refer to verified current rows. Unsupported skipped required
creation should fail atomically instead of returning a nonexistent planned ID.

Thread.subject upsert needs explicit create-vs-update accounting. Existing parent
discovery implies an update, but raw concurrent deletion or an unexpected upsert
insert must not silently broaden effects. Preserve the latest-receivedAt selection
rule and verify exact effect images.

Retain full original graph IDs and fixed header/external-ID predicates. Row locks
alone do not protect absent deduplication candidates. The design must choose and
test an absence fence compatible with the existing ownership coordination and
canonical writers. A per-channel cache lock alone does not serialize two channels
sharing a headerMessageId or raw SQL writers.

Use the existing CrmAuditTransactionContext crmRecord capture. It hashes/redacts
all native field values and records metadata field IDs, so message text and names
do not need to be duplicated in the journal. Full internal snapshots can still
serve exact-effect validation before producing redacted audit diffs.

## Durable matching intent reuse and caveats

LOG114 already persisted workflow reconciliation intents in the existing
core.deferredWorkspaceMigrationAction table through the same core transaction,
without a new migration. UserWorkspaceService verifies the returned intent ID,
exact workspace/application/name/payload and PENDING/attempts state before commit.
This is a useful structural SQL precedent for a workspace executor writing the
same core database.

The table has versionable JSON payload, action name, workspace/application
identifier, status, attempts, position, runByVersion and timing/error fields.
The runner loads PENDING records, atomically claims IN_PROGRESS, calls a registered
handler, then deletes the action separately after success. Every caught error
currently resets PENDING until the max-attempt limit, then marks FAILED.

Simply registering LOG149 matching as a deferred handler would automatically
retry unknown/confirmed-commit failures, contrary to the existing unsafe-outcome
contract. It also leaves a crash window between committed matching and deleting
the intent. The design needs explicit page progress/receipt ownership in the same
matching commit, or an unsafe-outcome state requiring proven reconciliation.
Ordinary at-least-once retries and manual retries need separate tests.

Persist the exact original touched-participant and explicit-message manifest in
the save transaction. Preserve immutable origin attribution and capture current
authorization again during replay. Do not reconstruct touched rows from a repeated
save, and do not broaden replay into rematching every historical participant.
Payload integrity, actor provenance, content minimization, retention on FAILED,
queue ordering and feature-flag independence must be reviewed before adopting
the existing runner. Durable contact-job enqueue is an adjacent obligation.

## Verification required

- Real ordinary origin entry points share one strict save/audit transaction.
- Insert/update skip and rewrite, actual returned mapping, generated defaults,
  Thread subject selection and multiple Messages sharing one Thread.
- Re-delivery, same external/header IDs, multiple channels sharing a header,
  duplicate input identities and original tombstone behavior.
- Captured mutable input, nullable handles/names, explicit APP identities,
  many participants and folder junction deduplication.
- Current channel/account/folder proof and raw absence/concurrent ownership
  races, audit/deferred trigger effects, rollback and true COMMIT ACK loss.
- Canonical omni receipt helper callers remain covered by their existing tests.
- Queue/matching remain after confirmed save; sent provider success survives
  later persistence failure and never causes a second provider send.
- A later durable-intent slice must exercise crash-before-enqueue,
  crash-after-matching, unknown commit, competing recovery workers and stable
  audit/progress receipts independently of Redis availability.

The next step is a concrete closed-save design and independent review. Durable
intent remains a named follow-on requirement until its own accepted design and
runtime evidence exist.
