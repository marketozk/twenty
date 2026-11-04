# LOG149 — explicit post-save message matching with audit

Proposed design for parent and independent review. Source inspection completed
against LOG148's current checkout. Implementation and runtime checks belong to
the subsequent step. The accepted slice covers the downstream matching writer
and the four existing origins that invoke it.

## Decision and limits

Use a closed explicit-record matching entry composed from the existing private
native session, participant actual-effect writer and target stage. Capture
attribution at each origin, pass it explicitly through the ordinary aggregate,
and retain the current save commit -> contact queue -> matching ordering.

The alternatives are adding generic native audit to the existing detached-row
matcher, or copying the full LOG148 owner. The first retains stale selectors and
separate participant/target writes. The second duplicates graph/source proofs.
Extracting the existing private participant stage permits both-field matching
in one page transaction while keeping the established rematch entry intact.

Durable matching intent and recovery remain an explicit open criterion. The
ordinary initial Message/Association/Participant save audit is a subsequent
writer. This slice records the matching transaction and its attribution.

## Current source facts which constrain the API

saveMessageParticipants returns inserted or identity-updated rows only. Unchanged
participants remain absent from that list. The aggregate's messageIds contains
every participant-bearing saved Message. Empty touched participants with nonempty
messageIds therefore still requires target refresh.

The aggregate already returns Message external-ID -> native-ID and external-ID ->
Thread-ID maps inside its save transaction. These are enough to capture exact
Message/Thread pairs without a later detached lookup. Saved Participant entities
contain native ID, Message ID, handle and current identity references.

Capture the matching manifest immediately after save returns and before the
contact queue await. Its immutable contents are derived only from these actual
save results. No database mutation is needed for this in-memory capture.

## Internal contracts

Add structural types in a small pure import-matching contract file.

- SavedMessageReference contains messageId and messageThreadId.
- SavedParticipantReference contains id, messageId, handle, personId and
  workspaceMemberId. The relationship values are the actual save result.
- MessageImportMatchingManifest contains readonly participants, readonly messages
  and mode, either both or targetsOnly.
- MessageImportMatchingContext contains a captured CrmAuditOperation and the
  discriminated authority descriptor below.

Validate all UUIDs, nullable values, duplicate consistency and scope relationships
before beginning dependent work. Equal duplicate references can be deduplicated,
conflicting references fail explicitly. The entire supported aggregate batch can
be captured. Bound each page to at most 200 participant references and at most
200 explicit Message references, with every participant's Message pair included.
The full manifest itself receives no arbitrary new 200/500-record limit.

Authority descriptors share workspaceId, connectedAccountId, channelId and the
captured expected channelType. Their discriminants carry origin-specific facts.

- provider contains the captured OrdinaryMetadataSyncRun.
- inbound contains the server-resolved recipient/channel handle.
- sent contains the server AuthUserWorkspaceId and an effective user ID when the
  workspace auth context includes one. Principal attribution is in operation.
- application contains authenticated applicationId and optional request member
  ID, matching ApplicationMessageIngestionService's existing request scope.

No descriptor accepts a principal from message payloads. Capture/copy the
descriptor and operation before asynchronous operations. Missing attribution is
an explicit precondition failure at the origin, before the initial save.

The aggregate keeps its first four positional arguments. Replace the optional
fifth run argument with a required internal options object containing context
and optional expectedRun, and update all four callers together. Test mocks must
also use this contract. Require provider authority to carry exactly the same run
as expectedRun. Non-provider authorities must not supply a sync run.

MessagingMessageParticipantService::matchMessageParticipants receives the captured
manifest/context rather than detached entities. It delegates to a new
MatchParticipantService::matchMessageImportParticipantsWithAudit adapter. That
adapter enters real SYSTEM strict/exclusive workspace transactions for pages.
The closed native export is applyNativeMessageImportMatchingWithAudit with
scope, operation, authority and one bounded page. It returns the applied/skipped
page outcome, and exposes no mutable session or callback.

## Manifest admission and paging

Participant pages are processed first. Each page includes only the exact touched
Participant references plus their explicit Message/Thread pairs. Both identity
fields are matched together for admitted participants. Each page refreshes targets
for its independently admitted Message references using all current participants
under the affected Thread.

After participant pages, process the Message references that were never included
in a participant page in batches of 200. Those pages perform target refresh only.
In targetsOnly mode, all explicit Message references go through target-only pages
and participant DML is skipped entirely. This preserves caller-supplied APP IDs.

A Message reference is admitted only if its live current Message still belongs
to the exact live captured Thread. A Participant reference is admitted only when
its live locked row still belongs to its captured Message and retains the saved
handle and identity references. Early concurrent changes skip that participant,
preserving newer manual identity assignment. Retain the original references and
absent rows in final proofs even when admission skips them.

Unlike email-rematch discovery, an explicit Message reference independently
authorizes target refresh for its current verified original Thread. Therefore a
moved/skipped participant does not suppress an otherwise admitted explicit Message
target refresh. A moved Message never authorizes following a replacement Thread.

Repeated Message references across participant pages can cause no-op target
refreshes. Each page's target result is consistent with the actual committed
participant graph at that point. Successful previous pages remain committed if a
later page fails. Use fresh operation IDs with the original captured correlation
and initiator for each page. A failure stops later pages immediately.

## Shared private stage and proof ownership

Refactor only the composition seam in native-message-cleanup-with-audit.ts.
Keep createSession, prepareSession, finalizeSession and reconcileTargetsStage.
Extract the current participant graph/source/write stage into a private helper
whose input has a closed discriminated selection type.

- rematch selection retains LOG148 personOnly/memberOnly discovery and cursor.
- import selection provides the bounded immutable manifest and both/targetsOnly.

The private helper returns admitted Message/Thread roots and maintains its own
expected Participant map and read-only proofs. It does not flush. The closed
entry composes the target stage and finalizes once. No external callback or
unflushed public method is introduced.

Both-field mode computes Person and WorkspaceMember matches from the same
captured locked Participant graph and read-only source snapshots, then performs
one updateMany patch per affected Participant containing only changed identity
fields. Reuse existing expected PostgreSQL image calculation, actual RETURNING
validation, FILES policy, incoming generated-FK refusal and audit record creation.

Person matching retains primary precedence, the exact additional-email candidate
SQL/in-memory asymmetry, deleted Person candidate policy and createdAt ordering.
Member matching preserves exact case. Candidate handle sets come from admitted
current rows only. Target derivation remains live-only and global to the admitted
Thread's current participants.
The import both mode does not inherit LOG148's person-rematch exclusion based on
any APP association. Existing import matching excludes actual omni ownership,
while mode comes from the captured source channel. A message shared with another
APP channel retains that existing import behavior. targetsOnly continues to be
selected by the captured APP source channel.

Keep full graph and initial Target snapshots before Participant DML. Capture all
candidate and existing Person/Member sources, candidate-linked Company rows and
Opportunity predicates before the first update. Verify immediately afterward,
before target-stage baseline capture. Target changes caused by Participant
triggers fail. Generated afterimages advance only for actual affected IDs.

After the target stage takes ownership of admitted roots, retained Target proof
still covers skipped roots/original target IDs. Both stages' verifiers run before
flush and after deferred constraint drain. Same-transaction source expansion,
original-row resurrection, policy changes and ownership changes fail atomically.

Target-only pages use the existing target-source graph. They do not require
member matching sources merely to refresh targets. All affected participant
images are read-only, so target/audit triggers cannot rewrite their links.

## Origin capture and current authorization

### Provider

MessagingMessagesImportService::processMessageBatchImport and
processRecentMessageBatchImport have workspace and channel identity before
admission awaits. Capture a named system identity there and pass it into
processAdmittedBatch. Select stable explicit names for full/recent import or the
actual service entry, rather than inventing a human actor. Copy run/channel/account
IDs before external provider fetch or cache awaits.

At matching page entry, prepare the native session, then call the existing
lockOrdinaryNativeSyncRun on the same executor. It checks the exact microsecond
startedAt, stage, sync enabled, account/channel relationship and ordinary ownership.
Register a post-write verifier of the locked full relevant account/channel images
and the same expected-run conditions through deferred drain. A stale run is a
normal no-apply result for this origin and must not advance sync status as though
matching applied. The aggregate forwards that outcome to its provider caller.

Earlier filterEmails/blocklist/alias policy is separate. The matching owner must
retain the chosen channel type and reject a type change that would change mode.

### Inbound email

InboundEmailImportService resolves a recipient and EMAIL_GROUP channel before
source fetch. Once workspace is known, capture a named system operation and
recipient/channel/account descriptor before fetch/save. Legacy s3Key queue payload
support remains in MessagingInboundEmailImportJob's existing reference resolver.

The matching owner locks the exact account and channel, proves workspace and
account relation, EMAIL_GROUP type and exact captured recipient handle, and
excludes actual omni ownership. Preserve existing eligibility, which does not
gate this path on isSyncEnabled. Store full relevant row snapshots and verify
after deferred drain. A changed/unreachable channel produces an explicit matching
failure so external source cleanup does not run.

### Sent message

SendEmailResolver guards permit userSession, API key, OAuth and application
principals. AuthUserWorkspaceId separately requires a token bound to a member.
The user-only check in the current resolver applies to draft cleanup alone.
Preserve this public contract for non-draft sends.

Capture request audit identity before account verification, compose or provider
send. Reuse captureCurrentCrmAuditIdentity and its impersonator resolver through
the existing SendEmailService/MessagingDraftSendService capture implementation,
with a neutral internal name if expanded beyond draft cleanup. The capture keeps
application/agent/API/user attribution and initiator from server authentication.
Do not reconstruct actor from the member who owns the connected account.

Copy server member ID and effective user ID when the auth context supplies one.
Pass context through SendEmailService.persistSentMessage and
PersistSentMessageInput. SentMessagePersistenceService resolves the channel after
send and requires its connectedAccountId to match the account that actually sent
the message, captured from the composed request before provider send. A channel
rebound to a different account must fail before initial persistence. Then freeze
the exact channel/account relation and type before aggregate save. Matching
rechecks that current relation.

The owner uses the existing sent-cleanup order for applicable core rows, followed
by channel and native graph rows. A current member must exist in the workspace.
When an effective user ID was captured, the member's userId must still match and
that user must remain live/enabled. Use isConnectedAccountUsableByCaller against
the exact current account and server member ID. Preserve WORKSPACE scope access
and private-account owner matching. Capture these authority rows and repeat the
proof after deferred drain. This does not add a new user-only request gate or
claim general token/session revocation fencing for every principal type.

Both current catches preserve successful external provider send. Matching failure
must not become a send failure or cause another provider send. Existing
SendEmailService.persistSentMessage may return undefined after warning. Preserve
that response behavior and record the unresolved recovery obligation.

### Application

ApplicationMessageIngestionResolver uses an application-only principal guard and
server decorators for applicationId/workspaceId/optional member. At service entry,
captureCurrentCrmAuditIdentity before findOwnedOrThrow, identity lookups or cache
lock waits. CoreDataSource already exists for impersonator resolution. A missing
request identity fails before save rather than generating a system identity.

The matching owner locks the current core account and channel. Require channel
type APP, account provider app, exact applicationId/workspaceId/account relation,
and isSyncEnabled. Reuse isConnectionHiddenFromRequestUser's existing rule through
a structural signature if its entity type import violates the dependency guard.
An absent request member represents the existing background-application path,
which can reach the application's own private account. With a member, USER scope
must match it. Check any supplied member remains in the same workspace. Current
application existence/workspace/deletedAt can be retained as identity-source proof,
without inventing an ApplicationState gate absent from the current caller.

Repeat authority snapshots through finalization and exclude actual omni channel
and native ownership. Preserve the existing per-channel cache lock and API result
mapping. A policy change raises a matching error and prevents a success response
for that ingest call. Already committed saved messages remain a separate result.

## Lock order and current channel policy

Use the existing workspace ownership fence and prepareSession DDL ordering.
Core authority order follows existing native owners, with effective user/member
before account and channel when applicable. Provider run uses its established
account SHARE then channel UPDATE order. Acquire read-only source/association
SHARE fences before native graph row locks. Parent Thread rows precede Message,
Participant and Target rows.

Every page reads live Association proof tying each explicit Message to the exact
captured channel. A row from another channel cannot be admitted merely because
its UUID appeared in an internal manifest. Retain original Association IDs and
fixed Message predicates. Source SHARE prevents association phantoms, and final
proof rejects same-transaction move/delete/insert effects. Verify the captured
channel type agrees with mode. Do not re-read type later and silently switch an
APP page into both-field email matching.

Current authority proofs are registered inside the closed session. Any copied
scope, released transaction or missing strict/exclusive capability is rejected.
No proof is appended after calling a public terminal helper.

## Error classification and recovery boundary

Provider processAdmittedBatch currently rethrows native/core unknown-outcome
errors before requeue/status handling. Extend that exact classification to the
existing recognized confirmed-postcommit error types needed by the new path.
Keep ordinary errors under the established provider error handler. Tests must
show that unknown/confirmed outcomes never requeue the matching page blindly.

Inbound errors prevent external source cleanup. Application errors propagate to
its caller. Sent-message post-send errors preserve provider success and never
invoke another send. Queue-before-matching stays unchanged for every origin.

The existing lost touched-set problem remains documented. Save can commit, then
queue/matching fails. A later provider save may return no touched Participants,
so the missed matching intent is lost. Durable intent needs its own save-transaction
schema/queue recovery design. Do not conceal this by broadening replay to all
historical participants or by claiming full aggregate atomicity.

## Planned files and verification

Runtime work touches the existing native owner and a small facade/contract leaf,
MatchParticipantService and MessagingMessageParticipantService adapters, the
ordinary aggregate, the provider/inbound/application origins, and the sent resolver,
send service, persistence service/input and existing request-capture adapter.
No new injectable provider is required. Shared pure reachability/matching helpers
retain implementation and structuralize types only when the actual guard needs it.

Verify the four real entry paths, attribution before awaits, scope mismatch before
save, old callers/tests updated together, and normal save -> queue -> matching
ordering. Actual PG cases must cover both-field atomicity, APP identities,
empty touched set, historical unchanged rows, oversized supported manifests,
multiple pages, stale run/account/channel policy, independent Message admission,
source/target trigger refusal, generated/FK effects and lost COMMIT acknowledgement.

Preserve LOG148 rematch controls and matching semantic fixtures. Run target suites,
dependency guard without baseline changes, differential types, migration checks
and broad regression. Commit only verified changes, update docs and Linear with
explicit remaining save-audit/durable-intent criteria, and verify publication.

## Sent tool entry point

The sent aggregate has two upstream callers, SendEmailResolver and SendEmailTool.
The tool serves AI and workflow execution. Its existing composer permits an
explicit workspace account without a request membership. Preserve this contract
with a separate `sent-tool` authority and nullable membership. The resolver keeps
its existing caller-usability predicate and mandatory membership.

EmailWorkflowActionBase passes its resolved authContext into ToolExecutionContext.
Before composing, capture the actual request or resolved tool identity, including
application, agent and impersonation attribution. Reject contradictory ambient
and explicit identities. Background execution uses its authenticated identity.
Capture the selected account/channel before the provider call. Matching verifies
current account/channel, any supplied membership and effective user, and the
application/agent relationship when present. Archived accounts are refused for
sent and sent-tool, matching the composer admission contract. All origins retain
the archived field in the authority snapshot.

Provider success survives later persistence or diagnostic failures. Verify actual
tool execution without HTTP audit context, workflow auth propagation, immutable
capture, unsupported identities and PostgreSQL authority changes.

## Source evidence used

Inspected the four aggregate call sites and their upstream entry methods,
saveMessageParticipants' touched-ID selection, the aggregate's save-result maps,
lockOrdinaryNativeSyncRun, ApplicationMessageChannelsService::findOwnedOrThrow and
findReachableConnectedAccount, isConnectionHiddenFromRequestUser,
isConnectedAccountUsableByCaller, AuthUserWorkspaceId, SendEmailResolver guards and
post-send catches, MessagingDraftSendService::captureDraftCleanupAuditOperation,
captureCurrentCrmAuditIdentity and current native sent-cleanup proof order.
