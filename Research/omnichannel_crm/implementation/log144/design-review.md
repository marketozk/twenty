# LOG144 design review

Read-only review of log144-next-boundary.md and actual matcher, target policy, calendar coordinator and WorkspaceDataSource. No implementation/runtime changes.

## Verdict

The proposed closed `MatchParticipantService.matchCalendarImportParticipantsWithAudit({workspaceId,participantIds,eventIds,operation})` is the smallest coherent production boundary. Keep its system-context + strict/exclusive transaction inside the existing service, with one audit context and one final flush. Do not call the legacy public matcher/target writer as an opaque stage: that would hide actual RETURNING and allow later discovery to adopt earlier trigger changes. Reuse their existing email selectors and the pure `computeTargetReconciliationOperations` instead. No exported scope/callback/audit-context parameters are needed.

EE architecture is sound in principle: MatchParticipantService already imports WorkspaceOrmManager, email query-builder helper, Person/Member types and the old target service. Keep those edges there. The pure target planner has no imports and is safe to reuse. New helpers should be structural leaf proofs only, not import entity/query-builder/planner service dependencies. Actual guard is still required; this review does not claim a guard pass.

## Lock lifecycle

- `WorkspaceDataSource.transaction:147–158` acquires native ownership before callback and any record rows. Original issued strict/exclusive SYSTEM scope must be checked; do not upgrade an existing shared scope or nest this terminal owner in a caller transaction.
- Set lock timeout, lock active workspace, acquire deterministic physical table locks before native graph rows. Source `person`, `workspaceMember`, `company`, `opportunity` SHARE locks must all precede email discovery and Event/Participant row locks. They freeze INSERT/UPDATE/DELETE absent-candidate predicates for other transactions in that workspace's physical tables. This is stronger and broader than source row locks; document its workspace-wide DML blocking cost and keep provider/network/queue work outside the transaction.
- All native graph table DDL locks should also be acquired consistently before graph rows. Lock Event roots before Participant/Target. Required actual FKs must exist before using parent locks as child insertion fences. Association and CallRecording are unchanged retained graph.
- Once source SHARE locks are held, source row FOR UPDATE locks are unnecessary for external DML stability and can introduce needless FK lock contention. Exact source snapshots and final rereads remain necessary because same-transaction triggers can mutate despite locks owned by that transaction.
- This is not a no-deadlock guarantee for arbitrary raw writers that acquire source tables in reverse order. Known rollback on lock timeout/deadlock is acceptable; do not mask it or add automatic retries. Cooperative native writers already acquire the ownership fence first, avoiding the fence/Person inversion described in WorkspaceDataSource.

## Exact existing semantics to preserve

- `MatchParticipantService:178–254`: Person candidates are ordered only by createdAt ASC; matching helper checks primary email first, then additional email. Query uses withDeleted, LOWER primary, but JSONB containment of lowercased input for additional emails. Do not replace with a more permissive lowercase-every-additional SQL predicate: uppercase stored additional email can be excluded by the actual query even though the in-memory helper is case-insensitive. Do not invent an id tie-break.
- WorkspaceMember candidates are live and use exact userEmail equality. Null handles become empty string for matching after discovery; preserve the existing empty/null behavior, including the selector's empty-input handling.
- Only requested actual live Participant IDs are rematched, and only personId/workspaceMemberId may change. Do not rematch all event participants: linked-event participants intentionally are not part of savedParticipantIds. Targets, however, derive from **all live participants** of every supplied event ID, including unchanged/unrequested participants and linked events. Empty participantIds still reconciles supplied eventIds.
- Target Person derivation is live-only, so matching a soft-deleted Person can set participant.personId but produces no Person/Company/Opportunity target. Company IDs come from a live Person without requiring a live Company. Opportunities are live and matched by pointOfContactId. Existing manually assigned flags and tombstones follow the pure planner unchanged.
- Keep target INSERT `{onConflictDoNothing:true}` and actual-only effects, but reject an unaccounted concurrent/trigger-created same-key row through graph readback. Do not claim its presence is an audited successful insertion.
- Missing target metadata previously meant legacy no-op (`participant-target-reconciliation.service:304`). The new audited entry should require the exact expected standard graph; keep old upgrade/backfill entry behavior outside this new path. Record that explicit coverage boundary.

## One admission detail to settle explicitly

The new input gives participantIds and eventIds separately. A requested Participant may now belong to an Event outside supplied eventIds because of a committed move before the matching transaction. The old matcher updates it by ID but only reconciles the separately supplied sourceRecordIds, potentially leaving the new parent stale. Do not reproduce this incoherent partial graph silently, and do not silently widen the mutation to a new parent without a contract. Narrow safest admission for import is to retain/skip requested participants whose current parent is outside captured eventIds; include their original-ID snapshots in final proof. A move discovered after baseline must fail. If a different policy is chosen, explicitly test/document it. Actual current import outputs should normally keep the lists consistent.

## Snapshot and actual-effect proof

Capture all fixed graph/source before-images before first Participant UPDATE. Source coverage must include (a) every matched email selector result, with deleted Person candidates, (b) original returned IDs even if later moved out of the selector, (c) person IDs of all current event participants used for targets, (d) all relevant Company/Opportunity sources, and (e) Member candidates including late resurrection into the live selector. Re-run fixed selectors plus original IDs at finalization to detect new/moved/restored candidates by own triggers.

After each Participant update batch, derive links from actual RETURNING and verify the full expected graph before deriving target desired state. Skipped UPDATE is a legitimate unchanged row; target plan uses actual applied links, not proposed ones. Then perform target INSERT/flag UPDATE/DELETE in bounded batches, validating earlier expected images before each subsequent stage. Unknown populated incoming FK mutation effects must refuse before writes. Audit only actual Participant/Target effects; retain all other row snapshots exactly, including generated-column/precision rules already established in LOG143.

Finish fixed source and graph validation -> audit.flush -> SET CONSTRAINTS ALL IMMEDIATE -> source/graph validation. Commit errors retain strict outcome classification. No further database graph writes after this terminal return.

## Coordinator / attribution

Preserve current enqueue -> matching order (`calendar-event-participant.service:83–123`). Queue payload construction and enqueue stay outside the matching transaction. Copy IDs and operation before the coordinator's first await; use fresh matching operationId with the save actor/initiator/correlation, not contact payload fields or a default invented system actor. Save and matching are separate committed units. If enqueue succeeds then matching fails, the queued contact job remains; if enqueue fails, matching does not start. LOG143's postcommit wrapper must preserve this without replaying save/provider or silently duplicating enqueue.

The proposed entry must not claim to cover `matchParticipantsForPeople`, `matchParticipantsForWorkspaceMembers`, calendar rematch listeners/jobs, contact creation, or person-company target jobs. Those existing entry paths remain for later migration.

## Acceptance additions

Besides the boundary report's PG matrix, specifically test uppercase stored additional email versus lowercase input, createdAt-tie policy unchanged, retained trashed Person match/live-only target split, unrequested live participants contributing targets, participant moved outside supplied eventIds, and same-transaction source resurrection/new email candidate after initial matching. Test source SHARE locks in both writer orders and queue-first/matching-failure versus queue-failure/no-matching at the real coordinator. No deployment or delivery guarantee follows from these tests.
