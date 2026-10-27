# LOG-057: cursor ownership and atomic settings

Messaging cursor writes use the existing shared fence and ordered parent/channel
locks, captured parent, and fresh full ownership. Numeric channel cursors compare
with current DB state. Folder writes lock/check the exact parent and full ownership;
folder cursor and channel throttle/stage reset share one transaction.

Resolver settings and derived pending group action now use one metadata UPDATE.
Fresh parent/type/busy state and current account administration are checked while
locked. Existing EMAIL_GROUP/configuration/unchanged-value semantics are preserved.
The obsolete standalone marker was removed. Review found a same-ID account owner
change; final authorization and negative PostgreSQL tests fixed it. Re-review clear.

## Verification

203 affected Jest tests/6 suites +26 guard/checksum tests=229 PASS.
22 new PG cases include current cursor, ordinary/bound/unbound ownership, reparent,
foreign/missing folder, write rollback, busy state, group/configuration, same-account
custodian/scope change, and atomic setting/action rollback.
Typecheck 247 roots: 191/191, 0 new/changed-code. One existing diagnostic
in an unchanged worker method remains. Dependency guard PASS after removing an
unneeded type import; 7 migration sources unchanged. Local/tested LF hashes match.

[Tests](tests.txt), [verification](verification.json), [typecheck](typecheck-differential.json),
[source snapshot](source-snapshot.json). Last full fork: [LOG056](../log056/README.md),
1881 tests/71 suites; not repeated here. No full server typecheck or full Claude pass.

## Remaining boundary

ROB764 stays In Progress. [Inventory](../rob764-metadata-writer-inventory.md) retains
group cleanup, throttle/relaunch/CLI/folder owners and final acceptance. Existing
administration check is reused; role mutation fencing and own ACL remain ROB766.
No public API activation, transport, demo changes or GitHub Actions. Rollback uses
a coordinated full Git version; older code reopens these ownership/atomicity races.
