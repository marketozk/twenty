# LOG-069: calendar cache account namespace and legacy refetch

587 targeted Jest/7 suites +26 guards=613 PASS.
19 new cases:18 SQL/caller boundaries,1 pure-key case.
Typecheck 291 roots:189/188,0 new/changed-code;
7 migrations unchanged. [Tests](tests.txt), [verification](verification.json),
[source hashes](source-snapshot.json), [typecheck](typecheck-differential.json).

Four cache owners use validated captured account key. Legacy backlog resets/refetches
before fetch/import; declined owner stops, unknown commit does not delete old keys.
Postcommit clear uses accepted account. Cursor/notfound/unknown error branches pin
parent. TTL behavior preserved. Actual SQL/services with explicit provider/cache
doubles; initial CalDAV ESM loading isolated at provider boundary and rerun passed.
Scoped review no blockers, no tests run by reviewer.

No Redis/SQL atomicity, same-account run isolation or recovery of already lost legacy
queues. Remaining [inventory](../rob764-metadata-writer-inventory.md): MS lifecycle,
import/onboarding admission, successful provider status/cursor/native writes.
Last full fork [LOG067](../log067/README.md):2205/75. No full server typecheck or
ROB764 completion. Demo unchanged, no Actions. Rollback all producers/consumers
from matched Git revision and refetch affected channels; do not mix v1/v2 workers.
No schema migration. Never assign old v1 event IDs to a new account namespace.
