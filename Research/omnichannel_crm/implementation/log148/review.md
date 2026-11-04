# LOG148 independent source review

## Runtime-informed metadata criterion correction

The parent supplied the second narrow PG run with 39 passing cases and one
failure in the metadata-removal test. I inspected its error and the revised test.
WorkspaceRepository.performBatchUpdate passes mutation snapshots to formatResult.
formatResultRecursively resolves relationTargetObjectMetadataId for snapshot
relation values and throws when the corresponding Person metadata is removed.
This is the normal ORM result-formatting contract even when matching touches only
workspaceMemberId.

The earlier design claim of complete independence from Person/Company/Opportunity
metadata was too broad. The narrower confirmed source contract is that member
matching reads WorkspaceMember candidates and does not query those three tables
as matching sources. Standard relationship metadata remains available to the ORM.
The parent revised the test to preserve standard metadata and intercept actual
transaction SQL for FROM/JOIN on Person, Company and Opportunity. It also checks
the stale member clears, personId is retained, Targets are unchanged and one audit
entry is written. That is an appropriate acceptance criterion for this path.

The SQL assertion matches the current emitted query shape. Source inspection
also confirms the member-mode sourceNames branch contains only workspaceMember,
and createSession uses only the graph plus that source list. This revision keeps
the actual mutation, Target proof and audit checks intact while correcting the
unsupported metadata-independence assertion. No production workaround is needed.

Relevant source anchors are format-result.util.ts::formatResultRecursively around
lines 134–148, workspace-repository.ts::performBatchUpdate around line 1419 and
crm-audit-native-message-rematch.postgres-spec.ts::member rematch reads no Person
Company or Opportunity matching sources around line 785. The parent owns the
rerun result and broader verification counts.

Reviewed the actual production diff after the designer's final member-handle
correction. Runtime tests, typechecks and dependency guards are parent-owned.
No checkout changes were made by this reviewer.

## Verdict

No remaining production blocker identified in the reviewed source. One concrete
race was found and corrected during review. Member-mode admission permits the
current handle to change while preserving the selected member ID. The initial
draft queried matching members using the old discovery handle, then compared
the current locked handle, which could wrongly clear a valid replacement.
The final code derives candidate handles from the admitted locked Participant
snapshots. A real PostgreSQL regression for that race is required and the test
agent is adding it.

## Files and boundaries inspected

- native-message-cleanup-with-audit.ts adds the closed rematch entry and widens
  only the structural updateMany input type used by the existing scope.
- message-participant-rematch-selector.ts validates and freezes normalized
  selectors without importing the workspace ORM/entity graph.
- rematch-native-message-participants-with-audit.ts exports the closed entry and
  selector definitions without exposing a session or callback.
- MatchParticipantService::rematchMessageParticipantsWithAudit captures the audit
  operation and selector before starting the real strict/exclusive SYSTEM scope.
- MessageParticipantMatchParticipantJob captures and validates both selector
  arrays before its first await, preserves people-before-members order, resets
  each cursor, and creates operations under one captured system correlation.
- findPersonByPrimaryOrAdditionalEmail retains its original matching body while
  changing to a structural generic argument and inferred original-record return.

## Verified source properties

The closed entry uses the issued-scope metadata capability through createSession.
Preparation takes the existing workspace and sorted table locks. Read-only
source tables receive SHARE before discovery. Person mode also fences current
core message channels and workspace associations. Every source/graph query uses
the transaction executor.

Discovery retains the original Participant, Message and Thread identities and
the selected handle/member value. Locks traverse only existing locked parents.
Moved original children are retained through nonlocking proof reads. Admission
requires a live exact original chain and the current mode selector. The new
matching candidate handles come from those admitted locked rows after APP and
omni exclusion.

The graph proof includes all root children and original IDs, including retained
absence. Fixed member IDs and fixed person/company IDs preserve missing-parent
and matching-source predicates. Candidate ordering is separate from sorted proof
rows. Person matching keeps deleted candidates, primary precedence, additional
email SQL asymmetry and createdAt ordering. Member matching retains exact case.

Initial Targets and matching sources are captured before Participant writes.
After actual updateMany RETURNING, only affected Participant expectations advance.
Full graph/source/policy verification runs before audit recording and before the
private target stage. Consequently a Participant trigger cannot silently turn an
unexpected source or Target mutation into the target stage's starting state.

Member-only keeps its full Target proof through finalization. Person mode passes
only admitted roots to the existing target stage. The outer verifier continues
to retain skipped-root Targets, including new rows under skipped roots and old
skipped targets moved into an admitted root. The existing target-stage validator
owns declared changes under admitted roots. Both validators remain registered
through audit flush and deferred-constraint drain.

Participant updates contain only the selected relationship field. Full expected
images use the existing PostgreSQL generated/default primitive. Incoming FK
checks include every changed image column and use both bound parameters in SQL.
calendarSaveActualIds rejects unexpected, duplicate and mismatched RETURNING
results. Skipped writes retain their original expected image and produce no
Participant mutation audit. Ordinary/unknown/postcommit exceptions propagate
without a replacement catch in the adapter or job.

## Acceptance checks retained

The corrected member-handle race needs its direct PG test. Other critical cases
remain those in the design review, particularly Participant-trigger changes to
Opportunity or Target before target-stage capture, skipped-original changes at
deferred drain, member-only Target-trigger rollback, source/policy raw blocking,
actual generated incoming-FK refusal and lost COMMIT acknowledgement.

The actual import graph and differential typecheck must confirm the structural
helper change for all current callers. The full application runtime profile from
LOG088 already grants core table UPDATE. The small test fixture needs explicit
core.messageChannel table-lock authority. Today's live grants remain a deployment
verification item.

Discovery/proof behavior for skipped outside rows has the same explicit boundary
as the accepted design. A read-only final check does not serialize unrelated raw
writes after that check. Actual admitted writes remain inside the locked graph.
