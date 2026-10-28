# LOG-065: account-scoped message import cache

Validated v2 workspace/channel/account keys across all five runtime owners. Captured
account for postcommit clear/broadcast and error requeue; current ordinary progress.
Legacy backlog requires guarded cursor reset/refetch, preserving pending actions,
then deletion only after known commit. Old cleanup payloads touch legacy keys only.
Unified7-day TTL; no Redis/SQL atomicity or same-account request isolation claim.

388 targeted Jest/6 suites +26 guards=414 PASS;
16 new cases (13 SQL/caller boundaries,3 key/cleanup cases; controlled cache double).
Typecheck 269 roots:190/189,0 new/changed-code;7 migrations unchanged.
Scoped review no new blockers. Initial nonexistent TTL export fixed and rerun.
[Tests](tests.txt), [verification](verification.json), [source snapshot](source-snapshot.json),
[typecheck](typecheck-differential.json). Last full fork [LOG056](../log056/README.md),1881/71.

Recovery only detects surviving legacy keys. Already lost Redis queues are outside
this guarantee. Import/onboarding admission and downstream response application
remain in [inventory](../rob764-metadata-writer-inventory.md). No full fork/full server
typecheck/full Claude review/ROB764 completion claimed; demo unchanged, no Actions.
Rollback must coordinate every producer/consumer from one Git revision and reset/
refetch affected ordinary channels; old workers must not read/adopt v2 as legacy.
There is no schema change. Do not mix old and new cache owners in deployment.
