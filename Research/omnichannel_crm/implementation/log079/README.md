# LOG-079: qualified incoming text revision persistence

Common incoming persistence preserves the legacy history entrypoint, deterministic IDs
and audit conventions. A new internal apply/process facade requires current authorization
and a captured trusted revision adapter. Adapter identity/version must match retained
capture; source positions are opaque to the domain (no timestamp/lexical/numeric guess).
A versioned namespaced key binds qualification to logical revision identity. Semantic
content hash covers canonical key, text, tombstone and completeness; immutable author
and display timestamp are retained from the initial Link.

Initial received/placeholder/edit/delete may create one canonical Message, including a
new Conversation. Exact native text update uses the existing scoped ORM and capability;
head/revision/receipt outcome/audit share the strict transaction. Tombstone clears text,
not native deletedAt. Complete-to-placeholder regression and newer resurrection after
tombstone are rejected. Duplicate or older observations persist a receipt-only outcome,
without another Message/Revision/event/counter. Replay returns retained disposition after
current authorization and evidence checks; it never reclassifies against a later head.
Legacy NULL heads are read-only on replay and transition only within a real new revision.

Retained proof verifies scoped chain, source receipt/envelope/capture/hash, known legacy
or new revision namespace, selected/observed references, initial identity/display and
current native content. Retained success audit and event/root/dispatch evidence are checked.
Batched receipt evidence explicitly preserves bigint routeGeneration as text, including
values above JavaScript safe integer. Final readback after audit and receipt CAS validates
immutable receipt fields, cleared lease/error, current head and native graph. New/legacy
initial replay after edits/deletes does not restore old body. v0 roots remain suppressed.
The chain currently checks retained metadata linearly; large-history load/retention tuning
remains a measured integration concern, not a claim of bounded history cost.

Issued source conflicts can move a receipt to quarantine only after confirmed rollback
and successful failure-audit handling; denied authorization and unknown COMMIT/ROLLBACK
are propagated without that mutation. Missing initial configuration uses blocked_config.
The actual native Message search configuration indexes subject, not body; unchanged NULL
subject does not need an extra body reindex job. Current text remains in native Message.
Files/protected historical payload and real adapter semantics are not implemented here.

Full fork 2598 tests/80 suites +26 guards=2624 PASS; 38 new PG cases. Differential typecheck 307 roots:187/187,0 new/changed-code. Nine migration sources unchanged.
38 new PG cases cover initial/edit/delete, placeholder fill existing/new Conversation,
delete-before-create, immutable author/time, stable duplicate/stale replay, 20 concurrent
writers, different ordered edits, confirmed rollback, real lost COMMIT ACK, unconfirmed
rollback, slow-audit lease expiry, late head/outcome/native corruption, retained evidence
and event/root/dispatch corruption, caller snapshot, and large generation precision.
Scoped independent source review found no confirmed blocker; reviewers ran no tests.
Full suite ran on final source after correcting test-only type annotations and removing
a new type import which introduced a forbidden dependency edge. Guard rules/baseline
were not relaxed. Differential typecheck retains 187 baseline diagnostics; no claim that
the entire server is type-clean. All nine committed migrations remain unchanged.

No public API, real transport, production route or automation activation. Synthetic
adapter comparison in tests is not Telegram/MAX ordering qualification. Existing ordinary
email/cache/contact behavior stays within LOG076 boundaries. Acceptance reconciliation found remaining ROB-764 gaps: unbound identity apply and
early explicit identity/target mutation/projection rollback checks. Current proof still
requires an existing bound Person. These are not closed by the new revision tests.
Projection belongs solely to explicit domain link/unlink, not opportunistic ingress
repair. Implement internal scoped writers with current authorization first; public
policy/API remains ROB-766. ROB-764 stays In Progress; whole CRM is unfinished.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; read-only scoped review.
No live demo changes and no GitHub Actions.

[Full tests](tests.txt), [verification](verification.json), [source hashes](source-snapshot.json), [typecheck](typecheck-differential.json).

Rollback: once new outcomes/revisions exist, deploy a compatible complete version; older history-only code cannot replay edited heads. No automatic data/schema rollback.
