# LOG-055: webhook final write ownership

ROB-764 remains In Progress. Webhook claim, settle, clear and status writes run
inside strict fresh core transactions with shared native fence, ordered parent
locks, channel FOR UPDATE, and full fresh account ownership checks. Native APP
without app/provider IDs is refused, including unbound accounts; retained legacy
bindings and derived ownership use the same full query. Message and calendar
callbacks pass workspace and captured account ID. Reparent during acquisition
or mismatch against the original snapshot returns an explicit declined result.
SQL/ownership errors propagate. Previous claim/client-state/subscription CAS stays.

HTTP remains outside SQL. Renew/delete commit errors no longer enter provider
recovery: lost commit acknowledgement emits no success/provider-failure metric,
no second FAILED write and no automatic retry. Existing create orphan cleanup
remains unchanged. Remote effects cannot be undone by a local SQL refusal.

## Evidence

278 targeted Jest tests/6 suites +26 guards=304 PASS.
85 new PG cases cover ordinary/native/legacy, isolation, ownership read failure,
claim concurrency/CAS, parent-lock race, actual provider caller late response,
ordinary reparent before claim/after HTTP, and actual commit ACK loss. Only network
and unrelated DI dependencies are doubles. No live providers were contacted.

Typecheck236 roots: 197 baseline/197 current,0 new/changed-code.
All7 migrations unchanged; local/test LF hashes match; dependency guard unchanged.
Full server typecheck/full fork suite not rerun; last full run was LOG051's snapshot.
Scoped independent review found two bugs (parent pin and unknown commit handling);
both fixed and regression tested; final scoped review found no blockers.
Initial fixture load failed on AI ESM via driver factory; isolated factory mock
fixes the test boundary without mocking the status/provider orchestration owners.

[Tests](tests.txt), [verification](verification.json), [typecheck](typecheck-differential.json),
[source snapshot](source-snapshot.json), [dependency guard](dependency-guard.json).

## Remaining

[Sync/cursor/folder writers and resolver atomicity](../rob764-metadata-writer-inventory.md),
then final T22 and fresh ROB764 acceptance. No public API/ACL/UI/transport activation.
No demo deployment, SaleBot change or GitHub Actions. Rollback uses a coordinated
full Git version; old code reopens ownership races and must not serve protected
active accounts.
