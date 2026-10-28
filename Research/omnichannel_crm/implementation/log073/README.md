# LOG-073: calendar fetch admission and atomic cursor/status finalization

756 targeted Jest/7 suites +26 guards=782 PASS;
17 new PostgreSQL/caller cases. Typecheck 292 roots:
188/188,0 new/changed-code. Seven migrations unchanged.
[Tests](tests.txt), [verification](verification.json), [source hashes](source-snapshot.json),
[typecheck](typecheck-differential.json).

Atomic current-owner/enabled/SCHEDULED admission loads fresh channel/account before
cache/provider. Exact run proof guards legacy/error paths and final cursor+status
UPDATE. A failed transaction cannot advance only the cursor; an unknown commit
propagates without fallback/success metrics. Webhook skips inline import if fetch
was declined. Scoped read-only review; reviewer ran no tests.

Provider/native/cache boundaries use explicit doubles in focused tests. No native
aggregate or cleanup protection claim from metadata admission alone. [Remaining
inventory](../rob764-metadata-writer-inventory.md): native result apply/cleanup,
same-account Redis effects. Last full fork [LOG067](../log067/README.md):2205/75.
ROB764 In Progress. No full server check/full acceptance claim. Demo unchanged,
no Actions or schema changes. Rollback all affected files together from one Git
revision; mixed callback workers are not a verified deployment. Rollback removes
these guards; existing stale watchdog handles unfinished list fetch.
