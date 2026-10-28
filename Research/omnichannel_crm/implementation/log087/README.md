# LOG-087: atomic administrative parent destroy

Internal destroyOmniCrmParent reuses the current aggregate transaction owner and
LOG082/083 leaf writers plus LOG086 exact-record deletion capability. The closed
request has metadata/record ID, full native-row SHA256 fingerprint, exact identity
and target revision manifests, and actor-key idempotency. No public endpoint or
permission bypass option is introduced. A mandatory CURRENT administrative destroy
authorizer receives all retained identity/target/conversation scopes and current
conversation scopes; history is never treated as an enduring grant.

One strict exclusive transaction locks policy, bindings, conversations, identities
and then the parent. It unbinds all current identities and deactivates remaining
targets without erasing retained target transitions, Message/Thread or author history.
Child operation IDs are distinct and stable within the root operation. Actual
pg_constraint/attribute metadata is inspected for every inbound FK, including custom
and composite keys and soft-deleted child rows. Any remaining reference causes a
full rollback. This bounded writer does not silently accept unaudited SET NULL or
cascade effects; full general native lifecycle work remains ROB765.

The native parent delete, root policy epoch, root audit and receipt are committed
together. A parent snapshot fingerprint is rechecked before deletion. Final native
history fingerprint, parent absence, retained detach proof, receipt, policy and root
audit are checked after the final receipt write. Only expected participant personId
and updatedAt changes are allowed; timestamp is cast through the actual native row
type and all other row fields remain compared. Generic raw events are suppressed.

The existing audit catalog adds omniCompany (23 kinds total) and a closed
currentWorkspaceAdministration deletedParent descriptor with metadata/name. Parent
destroy cannot substitute one arbitrary binding scope. Retained multi-binding
manifest is bound to root audit by destroyScopeHash; content/names remain redacted.
A retained actor-key receipt is read before looking for a live parent. Replay requires
current authorization and retained audit/policy integrity; it never deletes a new row
that reused the old ID. Missing receipt cannot establish previous success. Real COMMIT
acknowledgement loss remains unknown until retry; it does not emit a false failed audit.

209 tests/8 suites +26 guards =235 PASS;37 new PG cases. Differential typecheck 323 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
37 new PostgreSQL cases include multi-binding unlink, current versus retained queue,
caller snapshot, stale manifests, wrong metadata, no target, absent parent,20 retries,
real COMMIT ACK loss, revoke, altered receipt/scope/missing audit, five injected failure
stages, custom and composite/soft-deleted FK refusal, late body/author/participant
corruption and five invalid audit descriptor variants. The corruption trigger has
owner privileges ONLY in the test fixture to exercise the final history guard; normal
runtime correctly cannot change immutable author fields. Existing audit, target,
identity/creation/automatic-creation and lifecycle suites also pass.

Investigation fixes: pg_catalog name arrays needed explicit text casts for the driver;
expected participant timestamp initially omitted the ORM updatedAt write. Read-only
review confirmed the timestamp issue and lock-order discrepancy; both were corrected.
Fault-injection assertions inspect the preserved PostgreSQL cause through the ORM
error wrappers. Re-review found no remaining confirmed blocker; composite FK tests
were added. No dependency baseline or migration source was relaxed.

ROB764 is still In Progress: current actual server/worker startup/restart on empty and
previously upgraded DBs and final full fork regression are pending. Full native audit
is ROB765, public authorization/UI integration ROB766/768, and governed delete/visible
events ROB769. This does not enable normal UI hard-delete or background trash to use
the administrative domain command automatically. No production demo or transport
was changed. GitHub Actions was not used.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.

[Tests](tests.txt), [verification](verification.json), [source hashes](source-snapshot.json), [typecheck](typecheck-differential.json).

Rollback: leave the new internal entry point unused; protected generic deletion remains denied. No schema migration or runtime activation is required. Keep all committed audit/receipt/history tombstones; never treat destructive data restoration as a code rollback.
