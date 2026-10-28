# LOG-076: duplicate and delayed ownership acceptance

Acceptance-only changes: ingress concurrency increased from 6 to 20; a fresh
history fixture accepts 20 identical events then applies the claimed receipt 20 times.
Exactly one creation, 19 replays, one receipt/message/link/native graph and ten success
audit entries remain. No duplicate generic events or replacement Thread.

Actual message/calendar importer is delayed after admission at cache pop. Real account
bootstrap establishes derived omni ownership; provider label is reset to ordinary to
exercise derived protection. On resume a pass-through spy proves actual native aggregate
was reached; native/core snapshots, raw events, completion/pending/contact/rematch/requeue
remain unchanged. Admission/status/legacy recovery and external providers are test doubles;
this is not an end-to-end scheduler test or proof of SQL/Redis atomicity.

Participant snapshot is captured before Conversation ownership. Actual matcher and target
reconciliation run after ownership; protected participants/targets/messages remain unchanged,
while ordinary email positive control matches and creates its three targets. This is not a
full contact creation job / Person listener pipeline test.

170 targeted Jest/4 suites +26 guards=196 PASS; 4 new PG cases. Typecheck 295 roots:187/187,0 new/changed-code. Seven migrations unchanged.
First importer suite load hit an ESM dependency via injected constructors; narrow constructor
mocks keep real importers/native aggregate/ORM guards. Initial message fixture was filtered
as internal email (same domain); corrected external sender and added aggregate reachability
assertion. Independent source review found no confirmed defect; reviewer ran no tests.

No runtime implementation changes, no live demo/provider changes, no Actions. Previous full
fork LOG074:2443/76, no newer full-suite claim. Baseline server diagnostics remain unresolved.
Next: §15.10 metadata-only domain revisions: placeholder fill/edit/delete, trusted source
ordering, atomic native body/head/revision/receipt/audit, initial receipt replay after edits.
ROB-764 remains In Progress until that required writer and fresh final acceptance pass.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.

[Tests](tests.txt), [verification](verification.json), [source hashes](source-snapshot.json), [typecheck](typecheck-differential.json).

Test-only change; no runtime/schema rollback required.
