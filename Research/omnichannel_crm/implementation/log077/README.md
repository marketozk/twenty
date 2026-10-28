# LOG-077: current revision schema and initial persistence

Added eighth fork migration: nullable MessageLink.currentRevisionId without default
or backfill, Revision UNIQUE(workspaceId,messageLinkId,id), and validated nondeferrable
FK Link(workspaceId,id,currentRevisionId) to that exact revision. Existing seven sources,
checksums and historical schema snapshots are unchanged. Prefix-aware verifier selects
the new Link/Revision snapshot only after eighth ledger entry. Down takes table lock and
refuses any nonnull head instead of destroying current-revision evidence.

New initial history/sent composition inserts Link(NULL), Revision, then head in one
strict native transaction. Final logical Link create audit includes currentRevisionId;
success counts stay 10/14/11. Runtime fixture gets only UPDATE(currentRevisionId).
Replay permits legacy NULL only with the exact single validated initial revision; it
does not adopt NULL or rewrite retained audit. The legacy fixture clears a new graph's
head and retains its new audit shape, so it does not independently simulate every
historical audit serialization. Later domain revisions must support current-head proof
independently from old initial evidence before editing is enabled.

Read-only review found history head readback occurred before audit/final receipt writes.
Added another final readback and PG AFTER-audit/AFTER-receipt trigger regressions. Sent
already rereads core/native graph after both boundaries. Reviewer ran no tests.

Full fork 2508/77 before final history readback; final targeted 188/6 +26 guards PASS. Typecheck 298 roots:187/187,0 new/changed-code. Eight migration sources verified; first seven unchanged.
Full-suite source hashes are retained separately: only history writer and its test file
changed afterward for final readback plus two regressions; all six relevant suites rerun
on final source. No claim that the full suite ran on those last two file versions.
New cases: populated prefix7→8/replay/null down-up; wrong Link/workspace FK; protected
revision deletion; rollback refusal; schema/default/type/FK drift; new head/audit;
legacy NULL replay; ambiguous revision rejection; head UPDATE fault/null tampering and
late audit/receipt tampering. Two old corrupt-fixture setups needed explicit NULL head;
cross-tenant fixture removed an absent provider column. All corrected before final gate. Differential typecheck also found an unknown query row access; explicit UUID row validation removed the new diagnostic, and the six suites/typecheck passed again.

Next: §15.10 incoming text revisions (placeholder/fill/edit/delete). Durable applied
disposition is also required: current receipt.resultId remains canonical MessageLink,
while duplicate/stale need immutable selected/observed revision evidence after head moves.
Use a nullable typed applicationResult on receipt, not audit diffs as operational state
or fake DomainEvents. New incoming writer will validate this outcome and current native
head; automation remains suppressed v0. Public API/UI/transport are later tasks.
ROB-764 remains In Progress. No live demo/provider changes, no Actions. Baseline server
diagnostics remain unresolved. Skills: ai-dev-workflow, behavioral-guardrails,
server-schrodinger; scoped read-only research/review.

[Final targeted tests](tests.txt), [full before final readback](full-tests-before-final-readback.txt), [verification](verification.json), [source hashes](source-snapshot.json), [full source hashes](full-suite-source-hashes.json), [typecheck](typecheck-differential.json).

Rollback: deploy complete prior code only with a reviewed schema compatibility decision; no automatic populated schema rollback. New migration down refuses retained heads.
