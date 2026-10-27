# LOG-058: atomic temporary failures, completion and scheduling

Temporary failure uses captured parent and fresh locked throttle count. Threshold,
retryAfter and next/failed stage share one update. Existing threshold and stage-start
semantics remain. Postcommit effects apply only to accepted ordinary channels.
Message import pending/reset is atomic; last/empty completion pins captured parent.
Relaunch has current FAILED/FAILED_UNKNOWN CAS. CLI shares the scheduling operation
with status service and queues only returned committed IDs.

## Evidence

279 affected Jest tests/6 suites +26 guard/checksum tests=305 PASS.
24 added PG cases exercise actual handlers, concurrent threshold, native and stale
parents, rollback/unknown commit, relaunch, CLI admission and zero-list fetch.
Initial276/278 exposed TypeORM raw UPDATE returning [rows,count]; a data-modifying
CTE SELECT now returns actual IDs. Review found the last zero-list completion
callsite without parent pin; fixed, actual service regression and re-review clear.

Typecheck 252 roots:191/191,0 new/changed-code.7 migrations unchanged.
Guard passed after removing2 unnecessary dependency edges without baseline changes.
[Tests](tests.txt), [verification](verification.json), [typecheck](typecheck-differential.json),
[source hashes](source-snapshot.json). Last full fork: [LOG056](../log056/README.md),1881/71.
No new full suite, full server typecheck or full Claude review claimed.

## Boundary

ROB764 remains In Progress. [Inventory](../rob764-metadata-writer-inventory.md) retains
group/folder writers, destructive native batches and provider derived-ownership
predicate. Legacy list-fetch has an intermediate cache clear before final completion;
the actual-service regression explicitly retains that1 clear while blocking stale
completion/metrics. This slice does not make downstream cache/cleanup SQL-atomic.
No demo change, public runtime activation, transport or GitHub Actions. Rollback is
a coordinated full Git version; older code reopens these metadata ownership gaps.
