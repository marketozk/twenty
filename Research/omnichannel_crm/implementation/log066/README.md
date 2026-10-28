# LOG-066: guarded scheduling, import jobs and stale recovery

434 targeted Jest/6 suites +26 guards=460 PASS.
46 new PostgreSQL cases:24 scheduler,10 watchdog,12 import-job admission.
Typecheck 278 roots:191/189,0 new/changed-code;
7 migrations unchanged. [Tests](tests.txt), [verification](verification.json),
[source hashes](source-snapshot.json), [typecheck](typecheck-differential.json).

Three cron writers/calendar CLI: ordinary owner, current enabled/pending, accepted
ID/account enqueue after commit. Two import jobs: current expected parent, stage
and enabled. Two watchdogs: current timestamp/stage under owner, postcommit broadcast.
Independent review found UPDATE result-shape defect; CTE SELECT fixes it, tests rerun.
Final reread no other blockers; reviewer did not execute tests. Dependency guard
rejected two new barrel edges; explicit null/undefined in pure stale helpers removed
them without changing the guard baseline or stale behavior.

SQL/queue are not atomic. Known commit followed by queue failure leaves scheduled
rows for stale recovery; unknown commit does not enqueue or broadcast. Existing
throttle/webhook candidate filtering is not newly guarded at final SQL. Legacy
message-list cron/CLI payloads remain unpinned. Member reset, direct importer and
onboarding, response apply remain in [inventory](../rob764-metadata-writer-inventory.md).
Last full fork [LOG056](../log056/README.md),1881/71. ROB764 remains In Progress;
no full server typecheck, full Claude review, live demo change or GitHub Actions.
Rollback: complete matched Git source revision for helper and callers/jobs;
no schema migration. Recover scheduled rows using existing stale recovery.
