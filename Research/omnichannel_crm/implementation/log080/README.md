# LOG-080: incoming messages from unbound identities

The incoming apply contract now accepts nullable personId on an existing qualified
ExternalIdentity. Authorizer receives the explicit null. Only a non-null personId
requires a live Person lookup. The actual native participant writer and retained
revision-chain proof preserve null, without calling contact matching/creation or
projecting CRM targets. Distinct external identity/peer IDs remain distinct authors.
A dangling non-null Person reference is rejected, not converted into unbound mode.

116 tests/4 suites +26 guards =142 PASS; 15 new PG cases. Differential typecheck 308 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
Fifteen new PostgreSQL tests cover history/live and existing/new Conversation,
placeholder/fill/edit/delete, legacy replay, current authorization including replay,
dangling Person, unknown identity UUID, native writer substitution, distinct unbound
authors, transaction rollback and generic native message/participant write protection.
The first run exposed two incorrect test expectations for replayed:false; tests now
assert the stable identity and created:false while allowing the actual replay flag.
Final source passed all four relevant suites. Full fork was already run in LOG079;
it was not repeated for this small nullable change. Source hashes match the test host.
Scoped independent source review found no confirmed blocker; reviewer ran no tests.

This does not discover/register identities or implement link/rebind/CreatePerson.
The apply proof still requires an existing ExternalIdentity UUID. Future explicit
link/unlink must preserve historical author snapshots and update current native
relations atomically; replay after a future identity mutation is not yet supported.
The existing generic participant helper does not clear a binding via null: explicit
scoped mutation is required, not redelivery. Target projection remains exclusive to
explicit domain link/unlink, never inferred from incoming participants.
ROB-764 stays In Progress. Whole CRM is unfinished. No migration changes, live demo
changes, real messaging or GitHub Actions. Skills: ai-dev-workflow,
behavioral-guardrails, server-schrodinger; read-only scoped review.

[Tests](tests.txt), [verification](verification.json), [source hashes](source-snapshot.json), [typecheck](typecheck-differential.json).

Rollback: deploy a compatible complete version; older code rejects replay of unbound messages. No schema/data rollback.
