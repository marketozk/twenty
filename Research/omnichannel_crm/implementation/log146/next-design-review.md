# LOG147 independent design review

Decision: approve the narrow closed person-selector page design for implementation. No concrete design blocker found. This is read-only source review, not runtime/dependency-guard acceptance.

## Evidence inspected

- `src/engine/core-modules/crm-audit/native-message-cleanup-with-audit.ts`: `createSession`, `prepareSession`, `finalizeSession`, `reconcileTargetsStage`, `reconcileNativeMessageThreadTargetsWithAudit`.
- `src/engine/core-modules/crm-audit/reconcile-native-message-thread-targets-with-audit.ts`: existing re-export facade.
- `src/modules/match-participant/participant-target-reconciliation.service.ts::reconcileTargetsForPeople` and current calendar page owner.
- `src/modules/match-participant/listeners/participant-target-person.listener.ts::handleUpdatedEvent`.
- `src/modules/omnichannel/services/find-omni-owned-native-record-ids.ts` and `assert-omni-native-write-unowned.ts`: ownership predicates.
- `src/modules/match-participant/match-participant.service.ts::withoutAppChannelParticipants`: separate APP exclusion.
- Proposed boundary: `C:/Users/regis/AppData/Local/Temp/log147-next-boundary.md`.

Source paths above are relative to `packages/twenty-server`.

## Why reuse is sound

The existing owner already has the right terminal lifecycle: session validators, audit flush, deferred-constraint drain, then the same validators again (`finalizeSession`, around lines 250-256). Keeping selector proof in this private session avoids an unsafe public terminal call followed by validation or further writes. Reusing its private target DML avoids a second target mutation implementation.

`reconcileTargetsStage` locks Thread -> Message -> Participant -> Person -> Company -> Opportunity -> Target and its read closure retains captured IDs alongside parent predicates (around lines 1074-1120). It derives desired targets from every live participant on selected threads and filters existing targets by the same selected roots. A new private selector parameter can intersect `selectedThreads` before either planner input is constructed without changing direct thread-ID behavior.

The current stage has sorted ROW EXCLUSIVE table locks, not SHARE source-table locks. The proposed additional sorted Person/Company/Opportunity SHARE fence before discovery is necessary for raw-source absence protection and can stay local to the new entry. Existing parent row locks and required actual FKs remain necessary; the table fence does not replace them.

The current public service captures and validates the full operation before its legacy messaging transaction (around lines 119-137). Replacing only that messaging loop with strict/exclusive pages preserves the already established validation and messaging-before-calendar order. Same DI and a leaf re-export are the smallest change; actual dependency guard still decides whether the new import edge is acceptable.

## Implementation invariants to preserve

1. Capture discovered participant ID, exact person ID, message ID and thread ID before locking. Discovery must not lock children first. LEFT JOIN/nonlocking message hints must allow missing/deleted-message candidates to advance the cursor.
2. After parent-first locks, only a still-live exact discovered chain can admit a root. Keep discovered roots separate from admitted roots. Intersect BOTH desired and existing planner inputs with admitted roots. A stale hint alone must neither clear the old thread nor authorize its new thread.
3. Freeze a separate full snapshot/absence proof for every originally discovered Participant and Message after locking and before target DML. The proof must retain original IDs even if rows are absent, moved, deleted or outside captured roots. Do not adopt a later reread as the baseline. Register this verifier within the session so audit-flush and deferred triggers cannot escape the final check.
4. Do not lock moved original children outside locked roots, because that can reverse parent-first order. Nonlocking original-ID proof reads are acceptable for rejection; a changed proof fails the page atomically. They must not authorize another parent.
5. Retain existing source graph fixed-predicate plus original-ID checks. Table SHARE blocks other transactions; repeated proof catches this transaction's own target/audit/deferred trigger changes, including new relevant opportunities.
6. Run private target stage once, finalize once, then return cursor with no later domain writes. Use final discovered participant ID on a full page even when every candidate is skipped. Stop subsequent pages/calendar on ordinary, unsafe-commit or post-commit errors without automatic replay.

## Policy findings

- Ordinary APP target eligibility is real: ownership helpers derive exclusion from omni Conversation/MessageLink/AccountBinding, including bound associations. APP type exclusion is in matching, a different lane. Therefore preserve an ordinary unowned APP thread here and preserve the matcher exclusion separately.
- Deleted Thread behavior changes explicitly to the existing audited owner's policy. `selectedThreads` checks Thread.deletedAt, while legacy generic target code did not directly do so. Keep deleted Thread targets untouched and document this intentional adoption; do not claim exact legacy Thread-liveness compatibility.
- Trigger coverage remains limited to Person.companyId unset -> set. Company replacement/removal, Opportunity events, and Person deletion/restoration remain outside LOG147.
- Existing target-stage generated-dependent updates fail closed when unexpected fields change. A reused page must not advertise generated update support without a targeted correction/test. Preserving and documenting inherited fail-closed behavior is acceptable in this slice.

## Required focused verification

Use real PostgreSQL and actual public service/job path for: original Participant/Message drift before lock and during audit/deferred drain; missing originals then resurrection; source-table SHARE blocking and late Opportunity creation; all-skipped 200-row cursor; global derivation for non-triggering people on admitted thread; mixed admitted/stale/owned roots; ordinary APP vs omni ownership and ownership at flush; deleted Thread target preservation; unchanged participant/message sources; actual DML and existing native-target regression. Keep LOG146 calendar regression and unchanged generic entry controls. Dependency guard must pass without baseline changes or hidden import edges.

No source files or runtime state changed by this reviewer. Only this TEMP report was written.
