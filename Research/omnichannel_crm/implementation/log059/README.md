# LOG-059: folder metadata owner

Generic folder create/update/sync/delete use one fresh transaction with account →
channel → folder lock order, current owner and parent validation. Resolver propagates
caller for final custodian check. Native/bound/retained/derived folder ownership is
protected; mixed batches reject all. Google backfill semantics retained. Scope/relation
replacement denied. All writes and readback share manager; unknown commit is an error.

226 targeted Jest/5 suites +26 guards = 252 PASS.
30 new PostgreSQL cases cover normal CRUD, protected/mixed rows, parent and custodian
races, bootstrap after discovery, retained junction, provider semantics, concurrency,
rollback and unknown commit. Typecheck 256 roots: 191/191,0 new/changed-code.
7 migration sources unchanged. Scoped read-only review found no confirmed blocker.

[Tests](tests.txt), [verification](verification.json), [source hashes](source-snapshot.json),
[typecheck](typecheck-differential.json). Full fork last [LOG056](../log056/README.md),1881/71.
No new full fork, full server typecheck, full Claude review or ROB764 acceptance claimed.

Background group/folder cleanup, native destructive transaction callbacks and provider
predicate remain in [inventory](../rob764-metadata-writer-inventory.md). No demo/runtime
activation or GitHub Actions. Rollback uses a coordinated full Git revision; older
code restores the folder ownership gap. Schema migration is not required.
