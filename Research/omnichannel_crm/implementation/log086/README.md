# LOG-086: exact-record detached parent deletion boundary

An issued exclusive transaction scope can temporarily grant hard deletion to one
registered native repository for one workspace/object metadata ID/record ID. Scope,
repository and transaction identity are checked using existing internal issuance.
Caller-created copies and permission bypass flags confer no authority. The grant
is revoked on callback completion or failure and cannot survive transaction release.

Before parent row selection, policy UPDATE is acquired. A closed, immutable manifest
names every retained target tombstone and revision. Each edge must be inactive with
no projection and have complete retained transition/policy audit proof. Person must
have no current ExternalIdentity binding or owned MessageParticipant reference;
Person/Company must have no owned MessageThreadTarget reference, including deleted
native rows. History/tombstones are retained, not erased to evade ownership guards.

WorkspaceRepository still denies generic protected hard delete. The exemption
requires exactly one locked row and the exact workspace/metadata/record manifest.
Detachment is rechecked through the actual native executor after selection. An
unprotected companion row in a batch is not authorized by this grant. Ordinary
unprotected behavior is unchanged; existing FK behavior is not replaced here.

231 tests/6 suites (105/4 +126/2) +26 guards =257 PASS;28 new PG cases. Differential typecheck 320 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
28 new PostgreSQL cases cover Person/Company preservation; ordinary refusal;
active/missing/extra/stale targets and missing audit; retained identity and unexplained
native references, including soft-deleted rows; copied/shared/foreign/previous scopes
and repositories; wrong metadata/mixed batches; callback failure/normal revocation;
caller mutation and late reference creation. Six concurrent races exercise target
reactivation and identity binding in both transaction orders. Native guards and
identity/target/lifecycle regression also pass. Typecheck initially caught unsupported
toSorted and an ambiguous helper promise type; copied-array sort and an async helper
fix the errors without widening TypeScript settings. No dependency baseline change.

Read-only review found no confirmed blocker; suggested race coverage was added.
This is an internal prerequisite, NOT the completed domain destroy command. The
positive fixture deletes through the temporary grant but does not establish a
production destroy audit, idempotent receipt, current ACL or governed delete event.
The next writer must atomically unbind identities, deactivate targets, invoke this
boundary and flush its own destroy audit/receipt. Current startup/restart with nine
migrations and final full regression remain required. ROB-764 stays In Progress.

No demo mutation, external messages, route activation or GitHub Actions.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.

[Tests](tests.txt), [native regression](native-regression.txt), [verification](verification.json), [source hashes](source-snapshot.json), [typecheck](typecheck-differential.json).

Rollback: leave the new boundary unused; generic parent refusal remains active. No schema migration, runtime activation or committed customer deletion is part of this change.
