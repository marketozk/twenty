# LOG148 messaging rematch design

Proposed implementation within ROB765. Read-only design against HEAD 89344e56.
Independent review is recorded in design-review.md. Both selector arrays and
all elements must be validated and copied before the first awaited page.
This design record contains no implementation or runtime acceptance claim.

## Scope and decision

Migrate MessageParticipantMatchParticipantJob as one caller with its existing
personOnly and workspaceMemberOnly modes. Preserve people-before-members order,
copied selectors, one job correlation, distinct page operation IDs and strict
per-page outcome. Import matching and automatic contact creation remain later
callers in the existing acceptance table.

The current job invokes generic matching in ordinary SYSTEM transactions.
The member path substitutes null before comparing, which can preserve a stale
real DB link. The new path compares the actual locked row and clears a missing
member match. Equal real member IDs produce no update.

Three implementation options were considered.

1. Add an audit option to the old generic path. It still consumes stale detached
   participant values and reads APP policy outside its transaction. Actual
   source/graph/FK effects require additional ownership logic.
2. Build another independent rematch owner. This duplicates existing target
   mutation, audit, scope checks and deferred finalization.
3. Add a closed rematch entry and a private participant stage to the existing
   native-message-cleanup owner. This is selected. The existing private target
   stage composes after validated participant writes in the same session.

## Explicit refinement of the preliminary boundary

Member-only requires read-only MessageThreadTarget metadata and snapshots to
prove that a participant or audit trigger did not change targets. The preliminary
suggestion to avoid all target metadata would omit that effect check. Parent
selected this refinement. Member-only performs no target planner or target DML
and reads no Person/Company/Opportunity matching sources. The standard ORM
relationship metadata remains required by WorkspaceRepository result formatting.

## Files and interfaces

- native-message-cleanup-with-audit.ts adds the closed
  rematchNativeMessageParticipantsWithAudit entry, selector type, private graph,
  source-policy proof and participant update stage. Existing session preparation,
  finalization, target reconciliation and snapshot primitives are reused.
- A small rematch-native-message-participants-with-audit.ts facade exports only
  the closed entry and selector type. It exposes no session or callbacks.
- MatchParticipantService adds rematchMessageParticipantsWithAudit with the
  workspace/context adapter. Existing generic/calendar/import methods remain
  their own paths. No reverse service injection is introduced.
- MessageParticipantMatchParticipantJob captures named system identity and both
  input arrays before the first await, constructs selectors and drains pages.
  Its MatchParticipantService dependency remains sufficient.
- find-person-by-primary-or-additional-email.ts can use a generic structural
  email shape instead of importing PersonWorkspaceEntity. Keep the function
  body and return inference for original callers. This permits reuse of the
  existing matching algorithm without an entity import edge.
- Add targeted PostgreSQL and job-entry tests using the existing real fixtures.

The closed entry accepts scope, operation, selector and optional
afterParticipantId and returns nextCursor. The selector is a union of
personOnly/personEmails and workspaceMemberOnly/workspaceMemberIds.
Validate and copy the complete selector and cursor before await. The adapter
validates workspace/operation and uses real strict/exclusive SYSTEM scope.
The 200-row limit bounds discovered participants. Preserve the existing supported
selector array sizes rather than applying the unrelated 500-ID cleanup bound.
Empty selectors validate their operation/scope and perform no domain writes.

The structural repository scope must support participant updateMany with a
Record<string, unknown> partialEntity while remaining assignable to the existing
target scope. Prefer broadening that structural input over casts or new DI.
The write stage itself enforces the single permitted relationship field.

## Metadata and lock order

Person mode needs Thread, Message, Participant, Target, Person, Company,
Opportunity and MessageChannelMessageAssociation shapes. Member mode needs
Thread, Message, Participant, Target and WorkspaceMember shapes.

Use this order on the single issued executor.

1. The actual transaction establishes exclusive native ownership fencing.
2. createSession validates exact standard metadata and captured operation.
3. prepareSession locks the current workspace and sorted graph tables against
   DDL using its existing ROW EXCLUSIVE order.
4. Person mode acquires SHARE on core.messageChannel, then sorted SHARE locks
   on Person, Company, Opportunity and Association tables. Member mode acquires
   SHARE on WorkspaceMember. Sources are read-only in this operation.
5. Discover candidates without child row locks.
6. Lock discovered existing Thread parents, then their Message rows, then their
   Participant rows, in sorted ID order. Lock Target rows after graph children.

Existing native sync/group/folder/sent owners prepareSession before locking core
channel authority. SHARE fences protect raw inserts and missing-source matches.
The core table lock covers all workspaces and can briefly serialize channel DML.
Retain the existing lock timeout and propagate failure. Verify raw blocking in
PostgreSQL. The fixture currently has limited core grants, so a narrow grant
required by the real SHARE statement must be established before asserting its
runtime semantics. Actual application-role privilege must be checked as well.

## Discovery, admission and graph proof

Select at most 200 live Participants in ascending UUID order after the cursor.
Person selection is LOWER(handle) against captured lowercase deduplicated input.
Member selection is current workspaceMemberId against captured UUIDs.
LEFT JOIN Message to retain orphan/deleted hints for cursor progress. Capture
original Participant ID, handle/member selector value, Message ID and Thread ID.

After parent-first locking, admit only a live participant in its exact original
live Message and Thread with the exact captured selector value. Early drift
skips that candidate and never follows a replacement parent. Person mode further
excludes current APP-associated messages. Both modes exclude actual omni-owned
messages using findOmniNativeWriteOwnedRecords and the issued ownership fence.
Admitted Thread IDs are the only roots passed to target reconciliation.

Snapshot the complete root graph, including unrequested children, plus original
Participant/Message/Thread IDs. Read moved original children without taking a
child lock under an undiscovered parent. Retain explicit absence of original
IDs. Register the verifier before DML and rerun it at final deferred drain.
Only actual RETURNING participant IDs may advance the expected participant map.
The read-only proof of a skipped row outside the locked roots detects changes
through its final verification. Admitted roots remain protected by row locks.
No serializable guarantee is claimed for subsequent unrelated raw writes to a
skipped outside row after that verification.

Target proof in member mode includes roots and original Target IDs, including
tombstones. It must also find newly introduced targets under those roots. In
person mode initial Target state is checked immediately after Participant DML,
then the existing target stage owns its subsequent declared changes.

## Sources and APP policy

Capture all matching candidates and their complete native row snapshots before
Participant DML. Keep candidate ordering separate from sorted proof row sets.
Retain original IDs as well as fixed matching predicates in subsequent reads.

Person candidate SQL preserves the existing helper semantics. Primary email
uses LOWER equality. Additional-email candidate membership uses exact JSONB
containment of lowercase input. Deleted People remain candidates. Order by
createdAt ASC, with the original unspecified tie behavior. Decode the candidates
and reuse findPersonByPrimaryOrAdditionalEmail, which prioritizes primary email
then lowercases additional emails in memory.

Capture sources for all root participants and candidate new Person IDs before
the first update. Person/Company/Opportunity source proofs must detect late new
opportunities, not merely changes to already existing rows. Fixed selected
person IDs and original source IDs are retained. A Participant trigger inserting
an Opportunity must fail before the target stage gets a chance to capture it as
a legitimate new source.

Member candidate SQL uses exact userEmail matching and live WorkspaceMembers.
Use original handles, preserving case sensitivity. Retain candidate rows and
the old linked member IDs in the proof. Match comparison uses the actual row's
workspaceMemberId. The opposite personId remains part of the full expected row.

Person-mode APP proof is read on the same executor. Capture full current core
channel images for this workspace and preserve original channel IDs, then full
Association images for fixed original/root Message IDs and original Association
IDs. APP exclusion follows live associations to channels currently of type APP.
Core channels currently have no separate soft-delete policy in this matcher.
Reread both predicates plus original IDs before writes and after audit/deferred
drain. Association moves/deletes, newly inserted associations, channel type or
workspace changes must be detected. Source table locks prevent concurrent raw
policy writers while the transaction is active. Same-transaction trigger changes
are caught by the proof. Member-only preserves ordinary unowned APP eligibility.

## Participant mutation and composition lifecycle

Build updates only when the selected field differs from the actual locked DB
value. personOnly patches personId. workspaceMemberOnly patches workspaceMemberId.
Prepare each full expected postimage through the structural castCalendarProofImage
primitive. Its schema-aware generated/default calculation is reusable despite
the existing calendar name. Do not rename the helper as part of this slice.

Inspect the full before/expected column difference, including generated columns,
and run assertNoReferentialUpdateEffects before each update. Use the existing
calendar update pattern with a typed JSONB patch and bound-ID predicate. Every
bound parameter must occur in SQL. Reject unsupported FILES/composite mutations.
Validate real RETURNING IDs against requested IDs, including duplicates, unknown
IDs and skipped updates. Read the actual rows and compare their full image with
expected. Apply expected-map changes only for affected IDs. A skipped update
retains its original image and emits no mutation audit.

Immediately verify all graph, source, APP and initial target proofs. Then record
the participant before/after using captureNativeCrmAuditSnapshot and audit.record,
including the implicit updatedAt metadata convention already used by target
updates. The same audit context handles participant and target effects.

For person mode call the private target stage once with admitted root IDs. It
derives targets from the resulting actual Participant links and all other live
participants of those roots. Before that call, the participant stage must already
have validated every source and graph change. Its verifier remains registered
through finalization, with expected Participant images advanced only for its
own affected rows. Target stage owns expected target changes from then onward.

Member mode omits that stage and keeps its original full Target proof registered.
Finalization verifies, flushes once, drains deferred constraints, verifies again
and returns. No domain write follows finalization. Errors preserve their original
identity through service and job. A full discovered page returns its final ID
even when every candidate was skipped. Underfull/empty pages return null.

## Job semantics and coverage boundary

Use systemMembershipCleanupIdentity and membershipCleanupOperation with the
actual job name. Copy both selector arrays before await. Drain person pages
before member pages, resetting each cursor. Page operation IDs are fresh and
correlation/initiator remain captured. Preserve the current job's absence of an
ACTIVE precheck. The closed session still checks workspace existence/deletedAt.

Successful earlier pages remain committed when a later page fails. The existing
queue unsafe-outcome behavior continues to apply. Durable delivery, crash/stall
replay and caller provenance for import matching are separate open work.

## Verification and implementation order

1. Implement closed owner and narrow service adapter, then job capture/paging.
   Review changed edges with the actual enterprise guard before runtime work.
2. Real PG tests cover stale member clearing, equal no-op, replacement/case,
   opposite field preservation, target-trigger rollback in member mode, and
   absence of Person/Company/Opportunity matching-source reads in that mode.
3. Person cases cover primary precedence, additional-candidate SQL asymmetry,
   createdAt preference, deleted Person link with live-only target derivation,
   all-participant global targets and manual/tombstones.
4. Exercise full 200-row all-skipped cursor, late parent/selector changes,
   original missing/moved rows through deferred drain, source absence blocking,
   APP association/channel races and actual omni ownership in each mode.
5. Actual update skip/malformed RETURNING, generated postimage, populated incoming
   generated FK effect refusal, audit failure, Participant-trigger source or
   target mutation before target stage, and true COMMIT ACK loss must be checked.
6. Job/service tests verify data copied before first await, person then member
   pages, separate cursors, shared correlation/fresh page operation and unchanged
   ordinary/unknown/postcommit error propagation.
7. Run generic/import/calendar regression controls, broad fork suite,
   differential types, dependency/migration guards and source-hash verification.
   Preserve initial failures and corrections. Update the existing docs and
   Linear after commit/push and verify readback. ROB765 stays In Progress.

## Source anchors inspected

- MessageParticipantMatchParticipantJob::handle and the calendar job precedent.
- MatchParticipantService::matchParticipants, matchParticipantsForPeople,
  matchParticipantsForWorkspaceMembers, withoutAppChannelParticipants,
  updateMatchingRecords and calendar matching source/graph logic.
- native-message-cleanup-with-audit.ts::createSession, prepareSession,
  finalizeSession, reconcileTargetsStage and person-target closed page.
- add-person-email-filters-to-query-builder.ts and
  find-person-by-primary-or-additional-email.ts.
- calendar-target-proof.ts::castCalendarProofImage.

Runtime pass counts and guard acceptance will come from implementation runs.
