# LOG-064: reconnect scheduling and job admission

Atomic reset→SCHEDULED, captured parent, current enabled/setup state, accepted IDs.
Google/MS/IMAP enqueue only accepted channels with expected account. Message/calendar
jobs reread current channel under complete ordinary ownership before provider work.
Unknown commit stops follow-on effects. Existing pending-reset callers preserved.

372 targeted Jest/6 suites +26 guards=398 PASS,
30 new PG cases. Typecheck 269 roots:190/190,0 new/changed-code.
7 migrations unchanged; LF source hashes matched. Scoped review no confirmed blockers.
[Tests](tests.txt), [verification](verification.json), [source snapshot](source-snapshot.json),
[typecheck](typecheck-differential.json). Last full fork [LOG056](../log056/README.md),1881/71.

Job admission snapshot does not hold locks across network/cache. Account-scoped cache,
import-cron owner and downstream response cleanup remain in
[inventory](../rob764-metadata-writer-inventory.md). No cross-store atomicity claim.
Initial fixture/mock/tuple/type errors corrected and rerun. No full fork/full server
typecheck/full Claude pass or ROB764 completion claimed. Demo unchanged; no Actions.
Rollback uses coordinated full Git revision, no schema change; old code restores
stale reconnect reset and PENDING/SCHEDULED inconsistency.
