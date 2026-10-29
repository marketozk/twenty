# LOG143 independent source review

Reviewed the current dirty `CalendarSaveEventsService` closed owner and `calendar-save-proof.ts`, plus actual repository INSERT/UPDATE/DELETE behavior, native mutation timestamp maintenance, event/participant planners, standard generated-search metadata, and source/run lock helpers. No runtime, formatting, checkout edits, or remote jobs were performed.

## Concrete findings and bounded repair readback

Three blockers were reported to the parent while implementation was being integrated. All three repairs are present in the subsequently reread current source. This is source verification, not passing PostgreSQL evidence.

1. **Late ordinary ownership admission was incomplete.** The initial version called `lockOrdinaryNativeSyncRun` only once, while final source verification compared core channel/account columns. A same-transaction trigger adding an omni ownership binding could leave those columns unchanged. The current private audit state retains the copied expected run and `verifySaveGraph` repeats the real helper before every phase/final verification. A false late proof throws. The no-run/manual path remains separate.

2. **Generated search columns were missing from expected UPDATE images and FK probes.** The initial `castSaveImage` retained the previous `searchVector`; an ordinary Event title change recomputes the real generated column and therefore falsely failed full-row verification. Actual standard metadata defines Event `searchVector` over title and Participant `searchVector` over handle; native SQL DDL uses GENERATED ALWAYS. The current implementation reads generated expressions from the table's held catalog definition, evaluates them on the projected row, and includes all resulting changed columns in the incoming-FK probe without writing generated columns explicitly. This also prevents an incoming ON UPDATE cascade keyed by a generated column from escaping the guard.

3. **Duplicate new participant logical identities were admitted.** UUID-only insertion checks did not reject two distinct planned IDs for the same `(calendarEventId, handle)`. The current insertion plan checks this key before the first Event mutation. Existing persisted duplicate-first-wins behavior is not replaced, and ordered repeated updates to a shared existing row remain individually verified.

Required focused runtime evidence: late binding insertion rolls back graph/audit; Event title update with the actual generated column succeeds and audits the computed state; populated incoming FK keyed by a changed generated column refuses; repeated new participant key refuses before graph mutation. Parent controls test execution.

## Other verified contracts

- Fetched events and nested participants are captured with the existing deep audit capture before feature-flag/context waits. Operation principals, run proof, channel/account IDs and aliases are captured before asynchronous work.
- The actual issued SYSTEM scope is strict/exclusive. Workspace and exact five-object metadata are checked; Event parents are locked before child graph reads; source accounts and channels lock in deterministic parent-first order.
- Planner source associations are revalidated after locks. Full original/expected graph snapshots retain tombstones, untouched Target/CallRecording rows, and rows moved out of their original parent selector.
- Event, Association and Participant operations still use real WorkspaceRepository methods, including their event/stock behavior. Expected mutation images use PostgreSQL casts and CURRENT_TIMESTAMP, matching `workspace-mutation-query-builder.ts` rather than JS clock timestamps.
- Actual RETURNING controls audit and emitted IDs. Skipped Event creation required by dependent writes rejects; retained/skipped updates stay exact. Postcommit matching gets actual persisted participant IDs.
- Unsupported incoming UPDATE effects and Participant DELETE cascades are probed before writes; graph is verified after every batch and after audit/deferred constraints. Audit is emitted once from first-before/final-after.
- Matching/enqueue failures after the committed save preserve an existing unsafe error or become `CoreAuditPostCommitError`. They cannot be presented as a rolled-back save.

## Boundaries and unverified items

- This review did not execute the enterprise dependency guard or tests. Existing planner/repository import edges are retained; a guard pass must come from the parent runner.
- Provider manual-create attribution helper/wiring was still being completed by the entrypoint author and is outside this owner readback.
- Feature flag is a captured invocation value, not a transactionally locked settings store. Raw-SQL absent-row uniqueness is not supplied by this owner; supported native writers serialize through the exclusive ownership fence.
- Participant matching, target reconciliation, contact creation and durable postcommit delivery remain separate work. No claim that this save audit closes those stages.
- Full snapshots and locks live for the entire invocation; mutation batch sizes do not bound total memory or transaction duration.

No further concrete blocker was found in the bounded reread after the three repairs above.

## Root checks and corrections

The initial PG run exposed an incomplete test core.messageChannel projection and two stale-run compatibility regressions. The fixture now includes the actual connectedAccountId column; initial missing/reparented/nonordinary run proofs return applied:false, while late drift refuses. Missing other-channel metadata retains the prior sharing filter behavior.

The first differential typecheck exposed use of a nonexistent WorkspaceScopedRepository.manager. Impersonator lookup now uses its existing public createQueryBuilder, with actual request-ALS entry tests. Planned Event IDs are narrowed with runtime validation; helper metadata types and a readonly test proof were corrected. DI-only Jest mocks isolate the actual entry services from unrelated AI ESM dependencies; the audited services and identity primitives remain real.

The existing participant-writer integration fault injection sites were moved to the real repository phases without changing rollback/status/order assertions. Those full application integration tests were typechecked but not executed in this isolated run; real PG save-owner tests provide the transaction evidence. No runtime deployment or full HTTP/JWT acceptance is claimed. See results.json for the final executed checks.
