# LOG-082: explicit identity Person binding

Internal setOmniIdentityPerson implements link/rebind/unlink with nullable Person,
expected identity revision and actor-scoped idempotency key. Its existing native owner
runs strict transaction semantics with exclusive native ownership and policy UPDATE
before binding/conversation/identity locks. Current authorization is mandatory on
initial and replay. Workspace-specific Person metadata is resolved by the existing
ORM manager; the leaf receives only a narrow descriptor and native mutation ports.

Only native FROM participants belonging to the exact immutable externalIdentityId are
updated. Other external authors, even unbound authors in the same thread, remain
separate. Old immutable author snapshots, provider identity and message text are not
rewritten. Retained audited identity transitions explain the difference between birth
Person and current relation; missing/forged transitions fail closed. Initial/history
replay and subsequent edit/delete use current native Person while retaining birth
provenance. This is not automatic contact guessing or merging.

When Person changes, old active canonical Person edges in affected conversations become
inactive with revision+1; their verified exact manual native projections are deleted.
There is no automatic new Person/Company/Opportunity target. Native participant changes,
canonical target invalidation, projection deletion, identity CAS, policy epoch, redacted
audit and PolicyMutationReceipt commit together. Post-write readback verifies state.
A repeated key returns its original result after current authorization and exact
identity transition / corresponding policy epoch audit verification, including after
later identity changes. Unknown COMMIT outcome does not append a false failed audit.
The audit catalog now has21 resource kinds, including canonical and native targets.
No schema or migration change.

2661 tests/83 suites +26 guards =2687 PASS;21 new PG cases. Differential typecheck 313 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
21 new PostgreSQL cases cover rebind/unlink/relink and old replay, independent authors,
twenty identical concurrent commands, conflicting concurrent CAS, current denial and
revocation, missing/deleted Person, foreign workspace, forged/missing transition proof,
corrupted result epoch, rollback at participant/projection/audit/receipt writes, real
COMMIT acknowledgement loss, and advanced edit/delete after rebind/unlink. Ordinary
native/event regressions are included in the full fork run. New paths emit no generic
matching events. Local and tested source LF hashes match.

Read-only review found advanced revisions still comparing the historical Person and
an incomplete retained result epoch proof. Both findings were fixed and covered by
regressions. The first targeted runs additionally exposed a UUID/text audit join and
several test expectation/type issues; all were corrected before the final full run.
The Enterprise dependency guard found broad imports, which were replaced with narrow
ports and metadata resolution in the existing owner. Guard baseline was not changed.
Typecheck is differential:187 pre-existing diagnostics remain; it is not a claim of a
clean full server build. No large-history performance claim: transition verification
currently reads retained identity audit history.

The writer is internal. Full own ACL/public API, CreatePerson/autoCreatePerson,
explicit new target creation, generic merge/destroy lifecycle and real transport
wiring are still pending respective acceptance boundaries. ROB-764 remains In Progress.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.
No live demo, real messaging, route activation or GitHub Actions changes.

[Tests](tests.txt), [verification](verification.json), [source hashes](source-snapshot.json), [typecheck](typecheck-differential.json).

Rollback: deploy a compatible complete version retaining identity transition audits, canonical edges and receipts. Do not revert to a reader that assumes historical Person equals current Person. No automatic data rollback.
