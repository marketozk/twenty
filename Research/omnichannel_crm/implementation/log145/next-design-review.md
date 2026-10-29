# LOG146 independent design review

Read-only review of the current LOG145 checkout, `implementation/log145/next-boundary.md` and `TEMP/log146-design.md`. Checked actual target orchestration, target policy, job DI, audit executor/operation validation, structural snapshot types and dependency inventory. No application edits, runtime checks or dependency-guard execution.

## Verdict

The proposed target-service terminal owner is the smallest coherent next boundary. Keep `ReconcilePersonCompanyTargetsJob` dependent only on `ParticipantTargetReconciliationService`. Keep messaging first and explicitly legacy; replace the old calendar branch rather than adding a second calendar pass. Do not inject MatchParticipantService back into the target service or hide it behind ModuleRef/tokens.

Extracting only the graph snapshot reader and PostgreSQL expected-image calculator is reasonable. These operations have the same precision, original-ID and generated/default semantics in both owners. Keep all email discovery/matching in MatchParticipantService; keep target allowed-field decisions, DML, audit context and transaction ownership private. A moderate amount of target-owner orchestration is preferable to a public callback-driven write framework or copying the whole matching engine.

## Structural helper contract

`createCrmAuditWorkspaceExecutor` accepts a structural scope containing workspaceId, optional lifecycle and executeRawQuery; its only type dependency is the small lifecycle type. Using `Parameters<typeof createCrmAuditWorkspaceExecutor>[0]` does not require WorkspaceTransactionScope. The helper can receive a specific shape, fixed root IDs, original IDs and lock flag, and return exact JSON-text snapshots. It should not receive the mutable owner state/audit context or update expected maps itself.

For the expected-image calculation, retain typed PostgreSQL row casting, prior full JSON-text values, actual pg_attrdef expressions, updatedAt and generated expressions. The private owner checks its write allowlist before calling it. Caller-generated IDs must be supplied, not reevaluated UUID defaults. Volatile custom defaults remain conservatively unsupported by equality proof, as in LOG144; do not advertise arbitrary default compatibility or literal purity of evaluating catalog expressions.

Do not import WorkspaceTransactionScope, entity types, WorkspaceRepository or query-builder/email utilities into the new leaf, including type-only imports. The current dependency guard includes those edges. Audit/shape leaves are plausible imports, but only the actual unchanged-baseline guard establishes success.

## Admission, source coverage and ordering

- The page must acquire its issued strict/exclusive ownership fence before any native discovery. Prepare exact metadata and live-workspace proof, then sorted Person/Company/Opportunity SHARE locks and graph DDL locks. These three source tables are sufficient for target derivation; Member links are retained in Participant snapshots without selecting or changing members.
- Read up to 200 live participants by captured person IDs and cursor, returning both current personId and calendarEventId. Lock Events before Participant rows. A pre-lock parent or person change skips that hint; compare exact discovered person ID even if the replacement belongs to the same supplied ID list. Retain original IDs in graph proof.
- Advance the cursor by the final discovered ID, including a full all-skipped page. The bound applies to selected hints, not the total graph of their events. No whole-job snapshot or eventual-delivery guarantee follows from paging.
- Proof roots include discovered parents and retained IDs. Target roots include only admitted current parents. BOTH desired and existing target lists must be filtered by target roots; otherwise stale old-parent targets can be deleted after a candidate moves.
- Desired targets use all live participants of admitted events, live Person, that Person's companyId even if the Company is trashed, and live Opportunity. Source snapshots must cover all those people, not just the supplied trigger personIds. Fixed Opportunity predicates and original source IDs detect later introduced, removed, moved or restored sources. Source SHARE protects external absence; final readback still checks same-transaction triggers.
- Participant rows, Event, Association and CallRecording must remain exact. Only Target inserts/assignment-flag updates/deletes are admitted. Before each subsequent stage verify current sources/graph so a prior trigger cannot become a new accepted baseline. Finish one flush, deferred drain and final proof.

## Attribution admission detail to implement explicitly

The design says invalid attribution must fail before the legacy messaging pass. Checking only workspaceId/operationId does not establish this: CrmAuditTransactionContext validates actor/initiator and correlation/causation only when the calendar context is later constructed (`crm-audit-transaction-context.ts:749–762`). Thus malformed principal data could otherwise permit legacy messaging writes first.

The sole production caller can supply the existing validated named-system identity, so this is straightforward to keep narrow: capture/validate the complete supported worker identity before either lane, including scope and correlation, using an existing trusted identity helper where its deliberately narrower contract applies. Do not fabricate an active executor or a fake transaction merely to instantiate the audit context for validation. If the service retains the full generic CrmAuditOperation contract, share a structural operation-copy validator instead of silently validating only two fields; add a negative test proving malformed actor/initiator is rejected before any messaging write. Avoid introducing new actor kinds solely for this task.

Capture all person IDs before the first await. Keep the existing job's lack of ACTIVE precheck; new page liveness is a separate under-lock condition. Use a fresh page operation with invocation correlation; no original user identity exists in the event payload. Error propagation must stop later pages and preserve known-postcommit/unknown outcomes, while prior legacy messaging/page commits remain committed.

## Verification additions

1. All LOG144/145 import/rematch tests pass unchanged after helper extraction; old generic messaging controls remain.
2. Real job-to-service calendar target audit, no Participant link/timestamp change, manual/tombstone preservation and no duplicate legacy calendar write.
3. Two candidate person IDs in one selector, one candidate reparented or switched from the first allowed person to the second before lock: skip that hint and retain old-parent targets.
4. 201+ hints with a full skipped page; later-page failure retains earlier commit and stops later work.
5. Actual skipped Target writes, audit/deferred rollback, generated image/FK effects, lost COMMIT ACK and exact cause assertions.
6. New Opportunity appearing for an unrequested but live participant of the admitted event is included in source proof; own-trigger changes must roll back.
7. Malformed supported attribution before the messaging lane; copied input arrays/identity remain unchanged by mutations during the first await.

No architectural blocker remains if these constraints are implemented. This review is source evidence only, not a passing implementation or runtime acceptance.
