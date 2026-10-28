# LOG-078: incoming application result storage and parser

Added ninth additive migration: IncomingReceipt.applicationResult JSONB, nullable,
without default/backfill. SQL CHECK permits nonnull only for applied state + nonnull
canonical resultId + object/version1/incoming_text_revision/known disposition. IS TRUE
rejects missing/null gate keys instead of accepting SQL UNKNOWN. JSON null is rejected;
SQL NULL remains compatible with all old writers. Down locks receipt table and refuses
retained outcomes. Prior eight migration sources/checksums/snapshots are unchanged.
The new CHECK snapshot was generated from PostgreSQL deparse of an isolated temporary
table, then verified against the actual migrated receipt table. Version-aware capture
and message verifiers select the new snapshot only at prefix9. Older prefix tests undo
later migrations in reverse order rather than leaving an incompatible ledger suffix.

Closed runtime schema copies/freezes the flat result, validates normalized UUIDs, bounded
Unicode source key and SHA256; created has no observed head, advanced selects a different
revision, stale selects observed head, duplicate may select a previously known revision.
No implicit source-order comparison occurs. SQL does not enforce JSON revision references
or the full runtime shape: upcoming writer/replay must verify same Link/workspace and
candidate/selected/observed evidence. No application-result writer or public API is enabled.

Application result is redacted by existing audit capture. PG test proves state transition
and changed field are retained without provider revision key/content hash disclosure.
269 targeted Jest/10 suites +26 guards=295 PASS; 50 new cases. Typecheck 303 roots:187/187,0 new/changed-code. Nine migration sources verified; first eight unchanged.
Independent source review found no confirmed blocker; reviewer ran no tests. Typecheck found a UUID template-literal assignment only in the new test. It was rewritten without changing runtime code, its 26 unit cases rerun, and the final differential typecheck passed. Broad-suite and final-source hashes are separately retained; only that test file differs. No full-suite
rerun in this slice. Prior LOG077 full2508/77 precedes its final history readback, whose
final188/6 targeted verification is retained there. No new full-server typecheck claim.

Next: common incoming storage core plus qualified revision branch, preserving legacy
history entrypoint IDs and audit. Placeholder/delete-before-create use one canonical
Message; fill/edit/delete update exact ID under same transaction with head/revision/
receipt outcome/audit. Duplicate/stale write receipt-only outcome, no fake event/counters.
Replay checks retained outcome after current authorization and separately verifies current
native head; it does not reclassify old input against today's head. Incomparable/conflict
must quarantine safely after confirmed rollback; unknown COMMIT stays unknown. Automation
remains suppressed v0. ROB-764 In Progress, UI/transport/ACL/AI tasks remain pending.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.
No live demo/provider changes; no GitHub Actions.

[Broad tests](tests.txt), [final unit tests](final-unit-tests.txt), [broad source hashes](broad-suite-source-hashes.json), [verification](verification.json), [source hashes](source-snapshot.json), [typecheck](typecheck-differential.json).

Rollback: no automatic populated schema rollback; new down refuses retained outcomes. Deploy whole verified code versions, preserve prior migration ledger.
