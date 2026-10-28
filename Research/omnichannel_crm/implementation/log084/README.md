# LOG-084: explicit native Person creation

Internal createPersonForOmniIdentity reuses the strict identity mutation owner and
same-transaction primitive. A discriminated internal request keeps existing set/link/
unlink behavior and its payload/action hash unchanged. Creation has a distinct action,
closed structured name allowlist, expected identity revision and actor-scoped key.
Current authorization, retained receipt check, CAS and unbound identity check happen
before native insertion. Person ID is server-generated inside the transaction.

Native Person insert uses the issued workspace scope with explicit event suppression;
the messaging wrapper alone does not suppress Person events. Existing native field
conversion/validation is reused. No contact job, automatic email/phone/handle matching,
or new target projection. Prior native FROM participants are bound while birth author
snapshots remain unchanged. Person/participants/identity/epoch/audit/receipt commit
atomically, with initial and final Person-name readback. Catalog adds omniPerson (22
resource kinds); personal name appears only in redacted changedFields, not audit values.

Replay after current authorization checks original identity transition/policy proof
and native Person creation audit, returns the original Person ID and never creates or
rebinds again. It does not overwrite subsequent legitimate Person edits. Already bound
identity with a new command fails. Native transaction unknown outcomes do not become
false failed audits. Ordinary upstream record-stock acquisition remains after-commit;
callback failure is logged and does not turn committed creation into failure. This is
not a new exactly-once stock/quota mechanism.

129 tests/5 suites +26 guards =155 PASS;22 new PG cases. Differential typecheck 317 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
22 new PostgreSQL cases cover first-message and existing-history creation, redaction,
twenty retries, competing keys, already-bound identity, payload/action conflict, current
permission/revocation, all six write-stage failures, real COMMIT acknowledgement loss,
missing creation audit, nested caller mutation, forbidden fields/empty name/foreign
workspace, late name corruption, unchanged later Person edits and stock callback failure.
The five-suite run includes old identity/target/history and native audit transaction
regressions. A first differential typecheck found four errors in union callback rest
argument typing; explicit tuple parameter types fixed them before the final test/type run.
No new/changed-code diagnostics;187 baseline diagnostics remain. Source LF hashes match.

Scoped read-only source review found no confirmed blocker. A separate normative check
confirmed that audit does NOT replace the required visible/governed Person-created
notification from sending-ui. That integration is explicitly open in ROB-769 producer
inventory and phase5, with activation prohibited until coverage is implemented. This
slice provides atomic internal storage; it does not claim event/automation readiness.
Public ACL/API remains ROB-766. Live autoCreatePerson is still disabled/unimplemented;
it is next within phase1, and history/restore must never auto-create.

No schema/migration change. Last full fork regression LOG082:2661/83; this slice uses
five relevant suites. ROB-764 remains In Progress and the whole CRM is unfinished.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.
No live demo, actual external messaging, route activation or GitHub Actions changes.

[Tests](tests.txt), [verification](verification.json), [source hashes](source-snapshot.json), [typecheck](typecheck-differential.json).

Rollback: use a compatible complete version preserving Person records, creation audits, identity history and receipts. Do not replay committed creation as a new command. No automatic schema/data rollback.
