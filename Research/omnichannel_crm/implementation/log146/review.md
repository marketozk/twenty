# LOG146 independent implementation review

Parent follow-up: both recommended generated CalendarEventTarget tests were added and passed. The physical field exists in build-standard-target-flat-field-metadatas.util.ts; no invented metadata was used. The negative case proves a real generated ON UPDATE cascade in a separate transaction, rolls that probe back, then checks the audited refusal and unchanged graph/child.

Initial targeted run: 2 failed, 83 passed because a test query spy wrapped an already spied pooled connection on the next page. The hook now restores its query spy in finally after each observed transaction. The initial failure is retained; production was not weakened. The old reconciliation fixture now forwards transaction options, includes Association/CallRecording and grants core.workspace UPDATE; its previous messaging FK actions are unchanged. Corrected focused run passed 104 cases; final generated-inclusive run passed 106 cases in four suites (40.19s).

Differential types: 425/427 roots, 225/225 baseline/current diagnostics, no new/changed-file diagnostics. Dependency guard and 26 guard unit tests passed, 10 migration checksums unchanged. Broad regression and publication are recorded separately after completion; no full-server or deployment claim.

Scope: read-only review of the current LOG146 source and test changes. No application writes, runtime tests, dependency guard, or heavy checks were executed by this reviewer. Root owns runtime verification. This report records source inspection, not acceptance-test success.

## Result

No concrete production blocker identified in the inspected implementation. One meaningful acceptance coverage gap is listed below. The legacy messaging lane remains outside the new calendar audit boundary, explicitly and deliberately.

## Files inspected

- `packages/twenty-server/src/modules/match-participant/participant-target-reconciliation.service.ts`
- `packages/twenty-server/src/modules/match-participant/match-participant.service.ts`
- `packages/twenty-server/src/modules/match-participant/jobs/reconcile-person-company-targets.job.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/calendar-target-proof.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`
- `packages/twenty-server/test/fork-migration/calendar-import-matching-audit.postgres-spec.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-calendar-target-enrichment-entrypoints.spec.ts`
- `Research/omnichannel_crm/implementation/log145/next-boundary.md`

## Confirmed source properties

1. `reconcileTargetsForPeople` captures the full audit operation and validates workspace/selector identity before entering the legacy messaging lane. The extracted `captureCrmAuditOperation` preserves the previous audit-context constructor validation semantics; it does not substitute a weaker local check. Caller arrays and principal objects are copied before asynchronous work.
2. The existing enrichment loop now visits only `messageParticipant`. Calendar processing follows it through the closed calendar page owner. It does not invoke the old two-lane wrapper a second time, and the new calendar owner contains target DML only: no participant relinking.
3. Preparation validates exact native metadata, same workspace schema, live workspace, and actual calendar-parent FKs. Source table SHARE locks precede discovery. Calendar graph tables are protected against DDL while statements and actual column expressions are inspected.
4. Discovery is bounded to 200 live participant rows with the requested current person IDs. It copies participant, parent and person identities. Parent-first graph locking is followed by exact current parent/person revalidation. Drift at admission is skipped; the cursor still advances to the final discovered ID, including all-skipped pages.
5. Both existing targets and desired targets are restricted to admitted parents. Desired targets use every live participant of those parents, including people outside the triggering selector. Manual and tombstoned target handling stays in the existing pure planner.
6. The source proof covers person, company and opportunity images. It combines fixed relationship predicates with original IDs, so a changed relationship cannot remove an originally captured row from final verification. It also detects newly relevant opportunities introduced by same-transaction triggers. Source SHARE locks fence concurrent source writers; final proof detects changes made by this transaction itself.
7. Calendar graph proof retains original participant IDs in addition to root predicates and expected rows. Scope/metadata and graph proof are repeated around writes and after deferred constraints. Audit uses actual target changes and is flushed before the final deferred-constraint proof.
8. Target insert/update/delete use actual affected IDs and full row images. The new shared image helper preserves database defaults, generated expressions, updatedAt behavior and JSON text precision. The declared write mask is target-specific; FILES/composite fields are rejected where relevant. Incoming mutating FK checks include generated changed columns for update and populated mutating dependants for delete.
9. The proof leaf contains structural read/image helpers, not a mutable audit context, DML, a generic callback boundary or an opaque DI token. MatchService delegates to those helpers; the inspected extraction preserves its earlier SQL behavior. Runtime dependency guard results remain root-owned.
10. The job keeps its existing service dependency, captures a named system operation and copied person IDs before handing off, and leaves ordinary, unknown-commit and confirmed-post-commit errors unchanged. The entry-point test file checks these handoff/error properties and distinct operation/correlation IDs across calls.

## Acceptance coverage recommendation

Add a real PostgreSQL scenario specifically for the NEW CalendarEventTarget update writer:

- a generated target column derived from `isAutomaticallyAssigned`, with a successful flag update proving the actual generated image and audit result;
- a populated incoming ON UPDATE mutating FK dependent on that generated value, proving refusal with the expected cause and no partial target/audit mutation.

The inspected new LOG146 tests cover real target creates/deletes/flag updates, skipped DML, audit rollback, deferred graph drift, same-transaction source expansion, initial person/parent drift, 200-row progress, later-page failure, commit-ack loss, source-lock fencing, incoming DELETE CASCADE and malformed operation preflight. Existing generated-column tests exercise Participant through MatchService. Those are useful shared-helper regression coverage, but do not directly exercise this new target update owner's incoming-FK path.

This is a focused missing acceptance test, not a demonstrated source defect. Do not weaken owner proof or broaden allowed DML to accommodate a test fixture.

## Residual boundaries

- Source review cannot establish actual PostgreSQL behavior, dependency-guard success, or runtime test pass counts; those must come from root's runs.
- Legacy message reconciliation remains unaudited by this new calendar page owner. That is the stated slice boundary, not a claim that the entire native messaging pipeline is closed.
- The old omni-native fixture adaptation was in flight during review; its final form was not evaluated here.
