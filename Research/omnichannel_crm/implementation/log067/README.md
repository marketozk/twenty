# LOG-067: scheduled account and member reset provenance

2205 full fork Jest/75 suites +26 guards=2231 PASS.
28 new PG cases; earlier targeted462/6. Final full run covers final sources.
Typecheck 282 roots:189/189,0 new/changed-code;
7 migrations unchanged. [Tests](tests.txt), [verification](verification.json),
[source hashes](source-snapshot.json), [typecheck](typecheck-differential.json).

Internal scheduler descriptors retained by every message-list consumer. Cron/CLI
queue accepted parent; webhook rechecks ordinary parent/enabled/stage before provider.
Member blocklist reset passes captured account+custodian to existing locked owner;
global scope supersedes member processing. Actual PostgreSQL tests, controlled
WorkspaceMember lookup and provider/cache doubles. Unknown commit stops follow-on.

Per-account member batches are not globally atomic; earlier commits survive later
failure. SQL/queue not atomic. Remaining calendar webhook/direct admission/native
response apply in [inventory](../rob764-metadata-writer-inventory.md).
Scoped read-only review no blockers, no tests executed by reviewer. No full server
typecheck/full Claude review or ROB764 completion. Demo unchanged, no Actions.
Rollback scheduler wrapper and all callers together from one Git revision; old
job payloads remain supported by worker current-owner admission. No schema change.
