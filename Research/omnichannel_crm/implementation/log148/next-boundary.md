# LOG149 proposed boundary — audited post-save messaging matching

Read-only investigation against the checkout containing LOG148 work. This report
contains source facts and the next scope recommendation. Parent owns the current
test evidence. No source or runtime changes were made for this investigation.

## Recommended coherent slice

Cover the ordinary aggregate's existing post-save matching call for its four
origins with explicit captured operation attribution. Reuse the closed native
session, participant actual-effect stage and target stage introduced by LOG148.
The new import entry needs explicit Participant IDs and Message IDs, with modes
workspaceMemberAndPerson and targetsOnly. It runs after the already committed
save and existing contact-job enqueue.

This is one downstream writer with four provenance adapters. An owner-only
preliminary slice is possible if caller wiring is too large, but should remain
explicitly unconnected until the aggregate and all four callers supply identity.
Avoid an implicit legacy fallback selected by a missing operation.

## Existing path and important selector distinction

Paths are relative to packages/twenty-server.

MessagingSaveMessagesAndEnqueueContactCreationService::saveMessagesAndEnqueueContactCreation
in modules/messaging/message-import-manager/services currently accepts five
arguments, the fifth being optional OrdinaryMetadataSyncRun. It copies run,
channel and account/aliases before await. It validates expectedRun workspace,
channel and account relationships when present.

Inside SYSTEM lite context it saves Thread/Message/Association, then Participant
and folder associations in one workspace transaction. Only expectedRun calls
select strict commit outcome. lockOrdinaryNativeSyncRun runs inside that save
transaction and stale runs return undefined. All other callers currently use
the default transaction outcome.

After commit, enabled contact creation enqueues CreateCompanyAndContactJob.
After the queue add, MessagingMessageParticipantService::matchMessageParticipants
enters SYSTEM lite context and calls the generic MatchParticipantService without
transactionScope. APP selects targetsOnly, other channel types select both fields.
No explicit matching audit operation is passed today.

saveMessageParticipants returns only newly inserted and identity-updated rows.
Unchanged existing participants are omitted. However, the aggregate's messageIds
come from all participantsWithMessageId, not only touched rows. Consequently
matching currently updates only touched Participant IDs, while target refresh
also runs for saved Messages with unchanged participants. An empty touched list
with nonempty Message IDs is a valid target-refresh operation.

The future import owner must preserve both input sets. Rediscovering every
participant under those Messages and matching them would broaden current behavior
and can overwrite manually maintained links. Message IDs come from actual save
results and should retain their original current Thread relation in proof.

## Four actual origins and attribution

| Origin | Actual call chain | Available trusted source |
|---|---|---|
| Provider sync | MessagingMessagesImportService::processMessageBatchImport or processRecentMessageBatchImport -> processAdmittedBatch -> aggregate | Admitted server-owned sync run, workspace/account/channel and named system entry. No human actor supplied by this path |
| Inbound email | MessagingInboundEmailImportJob::handle -> InboundEmailImportService::importInboundMessage -> aggregate | Queue processor name and server-resolved EMAIL_GROUP channel. Workspace becomes known from recipient/channel lookup |
| Sent message | SendEmailResolver::sendEmail -> SendEmailService::persistSentMessage -> SentMessagePersistenceService::persistSentMessage -> aggregate | Authenticated request and required userWorkspaceId before provider send. The guard permits userSession, API key, OAuth and application principals. The decorator requires a token bound to a user workspace. Existing audit capture is only invoked for draft cleanup |
| Application ingestion | ApplicationMessageIngestionResolver::ingestAppMessages -> ApplicationMessageIngestionService::ingest -> aggregate under cache lock | AuthPrincipalGuard permits application principal only. AuthApplication and AuthWorkspace supply trusted IDs, optional member ID supplies scope restriction |

Provider sync can capture a named system identity at the public entry before
admission/network awaits and carry it through processAdmittedBatch. Distinguish
attribution from current run authorization. Matching's new transaction must
recheck expectedRun when that is its admitted policy, because the save transaction
released its locks before queue/matching.

Inbound email must derive workspace from server channel resolution. Capture its
named system operation once workspace is known and before fetching/persisting the
message. Queue payload contains source/reference/recipients rather than a CRM user
principal. Existing legacy s3Key payload support stays relevant. Cleanup of the
external source occurs only after import returns successfully.

Sent-message attribution must be captured before composing or sending, including
the non-draft path. SendEmailService::captureDraftCleanupAuditOperation already
delegates to MessagingDraftSendService, which uses captureCurrentCrmAuditIdentity
and resolves impersonator membership through the existing repository manager.
Reuse that actual capture mechanism through an appropriately named internal
adapter. Propagate captured identity/operation through persistSentMessage input.
Fresh matching operation IDs can retain correlation and causation to the capture.
Provider success stays successful if later persistence/matching fails.

The existing user-only check belongs to draft cleanup. Non-draft sends retain
the supported guard principals and required AuthUserWorkspaceId binding.
verifyUsableByCaller permits WORKSPACE access or a matching account.userWorkspaceId
through the existing pure helper. The matching adapter must preserve this rule.

Application ingestion knows authenticated applicationId/workspaceId at entry.
Capture the request identity before its first ownership await, preserving any
legitimate initiator/agent attribution carried by the existing request audit
context. Do not treat browser-provided message fields or a channel owner as the
actor. Existing coreDataSource can resolve the request identity's impersonator
when needed, following the current captureCurrentCrmAuditIdentity contract.

Operation capture should be validated before the aggregate begins saving rows.
The aggregate currently clones settings, so any new descriptor must likewise be
copied before await. Identity is an audit input, while authorization remains a
separate current-state check.

## Current policy and authorization observations

Provider filterEmails runs before save using blocklist, channel settings,
workspace internal-message policy and refreshed account aliases. The save's
lockOrdinaryNativeSyncRun checks current account, channel, sync stage, exact
startedAt, sync enabled and omni ownership. It does not prove every earlier
filter setting remained current. Matching must not claim to close that policy gap.

Inbound email finds a current EMAIL_GROUP channel by recipient and an account
in its workspace, fetches the source, excludes upstream spam/group email, then
finds an existing thread and saves. Those checks are outside a closed matching
transaction. No expectedRun is supplied. A new current account/channel proof for
this lane requires explicit design, preserving its existing import eligibility.

Application ingestion calls findOwnedOrThrow, rejects actual omni-owned channel,
checks isSyncEnabled, validates sender/external IDs and referenced identities,
then enters a per-channel cache lock. These checks currently precede save and
must be considered separately from a strict matching owner. A request identity
does not prove the channel's ownership or settings are still current after waits.

Sent persistence reloads a channel by input messageChannelId/workspaceId with its
connected account. It has no initiating-user field in PersistSentMessageInput.
The resolver verified account usability before provider send. The future owner
needs a deliberate post-send authorization policy and must preserve irreversible
provider success under later authorization/audit failures.

## Reuse and necessary new owner behavior

LOG148's rematch entry is selector-driven and person/member-only. Import needs a
closed bounded explicit-record entry that updates both identity fields together
for the supplied touched rows. Sharing a private participant stage is preferable
to calling personOnly and memberOnly terminal owners separately, since those
would create separate commits and use different selectors.

Capture exact explicit Participant/Message relationships before row mutation.
Lock live Thread parents, then Message/Participant children and related targets.
Keep original IDs and absent-row proof through finalization, including skipped
records. Desired targets use the actual post-update graph of all live participants
of admitted Thread roots. The initial source/target proof must precede participant
DML, as in LOG148, so a trigger cannot become the target stage's accepted baseline.

Both-field import retains generic matching semantics, including Person candidates
withDeleted, primary precedence, additional-email SQL asymmetry, createdAt order
and exact-case member matching. Import does not call the person-rematch APP
exclusion helper. Instead, APP's targetsOnly mode preserves caller-supplied IDs
and performs only target refresh. A type/policy change after initial channel
snapshot cannot silently convert an APP input into email rematching.

An empty touched list must still refresh targets for admitted explicit Message
IDs. A Message moved after capture must neither authorize changes under its new
parent nor clear targets under its former parent without a separately admitted
root. Pages need bounded effect sets and retained operation correlation. The
aggregate may contain many participants per Message, so do not assume the provider
message-batch bound also bounds touched Participant count.

Only the closed owner flushes and drains deferred constraints. Existing public
terminal target functions cannot be followed by extra matching writes. Reuse
the private session composition and keep existing rematch entry behavior fixed.

## Error and retry facts requiring explicit treatment

MessagingMessagesImportService::processAdmittedBatch rethrows recognized
OmniCoreTransactionOutcomeUnknownError and NativeTransactionOutcomeUnknownError.
Other errors are logged, fetched external IDs are requeued in cache, the import
exception handler runs, completion monitoring runs and false is returned. If new
matching uses a confirmed-postcommit wrapper, this catch must preserve it before
any requeue/status handling, consistent with the established unsafe-outcome policy.

SendEmailService::persistSentMessage catches all persistence errors, warns that
sync will recover and returns undefined. SendEmailResolver also encloses post-send
work in a catch that preserves successful provider outcome. Keep that externally
visible success and prevent another send. Recovery of the already-sent message's
persistence remains a separate durable obligation.

Application ingestion propagates aggregate errors through its request boundary.
Inbound import propagates errors and therefore does not perform source cleanup
after a failed aggregate call.

There is a concrete existing recovery gap. Save can commit Participant rows,
then queue or matching can fail. A provider retry fetches/saves the same message,
but saveMessageParticipants may now return an empty touched list because those
rows already exist unchanged. The original missed matching can then remain
unapplied. Auditing the post-save matching transaction alone does not provide a
durable retry intent for this case. Record it explicitly in the acceptance table
or address it as a separate save-transaction intent/recovery change. Broadly
rematching historical rows is not a safe substitute for preserving the original
intended touched set.

## Smallest execution sequence and verification

1. Design the closed explicit-record owner and current channel/run authorization
   descriptors for the four origins. Resolve operation-capture APIs before code.
2. Implement/review the shared both-fields participant stage and targetsOnly path
   while keeping existing rematch behavior covered. Add the matching operation
   parameter through the aggregate and all four callers.
3. Preserve save commit -> contact queue -> matching ordering. Exercise stale run
   at matching, queue failure after save, matching failure after save and response
   semantics for each origin.
4. PostgreSQL controls cover empty touched list, identity-updated rows, unchanged
   historical participants, both-field atomicity, non-email APP identities,
   current source/policy drift, true lost COMMIT ACK, actual RETURNING/FK effects,
   target-trigger refusal and deferred proof.
5. Verify immutable actor/initiator/correlation before external waits, real user
   send and application attribution, legacy inbound payload, and absence of a
   fabricated system fallback for missing request identity.
6. Existing rematch/import/provider/sent/application tests, dependency guard,
   differential types and full regression establish the slice. The broader
   ordinary message-save audit and durable matching recovery remain explicitly
   tracked until their own acceptance evidence exists.

No implementation or acceptance success is asserted by this report.
