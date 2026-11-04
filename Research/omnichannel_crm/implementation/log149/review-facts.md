# LOG149 independent source checks before design review

The concrete design was still being prepared during this source pass. These
findings establish constraints for its review. No source/runtime changes made.

The aggregate has four production origins verified by call-site search.
Provider sync passes expectedRun, inbound email resolves EMAIL_GROUP channel,
sent persistence reloads channel/account after sending, and application ingestion
uses an application-only guarded resolver plus findOwnedOrThrow.

saveMessageParticipants returns inserted and identity-updated Participants.
Unchanged existing participants are omitted. The aggregate's separate messageIds
come from all participantsWithMessageId. Preserve both explicit sets. A target
refresh with no touched participants remains valid. Rediscovering and rematching
every participant under the saved Messages would broaden historical behavior.

Capture the immutable saved Participant-to-Message and Message-to-Thread manifest
before awaiting contact enqueue. The aggregate has the actual save maps available
inside its save transaction. Post-enqueue DB discovery must not redefine those
original relations or silently follow moved records into a new thread.

Participant effect pages can be bounded to 200 explicit touched IDs while target
derivation reads all current participants of admitted roots. Multiple pages for
one Message require clear separate-commit semantics. Every root passed to target
refresh needs a currently admitted original Message, independent of whether its
touched Participant list is empty. Keep original and skipped-root proof through
finalization and retain the LOG148 pre-Participant source/Target checks.

Application current authority depends on connectedAccount.applicationId,
provider APP, workspace, and isConnectionHiddenFromRequestUser using current
scope/member fields. The channel must be APP and enabled under the existing
ingestion policy. Captured application attribution alone does not establish this
current authority. Channel type changes must never convert APP targetsOnly input
into email identity matching.

Sent-message audit capture currently exists only inside the draft branch before
compose/send. Non-draft needs the same trusted request capture before provider
work. Any new post-send persistence/matching authority refusal remains inside the
existing successful-provider result handling. SendEmailResolver returns success
after post-send failures and SendEmailService.persistSentMessage catches its
failure, preserving that external outcome.

Provider matching needs a fresh expectedRun check in its own transaction.
lockOrdinaryNativeSyncRun already checks current account/channel, sync enabled,
stage, exact startedAt and omni ownership, but earlier filtering settings remain
a separate policy gap. Its initial lock release after save matters here.

Inbound email has no expectedRun. Resolve and capture named system attribution
after the server channel establishes workspace, then explicitly design its current
channel/account proof. External source cleanup follows successful import. Preserve
the legacy reference path and never reinterpret queue payload as a user actor.

Provider import currently rethrows two recognized unknown-outcome classes before
generic cache requeue/status handling. Any newly introduced confirmed-postcommit
wrapper must also preserve the established unsafe-outcome behavior. A new audit
boundary must not invite replay of an ambiguous committed page.

Concrete design review should state its caller descriptors, relation manifest,
paging and late authority behavior before implementation begins.
