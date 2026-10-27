# LOG-054: final account lifecycle transaction

ROB-764 remains In Progress. Disconnect, transferOwnership and deleteMany now use
the strict core transaction owner: shared native fence, ordered account FOR UPDATE,
fresh persisted ownership query, then final credential/channel/account DB writes.
Native APP accounts with null app/provider IDs bypass ordinary provider callbacks.
Ordinary network hooks/revoke remain outside DB transactions; callback reentry is
tested. Transfer matches the original custodian and refuses partial/stale batches.

Delete builds fresh child/account snapshots under locks after hooks. Message and
calendar child rows are locked FOR UPDATE because a concurrent reparent checks
the new parent's FK, not the old parent's lock. Committed deletion events include
only the actual deleted child set; new children are included, moved children excluded.
Lost commit ACK emits no confirmed-success event. Ordinary events retain legacy
delivery semantics; this does not add durable event delivery to generic deletion.

## Evidence

224 targeted tests/7 suites +26 guards =250 PASS.
25 new PostgreSQL lifecycle cases run actual services and real row/advisory locks.
Both bootstrap orders, native/ordinary/legacy/mixed accounts, rollback, stale
custodian, provider-hook reentry, child reparent/create, actual calendar metadata
reparent, postcommit observer and lost ACK covered. External providers are doubles;
live OAuth, Telegram/MAX and SaleBot were not contacted.

Typecheck230 roots:197 baseline/197 current,
0new/changed-code. Full server typecheck not claimed. No schema changes; all7
migration sources and manifest unchanged. Tested/local LF hashes match. Enterprise
dependency guard passes without baseline changes. Full fork suite not rerun here;
last full1635 test run was LOG051, on its own recorded snapshot.

[Tests](tests.txt), [verification](verification.json), [typecheck](typecheck-differential.json),
[source](source-snapshot.json), [dependency guard](dependency-guard.json).

Initial6 test failures exposed fixture interception of an early read connection;
barriers/faults now target the real lifecycle transaction. Scoped independent
review identified calendar child reparent race; fixed with locked snapshot and
actual-owner interleaving tests. Final scoped re-review is recorded in verification.

## Limits and next work

Ordinary external side effects cannot be rolled back with SQL. No automatic retry
is introduced. Late webhook/status/cursor/folder callbacks and resolver pending
action still require their own final-write ownership protection; see
[inventory](../rob764-metadata-writer-inventory.md). Generic operations on already
owned accounts fail closed; domain disable/destroy API remains disabled.

Rollback uses a coordinated full Git version, not partial patches; returning old
code reopens race windows and must not serve protected active accounts. No demo
deployment or live routes changed. GitHub Actions not used.
