# LOG149 independent design review

Reviewed TEMP/log149-design.md and the actual four aggregate call chains after
LOG148. This report covers the proposed downstream matching slice. Runtime and
source implementation acceptance belong to the following step.

## Verdict

The explicit-record owner with a shared private participant stage is viable.
Its separation of touched Participant references and independently admitted
Message references preserves the existing aggregate semantics, including the
empty-touched target refresh. The proposed current-authority descriptors provide
the needed origin-specific decision at each matching transaction.

Two concrete clauses were sent to the designer and are present in the refreshed
design. Import both-field matching must not inherit the person-rematch
APP-association exclusion, since the current import path chooses its mode from
the source channel and does not run that filter. Sent persistence must require
its reloaded channel/account relation to match the actual account used for the
provider send, captured before provider work, before calling the initial save.
Re-freezing a different account after send would silently replace that authority.

## Source-confirmed contracts

saveMessageParticipants returns only inserted and identity-updated records.
The aggregate separately derives messageIds from all participantsWithMessageId.
Capturing actual Message/Thread save maps before contact enqueue avoids a later
lookup redefining the original graph. Matching all rediscovered historical
participants would exceed the current writer's scope.

ApplicationMessageIngestionResolver permits only application principals and
passes application/workspace/member IDs from server decorators. Its service uses
findOwnedOrThrow, which checks channel APP type, account provider/application/
workspace ownership and isConnectionHiddenFromRequestUser. The latter permits
the application's background path without a request member to reach its own
private account. The new current proof must retain that distinction.

SendEmailResolver permits user session, API key, OAuth and application principals.
AuthUserWorkspaceId requires a member-bound token. Its user-only restriction is
inside the draft-cleanup branch. Expanding audit capture to ordinary sends must
preserve those supported non-draft principal types and their actual initiator.
The resolver's post-send catch preserves confirmed provider success. The send
service also catches persistence errors and returns undefined. Matching failure
must remain inside this established irreversible-outcome treatment.

Provider import supplies expectedRun and currently excludes recognized unknown
outcomes before cache requeue/status handling. Matching occurs after the save
transaction released its account/channel locks. A new page must recheck the run
on its own issued executor and preserve confirmed-postcommit classification when
introduced. A stale no-apply page must stop status progression for this batch.

Inbound email resolves a server EMAIL_GROUP channel before fetching the source.
Its current path has no isSyncEnabled eligibility gate. Captured named system
identity becomes possible once workspace is known. Matching errors must prevent
the normal post-import external-source cleanup.

## Ownership and pagination checks

Every participant page must carry its original Message/Thread pairs. Admission
checks saved participant parent, handle and identity references against locked
rows. An independently valid explicit Message may refresh its original Thread
even when a particular touched participant was skipped. A moved Message must
neither authorize its new Thread nor silently clear its former Thread's targets.

The two-phase page traversal is coherent. Process bounded touched participants,
then Message references never included in those pages. TargetsOnly traverses the
explicit Messages without identity writes. More than 200 touched participants
under one Message is supported through separate page commits. Target derivation
still sees the full current Thread graph, so the 200 limit bounds the explicit
selector inputs rather than the total number of target/source rows in a Thread.

All initial source, participant and Target snapshots must precede Participant
DML. Validate actual RETURNING and complete expected images before entering the
private target stage. Otherwise a Participant trigger could become its accepted
source/target baseline. Original IDs, absent rows, skipped-root Targets and current
authority predicates remain checked through the final deferred drain.

The proposed Association proof must bind every admitted Message to the captured
channel. The channel type and mode remain one captured contract. A policy change
causes refusal rather than selecting a different matching mode after saving.

## Acceptance emphasis

- A save returns no touched participants but nonempty Messages, and refreshes
  targets while preserving manually maintained historical participant links.
- A supported large manifest spans multiple pages and one Message appears in
  several participant pages. Only explicit touched rows are matched.
- Queue delay permits participant or Message movement. Exact saved references
  determine admission, and original/skipped proofs survive deferred effects.
- APP source remains targetsOnly, while an email-origin import does not acquire
  the separate rematch-only APP filter through the shared-stage refactor.
- Sent channel/account transfer after provider success fails persistence/matching
  authority as designed while the API preserves the one confirmed send result.
- Provider stale-run and recognized unsafe outcomes prevent cache requeue/status
  advancement for the matching operation. Inbound failure prevents cleanup.
- Application background versus member-bound reachability preserves the existing
  private-account rule, with current ownership checked after cache waits.
- Existing LOG148 discovery modes and source/target/RETURNING/FK protections pass
  unchanged-behavior controls after private-stage extraction.

The lost touched-set recovery gap is explicitly preserved as separate work.
Save can commit before enqueue/matching fails, and a later save may return no
touched Participants. This slice must not describe that as durable matching or
conceal it by widening replay to every historical participant.

The normal entry paths, current runtime privileges, dependency guard and types
require actual verification. Source review alone does not certify those gates.
