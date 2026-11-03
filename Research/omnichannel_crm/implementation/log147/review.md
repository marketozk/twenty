# LOG147 independent implementation review

Root verification follow-up: 142 tests/five suites passed (61.992s), including
the requested skipped original Message changed again by a deferred audit trigger.
The real public service test confirms two message pages before calendar, copied
selection/actor, and exact unknown-outcome propagation with no calendar execution.
The first expanded run had one test-observer failure: pg QueryConfig carries
parameters in statement.values. The observer now handles both actual pg query
forms; production was not changed. Initial log retained. Types/broad regression
and publication are recorded separately after completion.

Result: no concrete production blocker identified in the inspected three-file draft. Read-only review only; no tests, dependency guard or application/runtime operations were executed by this reviewer.

## Reviewed implementation and agreed design

- `packages/twenty-server/src/engine/core-modules/crm-audit/native-message-cleanup-with-audit.ts`: new `PersonTargetHint`, optional selector in `reconcileTargetsStage`, and new `reconcileNativeMessageThreadTargetsForPeopleWithAudit`.
- `packages/twenty-server/src/engine/core-modules/crm-audit/reconcile-native-message-thread-targets-with-audit.ts`: leaf re-export.
- `packages/twenty-server/src/modules/match-participant/participant-target-reconciliation.service.ts::reconcileTargetsForPeople`: messaging-loop replacement.
- `Research/omnichannel_crm/implementation/log146/next-design.md`: reviewed in addition to the earlier next-boundary report. The implementation follows its narrow owner-reuse choice and preserved generated-field fail-closed contract.

## Concrete source findings

1. Authority is established before writes. Public service still captures full operation identity and copied UUID selectors before its first await. New entry validates bounded UUID selectors/cursor synchronously, then calls existing issued SYSTEM scope validation and metadata preparation. Service creates strict/exclusive transactions and returns the closed helper directly from the transaction callback. The chunk constant is 200, below captureCandidates' 500 bound.
2. Raw-source fence precedes discovery. The new entry takes sorted Person/Company/Opportunity SHARE table locks after prepareSession and before its LEFT JOIN discovery. Discovery does not lock child rows; it retains orphan/missing-message hints for cursor progress. Source writes by independent transactions are fenced, while existing source-image checks catch own-transaction trigger effects.
3. Parent-first stage locking is unchanged. Exact original Participant, Person, Message and Thread IDs are retained separately in selectionBefore using nonlocking full-row reads. This does not follow a moved child into an unlocked parent. Empty results preserve absence because the fixed original-ID lists are retained for every reread.
4. Admission requires a row to be present identically in both the locked graph and original-ID snapshot. Participant.personId, Participant.messageId and Message.messageThreadId must equal the discovered values, and Participant/Message/Thread must remain live. Hints moved to another selected person are skipped as required.
5. `selectedThreads` intersects the admitted set before liveMessages/desiredTargets and existingTargets are built. Thus both sides of the planner exclude stale-only roots. Other live people on an admitted thread still contribute their targets. APP filtering is not added, and the existing live/unowned Thread filter remains intact.
6. Selector proof is registered in session.validators before target DML and explicitly executed immediately before repository access. Existing finalizeSession executes it before audit flush and after SET CONSTRAINTS ALL IMMEDIATE. Original rows outside the locked root graph therefore remain covered through final deferred drain, rather than disappearing from root predicates.
7. Direct thread-ID behavior is preserved: its call omits personHints, so no selector snapshots/fence are added and the new admission condition is vacuously true. Target DML, RETURNING checks, incoming-FK checks, snapshot verification and audit implementation are unchanged. Generated-dependent flag update effects continue to fail closed; support was not expanded.
8. Full pages return the final discovered participant ID, including all-skipped pages. Public service processes all messaging chunks/pages before calendar, preserves successful earlier commits, and propagates rejection without catch/retry/wrapping. No domain writes follow finalization within the page.

## Narrow critical acceptance case

Ensure the new suite includes a proof-specific case that existing root-graph tests cannot cover: discover two hints; before locks, move one original Message to a different thread outside the selected roots; let the other hint admit a root and produce a target write; then mutate the moved original Message (or an absent original row resurrected under its retained ID) during audit/deferred drain. The page must roll back via `Native person target selection changed`. Merely testing a deferred move of an admitted child would also be caught by the existing root graph verifier and would not establish this new selector-proof path.

No other critical missing acceptance requirement identified beyond the parent's already planned suite. Runtime status and dependency-guard approval remain parent-owned evidence. No checkout source edits were made.
