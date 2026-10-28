# LOG-070: Microsoft subscription lifecycle snapshot CAS

659 targeted Jest/7 suites +26 guards=685 PASS.
72 new PostgreSQL/caller cases. Typecheck 291 roots:
188/188,0 new/changed-code. Seven migrations unchanged.
[Tests](tests.txt), [verification](verification.json), [source hashes](source-snapshot.json),
[typecheck](typecheck-differential.json).

Authenticated event identity is retained across renew/recreate/recovery. Locked
ordinary metadata owner compares account/externalId/clientState/status/expiry.
Creation failure pins its new PENDING claim; clear/reset advances expected state.
Unknown commit from OAuth/local mutation stops failure writes and follow-on creation.
Actual SQL/services/handlers with explicit provider and notification read doubles;
no live Microsoft, real transport or remote fencing claim.

Review found expiry and OAuth unknown-commit cases; fixed and rereviewed. Dependency
helper is structural and pure; baseline unchanged. Previous full fork
[LOG067](../log067/README.md):2205/75. Remaining [inventory](../rob764-metadata-writer-inventory.md):
direct import/onboarding, exact run tokens, successful provider/native apply.
ROB764 In Progress. Full server typecheck not passed/claimed; demo unchanged,
no Actions. No schema migration. Rollback uses all affected files from one Git
revision; existing subscriptions remain readable, but rollback loses these guards.
