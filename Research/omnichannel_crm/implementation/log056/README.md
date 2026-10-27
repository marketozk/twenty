# LOG-056: atomic ordinary sync-status batches

The batch owner snapshots IDs, takes the shared native fence, all sorted account
locks before sorted channel locks, and filters fresh full ownership/native APP or
reparented rows. Auth failure uses account UPDATE locks immediately. Channel/folder
reset and channel/account auth failure are atomic. Scoped folder repository uses
the same manager, with explicit locked folder ownership exclusion.

Cache/broadcast/metrics/reconnect effects use only committed actual IDs and captured
account/recipient snapshots. Conditional scheduling retains pending/enabled CAS.
Microsoft reconnect resets now run after persistence commit with channel IDs.
Credential failure pins the captured parent. Unknown local COMMIT is rethrown by
import handlers and messaging catch before cache replay or false FAILED writes.

## Evidence

332 affected Jest tests/7 suites PASS.
Full fork: 1881 tests/71 suites +26 guard/checksum=1907 PASS.
66 new PG cases include actual import owners with lost commit ACK, actual stale
credential handlers, mixed/legacy/derived/native ownership, reversed concurrent
batches, post-channel SQL failure rollback, folder reset rollback, conditional CAS,
input snapshots and denied ownership reads.7 legacy reset mocks retired in favor
of PostgreSQL coverage. Actual Microsoft caller observes committed data and IDs.
Typecheck242 roots:197 baseline/191 current,0 new/changed-code.
All7 migrations unchanged; dependency guard passes; tested/local LF hashes match.

[Full tests](full-tests.txt), [affected tests](tests.txt), [verification](verification.json),
[typecheck](typecheck-differential.json), [source](source-snapshot.json).
Initial fixture/import/type issues were corrected. Independent scoped review found
unknown-COMMIT recovery and stale authFailure parent; both fixed and tested, final
scoped review no blockers. No full server typecheck/full Claude pass claimed.

## Remaining boundary

ROB764 stays In Progress. [Inventory](../rob764-metadata-writer-inventory.md) retains
group/resolver/cursor/throttle/folder writers and final acceptance. Generic ordinary
callbacks outside this slice are not all snapshot-pinned; no remote side effect
becomes SQL-atomic. No public runtime activation, demo change or GitHub Actions.
Rollback is a coordinated full Git version; old code reopens ownership races.
