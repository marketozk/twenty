# LOG-083: explicit conversation CRM targets

Internal setOmniConversationTarget implements natural-key link/unlink with
expectedTargetRevision and desired active state. Current authorization is mandatory
on both sides, including replay. The existing owner resolves workspace metadata and
runs one strict native transaction with exclusive ownership fence and policy UPDATE.
Unknown/system/inactive/foreign metadata is rejected. Actual standard/custom table
naming is reused; custom objects are not guessed from a caller-provided SQL name.

Person/Company/Opportunity use exact manual MessageThreadTarget projections; Task and
custom objects use only canonical core edges. Person requires a currently verified
identity observed in this conversation, including audited birth/current provenance.
The writer never invokes automatic matching or adopts an unrelated native projection.
Unlink retains the canonical row/revision and deletes only its verified exact native
projection. Existing parent hard-delete protection also covers retained inactive edges.

Matching expected revision advances the edge; actual=expected+1 and same desired state
is an authorized read-only replay. Older requests after intervening unlink/relink
conflict. A same-state renewal increments revision/epoch while retaining its projection.
Core edge, projection, policy epoch and audit commit atomically. Strict unknown COMMIT
handling allows audited replay without false failure audit. Post-write state is reread.

Retained proof reconstructs the entire edge from create and contiguous update deltas,
checks full current state and immutable natural key, verifies each policy transition,
and checks exact native projection create/delete audit whenever projectionId changes.
A revision-only latest diff is insufficient by itself. This covers independent review
findings for unchanged-field corruption and missing projection audit. Repeated scoped
read-only review found no further confirmed blocker; reviewer ran no tests.

194 tests/5 suites +26 guards =220 PASS;32 new PG cases. Differential typecheck 316 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
32 new PostgreSQL cases cover all five object classes, actual custom table prefix,
current denial/replay, unknown/system/foreign metadata, missing/deleted records,
unverified Person, renewal and stale replay, twenty repeats, conflicting CAS,
projection collision/missing/wrong flags/FK, missing/forged retained proof, four write
failure stages, late corruption during audit flush, real COMMIT acknowledgement loss,
both link-versus-identity-rebind orders and generic deletion of a retained Company.
The five-suite run includes identity/history apply, native mutation guard and parent
lifecycle. No generic matching events are emitted by new projection writes.

The first test run found only a custom fixture grant missing UPDATE needed by SELECT
FOR SHARE. The strengthened proof initially omitted null FK fields present in create/
delete audit; that mismatch and a test error-string expectation were corrected. The
first dependency scan found a broad metadata utility import. The existing ORM manager
now composes the same table-name helper with the narrow standard application constant;
no Enterprise baseline relaxation. Differential typecheck retains187 baseline diagnostics,
with no new/changed-code diagnostics. Source LF hashes match the tested host.

No new schema or migration; all nine migration files are unchanged. Last full fork run
was LOG082 (2661/83); this slice passed the five relevant suites. The catalog remains21
resource kinds. No large-history performance claim: retained proofs currently scan the
edge's audit history. Current authorizers remain internal/test-injected; full runtime
ACL/public API, CreatePerson/autoCreatePerson, generic merge/destroy and actual external
connectors are pending. ROB-764 remains In Progress; the whole CRM is unfinished.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.
No live demo, real messaging, route activation or GitHub Actions changes.

[Tests](tests.txt), [verification](verification.json), [source hashes](source-snapshot.json), [typecheck](typecheck-differential.json).

Rollback: deploy a compatible complete version retaining canonical edge revisions and complete transition/projection/policy audits. No automatic schema/data rollback.
