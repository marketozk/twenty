# LOG145 design review — calendar rematch pages

Read-only review of current checkout and `log145-next-boundary.md`. No runtime checks or application edits. Paths below are relative to `packages/twenty-server`.

## Conclusion and minimal public contract

The proposed boundary is coherent. Keep both legacy generic methods for messaging; replace only their two calendar job call sites. Reuse the LOG144 owner rather than copying its roughly 895 lines.

Suggested terminal API on the existing MatchParticipantService:

```ts
rematchCalendarParticipantsWithAudit({
  workspaceId, operation, selector, afterParticipantId,
}: {
  workspaceId: string;
  operation: CrmAuditOperation;
  selector:
    | { kind: 'personOnly'; personEmails: readonly string[] }
    | { kind: 'workspaceMemberOnly'; workspaceMemberIds: readonly string[] };
  afterParticipantId?: string;
}): Promise<{ nextCursor: string | null }>;
```

Each invocation owns one strict/exclusive SYSTEM transaction and one audit flush, with fresh operationId preserving captured worker correlation. It copies selector arrays, operation actor/initiator and cursor before its first await. No public scope/session/validator/callback argument. Fixed page size 200, not caller-controlled. Empty criteria is a validated no-op. The job loops people pages first, then member pages, maintaining separate cursors. It does not catch unsafe outcomes or continue the second lane after an error.

Return `nextCursor` equal to the final **discovered** participant ID for a full 200-row page, even when every row is skipped. Return null for an underfull/empty page. An exactly full last page gets one final empty query. Do not derive progress from updated IDs or audit count. A structured cursor result avoids incorrectly conflating a valid no-op with end-of-scan.

## Small private factorization

Current `matchCalendarImportParticipantsWithAudit` at `src/modules/match-participant/match-participant.service.ts:140–369` has input capture, context/transaction ownership, and one large fixed business stage. Extract the body after prepare into one private method, for example:

```ts
runCalendarMatchingStage(state, {
  participantIds, targetEventIds, matchWith,
})
```

`matchWith` is the private closed union `both | personOnly | workspaceMemberOnly`. The method owns graph baseline, source candidate proof, participant writes, optional target writes and finishMatchingAudit. It is never exported. The import facade keeps its existing exact-ID contract and both mode, and can still reconcile explicit event IDs when participantIds is empty. The rematch facade prepares its state, discovers the page, populates private rootIds/participantIds, and uses the same stage with its current selection policy. A private selector parameter or tiny private selection helper is acceptable; do not pass arbitrary functions.

The stage needs separate **proof roots** and **target roots**. `state.rootIds` covers originally discovered parent IDs for locks and retained snapshots. `targetEventIds` covers only admitted current participants' parents for person-only reconciliation. Filter both desired and existing targets by this set. The present existingTargets mapping at about lines 322–339 maps every captured target; retaining this unchanged while filtering only desiredTargets would delete targets of an excluded/moved participant's old event. Member-only bypasses the entire target planner/write block, while preserving full target snapshots.

All existing helpers below prepare remain shared and unchanged where possible: metadata/FK checks, source and graph reads, typed/generated images, actual RETURNING writers, deferred checks and final audit. No extraction into a new EE-reachable helper module is necessary.

## Discovery and row locking

`prepareCalendarMatching:371–478` already checks the issued capability, workspace, exact nine shapes, source SHARE locks and graph table locks. Call it with empty root/participant IDs **inside** the strict/exclusive transaction before page discovery. WorkspaceDataSource obtains the native ownership fence before entering this callback. Do not discover or lock native participants in the job before that fence.

After prepare, select `id, calendarEventId` from live Participants, ordered by id, `id > cursor`, LIMIT 200, with the existing lane selector. People uses `LOWER(handle)=ANY(lowercase captured emails)`; member uses current `workspaceMemberId=ANY(captured IDs)`. Do not lock Participants in this initial query: discover parent hints first, then lock Events before Participants via existing readMatchingGraph, preventing inverted parent/child lock order. Populate state.participantIds with all discovered IDs so moved/retained rows remain in the graph readback by original ID.

Under those locks, revalidate live status, lane selector and parent equality against discovery. A row that disappeared or moved to a new parent before its lock is skipped for this page, rather than modifying a child of an unlocked parent or discovering/locking new parents out of order. Its locked current row, if present, remains in full retained snapshots. A selector change before baseline similarly skips. After the baseline, triggers changing handle, member/person link, parent or any other captured field must fail existing exact readback; never recapture them as a new valid baseline. Other eligible participants on the page can still proceed.

For target roots, require the corresponding locked Event proof and apply the same supported parent assumptions as LOG144; do not broaden into arbitrary orphan/null-parent handling incidentally. The actual entity declares calendarEventId:string. Existing generic methods map it directly without adding an orphan policy.

The page bound limits discovered candidates, not total graph/source rows: one Event can contain many Participants/Targets. State this honestly. Source SHARE locks are workspace-table-wide and remain held only for this page. Concurrent raw inserts/new selector matches behind the cursor can require a later job; neither this design nor the legacy job proves a durable whole-workspace snapshot/completion.

## Preserve link and target semantics; explicitly fix the member bug

The legacy people wrapper (`:1209–1258`) selects email handles and requests personOnly. Compute/write only personId in this mode. Preserve actual workspaceMemberId byte-for-byte, including stale or soft-deleted member references. Reconcile targets from every live participant of admitted events using the post-RETURNING expected graph, not merely selected participants.

The legacy member wrapper (`:1171–1204`) selects only already-linked IDs; CREATED member events do not discover unlinked same-email participants. Preserve this selector. Compute/write only workspaceMemberId; preserve personId and all targets without target DML.

The wrapper currently changes the supplied workspaceMemberId to null before comparison. A no-match becomes equal to that artificial null and leaves a stale non-null DB link; an equal real match causes unnecessary UPDATE. Replace this with comparison against the actual locked before-image. This deliberately fixes the stale-member-link bug: no-match clears the selected link, equal actual match performs no write/audit/timestamp change. Record it as a behavior fix, not an audit-only refactor. Do not transfer this change into the still-legacy messaging wrapper in this slice.

## Job attribution and atomicity

`calendar-event-participant-match-participant.job.ts:33–62` currently has only ACTIVE precheck, people lane and member lane. Capture the workspace, both criteria arrays and named systemMembershipCleanupIdentity before its repository await. Use the actual worker name; listeners supply no trusted original user identity. Preserve the ACTIVE precheck and owner's separate deletedAt guard; do not claim activationStatus is transactionally fenced.

Every page is independently committed/audited. If page two fails, page one remains committed. No event emission or queue effects are promised durable. The job has no error normalization now; preserve propagation and the existing central queue unsafe-outcome handling. Shared invocation correlation across page operations is sufficient; do not manufacture parent user attribution.

## Focused acceptance additions

- Import API regression: both-link mode and targets-only supplied event IDs unchanged after extraction.
- Person-only preserves non-null opposite member link; member-only preserves person and exact Target rows, with no target events.
- Explicit stale-member no-match clears and equal-match is no-op; unlinked participant remains unselected on member CREATED hints.
- 201+ candidates, first 200 all skipped or unchanged, final candidate processed; both lanes have independent cursors and shared invocation correlation/fresh page operation IDs.
- Parent moves and selector changes between unlocked discovery and row lock: skipped current row retained; no stale old-parent target pruning. After-baseline mutation rolls back.
- Multiple participants from one event across pages: target policy sees all live event participants, no duplicate audit of unchanged targets.
- Later-page failure preserves prior page commit, rolls back only current page, and prevents subsequent lane; unsafe exception instance unchanged.
- Existing messaging callers stay on legacy methods and controls remain unchanged. No calendar call path should invoke the old methods again after the new page owner.

No concrete blocker remains in the proposed bounded design provided proof-root/target-root separation and actual-image member comparison are implemented as above. Runtime acceptance remains pending parent-owned implementation/tests.
