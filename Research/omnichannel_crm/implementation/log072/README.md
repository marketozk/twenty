# LOG-072: recent onboarding and message list-fetch ownership

739 targeted Jest/7 suites +26 guards=765 PASS;
22 new PostgreSQL/caller cases. Typecheck 292 roots:
188/188,0 new/changed-code. Seven migrations unchanged.
[Tests](tests.txt), [verification](verification.json), [source hashes](source-snapshot.json),
[typecheck](typecheck-differential.json).

Atomic current-account/ordinary/enabled/stage admission precedes provider work.
Recent import requires unsynced channel, consumes its reservation once, retains
LIST_FETCH_ONGOING throughout and returns to full fetch without syncedAt. Normal
list-fetch and cursors carry run proof; stale callbacks cannot complete/schedule a
new run. Unknown outcome propagates; OAuth observes rejection. Existing importer
owns recent error classification; no new dependency-guard baseline exception.

Tests include concurrent admission, delayed full/recent caller, protected/disabled/
reparented/synced channel, empty and exact batch size, single-use handoff, crash
recovery, temporary/unknown errors, stale retry and cursor proof retention.
External providers/native aggregate boundary use explicit doubles. The exact-size
case returns no provider messages; no native deduplication claim. Review found no
scoped defect; reviewer ran no tests.

[Remaining inventory](../rob764-metadata-writer-inventory.md): calendar list-fetch,
native save/cleanup, same-account Redis side effects. No Redis/SQL atomicity claim.
Last full fork [LOG067](../log067/README.md):2205/75. ROB764 In Progress, no full server
check or complete acceptance claim. Demo unchanged, no Actions. No schema change.
Rollback requires the full affected files from one Git revision; avoid mixed old/new
callback workers. Existing stale watchdog recovers LIST_FETCH_ONGOING, and rollback
removes new guards.
