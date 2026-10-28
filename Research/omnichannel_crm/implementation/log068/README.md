# LOG-068: notification dispatch and calendar webhook orchestration

568 targeted Jest/7 suites +26 guards=594 PASS.
21 new cases:17 PostgreSQL admission/orchestration,4 enqueue/dedup contract doubles.
Typecheck 290 roots:189/189,0 new/changed-code;
7 migrations unchanged. [Tests](tests.txt), [verification](verification.json),
[source hashes](source-snapshot.json), [typecheck](typecheck-differential.json).

Eight handler calls carry account; first scheduling rejects stale parent before
UPDATE. Qualified queue keys isolate accounts, legacy body/key preserved. Calendar
fresh scheduled read, captured parent through fetch, conditional inline import only
from IMPORT_PENDING, fresh second read. Unknown commits stop follow-on provider.
Scoped review no blockers, reviewer did not execute tests. Actual fetch/import and
queue execution are doubles; tests prove orchestration, not provider/native internals.

Remaining [inventory](../rob764-metadata-writer-inventory.md): calendar cache and
provider callbacks, MS renew/recreate account/subscription pins, direct import/
onboarding, same-account run isolation and native SQL apply. Last full fork
[LOG067](../log067/README.md):2205/75. No full server typecheck or ROB764 completion.
Demo unchanged; no Actions. Rollback all producer/consumer/helper files from one
Git revision; old payloads stay compatible. No schema migration. Existing dedup
entries have their normal queue lifetime; account-qualified entries are separate.
