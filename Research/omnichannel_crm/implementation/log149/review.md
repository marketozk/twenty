# LOG149 independent owner implementation review

Reviewed the native owner extraction, pure import context/manifest capture and
MatchParticipantService paging against the LOG148 baseline and approved design.
No owner source or runtime edits were made by this reviewer.

## Verdict

No remaining blocking defect identified in the inspected owner changes. One
identity-consistency refinement was sent to the owner and confirmed fixed in
local source. Sent coreUser attribution now derives effectiveUserId when absent
and rejects a conflicting supplied user, matching the sent-tool check. The parent
must upload that final revision before claiming verification of it.

## Introduced flow checked

The public import entry captures immutable context and manifest, validates the
bounded page and channel/mode pairing, then enters the shared private owner.
The old rematch entry retains its selector capture, 200-row discovery and cursor
result through a wrapper around that owner. Import supplies explicit references,
so it does not reuse historical discovery as an implicit matching selector.

The service builds participant pages first and includes their Message references.
Remaining explicit Messages receive independent target-refresh pages. TargetsOnly
uses Messages without Participant writes. Each page has strict/exclusive scope,
fresh operation identity, shared correlation and immediate stale-run propagation.
An empty complete manifest produces no transaction, preserving the absence of a
domain write to audit.

An import Message is admitted by exact original live Thread relation, current
locked Message, live channel Association and ordinary native ownership. A touched
Participant additionally retains its saved handle/person/member identity values.
Import both-field matching avoids the separate person-rematch APP-association
filter. A moved or manually relinked touched participant may be skipped while an
independently admitted Message still authorizes target refresh, as designed.

Candidate Person/Member snapshots are built from admitted current Participant
handles. Full graph/source/Target snapshots precede Participant DML. Full expected
PostgreSQL images and generated incoming-FK checks remain in the shared writer.
Only validated actual RETURNING rows advance expected state. Verification runs
before the target stage captures its baseline, preserving protection against
trigger-induced source/Target expansion.

Retained Target proof covers skipped roots and original IDs after the target
stage takes ownership of admitted roots. The existing target-stage final validator
also rechecks complete Thread ownership, which includes MessageLink and bound
Association ownership. This covers target-refresh pages with no admitted touched
participants, where the separate participant-message ownership list is empty.
All registered proofs run again after audit flush and deferred constraints.

## Authority review

Provider expectedRun is checked before native graph work on the current issued
executor. A stale result returns without DML. Accepted account/channel images
and current ownership remain registered as final proofs. Inbound keeps its exact
EMAIL_GROUP recipient policy without importing a new sync-enabled gate.

Sent checks current caller membership/user where applicable, account usability
for the resolver path and exact captured channel/account/type. Sent-tool has its
separate existing account-selection policy. Application ingestion retains current
APP ownership, enablement and background-versus-member reachability behavior.

The agent proof now first reads its current application hint, locks and validates
the application, then locks and rechecks the agent's exact application relation.
Live workspace/deletion checks and final captured proofs detect a late move.
The supplied application descriptor cannot silently cross to another application.

## Runtime evidence still needed from parent

The shared-stage extraction must pass existing LOG148 rematch regressions and the
new import tests for both-field atomicity, empty touched lists, targetsOnly,
historical unchanged links, paging, stale provider run, source/Target triggers,
deferred proof and real COMMIT ACK loss. The final sent consistency patch and
agent/application proof must be in the uploaded source snapshot used by those
checks. Dependency/type/runtime results are not inferred from source review.

The 200-row bound applies to explicit selector inputs. Full Thread source and
target graphs can contain more rows. The durable touched-set recovery and initial
save audit gaps remain the documented later work.
