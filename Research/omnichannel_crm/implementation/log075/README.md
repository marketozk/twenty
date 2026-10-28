# LOG-075: guarded native cleanup and concurrent references

Provider message cleanup copies expected run before await and checks it inside the
existing strict native transaction. Group-action and no-run legacy callers remain
supported. Calendar fetch/import now use one scoped association+orphan cleanup owner;
legacy orphan wrapper reuses the in-scope implementation. Declined cleanup stops the
caller; unknown outcome propagates without final success/cache publication. Message
cursor now advances only after all cleanup chunks accepted. Prior committed chunks
remain committed; the whole provider page is not one transaction.

Read-only review found races with a concurrent second-channel reference and late
association reassignment. Candidate parent rows are locked before reference reread;
message Threads precede Messages. Child associations are locked after parents and
reread with original channel/external-ID predicates. Changed parent conflicts are
explicit. Fixed table allowlist, validated UUIDs and active lifecycle constrain the
internal lock helper. Legacy multi-page transactions can still encounter PostgreSQL
deadlocks and roll back; no claim of global cross-page ordering or deadlock freedom.

496 targeted Jest/5 suites +26 guards=522 PASS; 41 new PG/caller cases. Typecheck 295 roots:187/187,0 new/changed-code. Seven migrations unchanged.
New cases: stale parent/run/stage/ownership declines, complete cleanup, shared graph,
rollback after association deletion, real COMMIT lost ACK, wrong proof scope, both
orders of concurrent reference INSERT and channel/external-ID reassignment, actual
fetch/import callers stopping on false/unknown and bounded second-chunk refusal.
Initial failures were fixture omissions (workspace accessor/calendar handle) and the
expected ORM translation of injected PostgreSQL errors; corrected before final run.
Local/test-source LF hashes match. Independent source review; reviewer ran no tests.

Scope: ordinary Redis publication/pop/requeue and contact jobs retain legacy behavior.
They are not the new omni durable receipt/outbox. No exactly-once ordinary email or
SQL/Redis atomicity claim. Protected native writes/rematching already have ownership
barriers; delayed boundary acceptance remains to be exercised. No live demo/provider
changes, no Actions. Full server typecheck remains nonclean from prior diagnostics.

Next: exact 20-way T01 and delayed cache/postcommit ownership negatives; §15.10 minimal
metadata-only domain revision operation (initial revision exists, placeholder/edit/
delete native apply does not). Payload/files/retention expand in ROB-770. Preserve
initial receipt replay after legitimate revision; do not mark ROB764 Done until
required writers and fresh final acceptance pass. T04 real transport stays ROB-768.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only
research/review. Full fork last passed LOG074:2443/76; no new full-suite claim here.

[Tests](tests.txt), [verification](verification.json), [source hashes](source-snapshot.json), [typecheck](typecheck-differential.json).

[Remaining inventory](../rob764-metadata-writer-inventory.md). Rollback all affected files together from one Git revision; no schema changes. Rollback removes these guards; mixed worker versions are not verified.
