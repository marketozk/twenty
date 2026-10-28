# LOG-061: folder actions and strict Gmail selection

Actual worker captures current parent/action/version/hierarchy. Native deletion pages
perform cleaner and junction writes in the same transaction after fresh ownership
and action checks. Exclusive deletion finalizer rejects remaining junctions; import
finalizer validates full hierarchy and releases fetched IDs only after known commit.
Strict Gmail selection requires a complete label and cannot fall back to all folders.

226 targeted Jest/6 suites +13 Gmail/2 suites +26 guards=265 PASS.
37 new PG cases;14 obsolete orchestration mock cases retired. Typecheck
265 roots:190/190,0 new/changed-code.
7 migration sources unchanged; LF hashes matched including deleted-test absence.
Two Gmail review findings fixed; read-only re-review no confirmed blockers.

[Tests](tests.txt), [Gmail regressions](gmail-regression.txt), [verification](verification.json),
[source hashes](source-snapshot.json), [typecheck](typecheck-differential.json).
Last full fork [LOG056](../log056/README.md),1881/71. No new full fork, full server
typecheck, full Claude review or ROB764 acceptance claimed.

Each page and finalizer is atomic separately. Earlier committed pages survive later
stale/error. Legacy three-argument deletion behavior remains; production worker uses
the guarded token. Sync-folder discovery and downstream cache lifecycle remain in
[inventory](../rob764-metadata-writer-inventory.md). No demo/transport activation or
GitHub Actions. Rollback requires a coordinated full Git revision; no schema migration.
Older code restores the folder lifecycle race and weaker Gmail action selection.
