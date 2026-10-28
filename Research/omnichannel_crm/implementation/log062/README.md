# LOG-062: current-owner folder discovery

Fresh account/channel/folder snapshot precedes network. Exact6 timestamps, full
folder set/rows, policy and account identity (including IMAP connectionParameters)
are rechecked under ownership locks before one atomic reconciliation/readback.
Actual persisted pending actions are returned; stale null stops downstream list-fetch.
IMAP initial-sync catch propagates unknown commit. No transaction spans network.

236 targeted Jest/5 suites +26 guards=262 PASS.
35 new discovery PG tests +3 caller regressions. Typecheck 267 roots:
190/190,0 new/changed-code. Seven migrations unchanged; LF hashes matched.
Scoped review found endpoint identity gap, fixed and re-reviewed without blockers.
Minimal fixture UUID default corrected after2 initial create-path failures.

[Tests](tests.txt), [verification](verification.json), [source snapshot](source-snapshot.json),
[typecheck](typecheck-differential.json). Last full fork [LOG056](../log056/README.md),1881/71.
No new full server typecheck/full fork/full Claude review or ROB764 acceptance claim.

Initial ongoing status happens before discovery; stale response does not undo it.
Later list-fetch cache/cleanup and derived provider writers remain in
[inventory](../rob764-metadata-writer-inventory.md). Demo/transport unchanged;
GitHub Actions unused. Rollback is a full coordinated Git revision, no schema change;
old code restores stale discovery writes and synthetic pending NONE behavior.
