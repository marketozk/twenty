# LOG148 independent design review

Reviewed the concrete TEMP/log148-design.md against the current checkout at
89344e56. This was a read-only source/design review. Runtime acceptance and
dependency-guard results belong to the implementation run.

## Verdict

The closed rematch entry in the existing native cleanup owner is viable.
The described proof order closes the concrete risk of accepting a Participant
trigger's source or target mutation as a new baseline in the target stage.
No blocking architectural defect was found after the read-only Target refinement.

One small clarification was sent to the designer. The job must validate both
selector arrays and their elements before its first await, as well as copy them.
Otherwise malformed member input can be discovered after successful person
pages. This can be achieved with pure selector capture before any page starts.
Preserve the existing supported selector-array sizes.

## Facts checked in source

- MessageParticipantMatchParticipantJob currently invokes the generic person
  path and then the member path through its existing MatchParticipantService
  dependency. There is no job ACTIVE precheck or error replacement to preserve.
- MatchParticipantService::matchParticipantsForWorkspaceMembers substitutes
  null before generic comparison. Comparing the actual locked row is needed
  to clear a stale member when its current email has no match.
- Person selection uses LOWER(handle), then APP exclusion. Member selection
  does not apply that blanket APP exclusion. Generic member comparison is
  exact/case-sensitive. Person query includes deleted people and sorts by
  createdAt, while primary-email matching precedes additional-email matching.
- native-message-cleanup-with-audit.ts::createSession captures the operation
  and obtains metadata through getIssuedNativeCleanupMetadata. The capability
  implementation requires the original issued active strict/exclusive scope.
  prepareSession checks the workspace and locks sorted tables. finalizeSession
  reruns registered validators after audit flush and SET CONSTRAINTS ALL IMMEDIATE.
- reconcileTargetsStage captures its own graph/source baseline when invoked.
  Consequently, every Participant-caused source/target effect must already be
  checked before this invocation. A check only after the stage would be too late.
- The existing target stage filters both desired and existing target inputs
  through its selected live unowned roots. The new caller must pass only
  revalidated admitted roots, preserving all-participant derivation within them.

## Implementation conditions that matter

The original Participant/Message/Thread IDs and missing-row states must remain
in the rematch proof even after their relationship predicates cease to match.
Outside-root moved children are proof-only reads. New child locks must never
follow an undiscovered parent. Admission must compare the exact original selector
and parent chain after parent-first locking, and the cursor must advance by the
last discovered row even for a completely skipped full page.

Source predicates must remain fixed. Person-mode source capture includes both
the matching candidates and people linked by all root participants, plus their
Company and Opportunity sources, before the first participant update. Raw source
absence is protected by the chosen source SHARE locks. Same-transaction changes
are detected by the full snapshot predicates plus original IDs.

Initial Target snapshots are required in both modes. In person mode verify them
immediately after Participant DML and before target-stage entry. The target stage
then owns its declared Target changes. Member mode keeps the original Target
proof through finalization and performs no target planning. Requiring read-only
Target metadata is a justified refinement of the earlier four-table suggestion.

Expected Participant images must advance only for actual validated RETURNING
IDs. Skipped updates retain their original images. The expected-image and incoming
FK checks include generated changed columns and updatedAt. The opposite linkage
field remains part of the full unchanged row contract.

APP policy must use the current executor and retain channel/association images,
fixed workspace/message predicates, and original IDs through deferred drain.
The proposed core Channel and workspace Association SHARE locks cover raw policy
inserts. Their privilege requirements and contention behavior need real PG checks.

Source SHARE and row locks support the admitted write graph. Read-only checking
of an already skipped outside row does not establish serializable protection
against a raw write occurring after its last verification. The design states
that limited boundary accurately.

## Focused acceptance requirements

- A Participant trigger creates an Opportunity for another live participant in
  the same admitted thread. The page must refuse before target-stage capture.
- A Participant trigger modifies or inserts a Target before the target stage.
  The initial Target proof must roll back the page.
- Member-only Participant/audit triggers change Target rows, including a newly
  inserted root Target. Final proof must refuse with unchanged committed data.
- A skipped original Message moves outside the root graph and is changed again
  during deferred drain while another root is admitted. Its retained proof must
  detect the late change.
- Stale member clears, equal member is no-op, person links survive member-only,
  ordinary APP member matching remains eligible, and person APP matching skips.
- Actual scope/ownership checks, raw source/policy blocking, full-page cursor,
  generated incoming-FK refusal, actual skipped updates, audit failure and real
  lost COMMIT ACK exercise the new entry through the normal service/job path.

The actual enterprise dependency guard must evaluate the new import edges and
structural matching-helper type change. No baseline modification or opaque
dependency lookup is justified by this design.
