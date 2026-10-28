# LOG-081: qualified external identity registration

Internal registerOmniExternalIdentity accepts qualified peer/source, expectedRevision0,
route generation and an actor-scoped idempotency key. It reuses the strict core transaction
owner and exclusive native ownership fence. Existing workspace policy is locked UPDATE
before receipt/binding/identity; current authorization is mandatory on initial and replay.
New registration creates only unbound identity revision1 and increments policy epoch;
identity, redacted audit and PolicyMutationReceipt commit together. A different key does
not silently overwrite an existing peer/Person. No automatic contact lookup/creation.

Replay returns the original result/operation after current authorization, verifies the
retained identity-create and policy-update success audits, and never redoes mutation/CAS.
Expired result is visible, actor-key payload/action conflict is rejected. Original
registration result is historical; current identity facts are separately passed to the
authorizer. Generation is fenced on initial creation; authorized replay can acknowledge
an older committed registration after a route generation change. Failure/denial audit is
written only after the transaction owner confirms rollback/release by preserving the
callback error. Unknown COMMIT/ROLLBACK does not create a false failed business entry.
The audit catalog now includes omniExternalIdentity (19 resource kinds); peer/source
are redacted. No new schema or migration.

183 tests/11 suites +26 guards =209 PASS; 27 new PG cases. Differential typecheck 310 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
27 new real PostgreSQL cases cover twenty concurrent retries, actor/action key conflicts,
existing bound identity, current denial/revocation, expiration, route precision beyond
Number.MAX_SAFE_INTEGER, workspace isolation/deletion, identity/audit/receipt rollback,
real COMMIT acknowledgement loss, unknown rollback connection discard, caller mutation,
late row corruption, retained audit corruption, and registration followed by actual
native incoming persistence. Read-only review found the missing replay audit proof;
that finding was fixed and covered by three corruption regressions. The first run also
found an incorrect test event-spy reference; the typecheck found an overly narrow UUID
variable type. Both were fixed before the final 183-test run and differential typecheck.
No new diagnostics; the 187 existing baseline diagnostics remain. Previous full fork
run was LOG079; this bounded change uses relevant suites. Source hashes match the host.

The runtime function is internal only. Real adapter qualification/discovery scheduling
and public endpoints are not wired. Existing ingress still receives an explicitly
registered identity UUID. Link/unlink/rebind/CreatePerson and target writers remain
next; future identity mutation must preserve birth author and support authorized old
message replay. ROB-764 remains In Progress and the whole CRM is unfinished.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.
No live demo, real messaging, route activation or GitHub Actions changes.

[Tests](tests.txt), [verification](verification.json), [source hashes](source-snapshot.json), [typecheck](typecheck-differential.json).

Rollback: deploy a compatible complete version, preserving identity/receipt/audit rows. No automatic schema/data rollback.
