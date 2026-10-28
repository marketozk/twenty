# LOG-071: direct import admission and run status callbacks

717 targeted Jest/7 suites +26 guards=743 PASS;
58 new PostgreSQL/caller cases. Typecheck 292 roots:
188/188,0 new/changed-code. Seven migrations unchanged.
[Tests](tests.txt), [verification](verification.json), [source hashes](source-snapshot.json),
[typecheck](typecheck-differential.json).

Ordinary/current account/enabled/SCHEDULED admission under existing locks loads fresh
channel/account/folders and assigns exact DB run token. Both importers pass proof to
completion, retry/failure and legacy reset. Optional proofs are copied before awaits,
real tokens frozen. Unknown commit stops admission/fallback; message native unknown
no longer requeues IDs. SQL/provider/caches boundaries tested with explicit doubles;
no live provider or Redis atomicity claim. Review token-copy finding fixed and tested.

[Remaining inventory](../rob764-metadata-writer-inventory.md): scheduling producers/
onboarding, cursor/native result writes, same-account Redis side effects. A stale
message error can still requeue its IDs and emit monitoring; guarded DB update does
not erase this limitation. Last full fork [LOG067](../log067/README.md):2205/75.
ROB764 In Progress. No full server typecheck or full acceptance claim. Demo unchanged,
no Actions. No schema change. Rollback all affected files from one Git revision;
in-progress jobs can be recovered by existing stale-stage watchdog, but rollback
removes the new guards. Do not mix old/new callback workers as a verified deployment.
