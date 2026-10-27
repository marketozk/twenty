# LOG-060: group-email destructive batches

Current action snapshot captures parent, settings, action and exact6 PostgreSQL timestamp.
Each cleaner batch holds shared ownership fence and account/channel locks in the same
strict native transaction as deletion. Stale stops subsequent chunks and list-fetch.
Finalizer rechecks the snapshot and atomically resets allowed folders, channel cursor
and pending action. Native unknown commit bypasses ordinary import-failure handling.

189 targeted Jest/5 suites +26 guards=215 PASS,22 new PG cases.
Typecheck 259 roots:191/190,0 new/changed-code.
7 migration sources unchanged; hashes matched. Scoped read-only review no blockers.
Tests include microsecond ABA,201-message interruption, shared/exclusive ownership
serialization, rollback, actual worker/cleaner and lost ACK propagation. Initial test
fixture errors corrected (pool injection timing, native unique constraint, explicit types).

[Tests](tests.txt), [verification](verification.json), [source hashes](source-snapshot.json),
[typecheck](typecheck-differential.json). Last full fork [LOG056](../log056/README.md),1881/71.
No new full fork/full server typecheck/full Claude review/ROB764 acceptance claimed.

Each chunk and finalizer is atomic separately. Previously committed chunks survive
later stale/error. Other cleaner call sites still lack action snapshots; folder cleanup
and discovery remain in [inventory](../rob764-metadata-writer-inventory.md). No demo,
transport activation or GitHub Actions. Rollback is a full coordinated Git revision;
no schema migration required, older code restores the group-action lifecycle gap.
