# LOG147: remaining person-company messaging target writer

Read-only source review against the checkout containing LOG146. No production edits, runtime commands or tests were executed for this review. LOG146 test status belongs to the parent agent's evidence, not this report.

## Scope and current behavior

`ParticipantTargetReconciliationService.reconcileTargetsForPeople` validates and copies the complete operation and person selector before its first await. It still processes message participants in ordinary workspace transactions before the new audited calendar pages. The job already supplies a captured named system actor and shares one correlation across the operation. Keep its DI unchanged.

The remaining legacy loop selects live `messageParticipant.personId`, resolves each participant's message and thread, then reconciles targets globally for every live person-linked participant of those threads. The triggering person IDs select threads; they are NOT a filter on desired targets inside an admitted thread. Preserve manual/automatic/tombstone behavior through the existing pure planner. Company links remain desired even for a soft-deleted Company; deleted Message, Participant, Person and Opportunity sources do not contribute desired targets.

`ParticipantTargetPersonListener` still selects only companyId null/undefined -> defined. Company replacement/removal, Opportunity changes and Person deletion/restoration are not covered by this job. Do not broaden triggers in LOG147 or claim these gaps closed.

## Reusable owner and authority

`src/engine/core-modules/crm-audit/native-message-cleanup-with-audit.ts` already implements `reconcileNativeMessageThreadTargetsWithAudit` using private `createSession`, `prepareSession`, `reconcileTargetsStage`, and `finalizeSession`. The adjacent `reconcile-native-message-thread-targets-with-audit.ts` is only a re-export facade.

The existing helper is a terminal owner, not a composable public stage. `finalizeSession` verifies, flushes audit, drains deferred constraints, then verifies again. Its source graph, target DML/RETURNING validation, incoming referential-effect checks and audit should be reused. Do not invoke this public terminal helper and append selector validation or domain writes afterward. Do not expose a callback or mutable session to the service.

Its structural `TargetReconciliationScope` is based on `Parameters<typeof createCrmAuditWorkspaceExecutor>[0]` plus the exact repository operations; it does not import the concrete workspace transaction/entity graph. `getIssuedNativeCleanupMetadata` checks the original issued object, active lifecycle, strict outcome and exclusive native ownership mode via the capability WeakMap. A copied/fake scope or bypass-permission flag is insufficient. The service must issue a real SYSTEM `runInWorkspaceTransaction` with `{commitOutcome:'strict', nativeOwnershipLock:'exclusive'}` and return the terminal owner result directly from the transaction callback.

## Smallest implementation design

1. Add one closed person-selector page entry to the existing native cleanup module, e.g. `reconcileNativeMessageThreadTargetsForPeopleWithAudit({scope, personIds, afterParticipantId?, operation}): Promise<{nextCursor:string|null}>`. Re-export it through the existing leaf facade. Reuse the private session and target stage; no new injectable service, provider, job dependency, broad email-helper refactor or duplicated target implementation.
2. Capture/validate bounded UUID person IDs and optional UUID cursor synchronously. Service-level LOG146 full operation validation remains before either channel. Each page's existing `createSession` supplies a fresh operation ID while preserving captured actor/initiator/correlation.
3. Prepare the exact seven-table session (Thread, Message, Participant, Person, Company, Opportunity, ThreadTarget). After the strict ownership fence and sorted DDL table locks, acquire sorted `SHARE` table locks on Person, Company and Opportunity BEFORE discovery or graph row locks. These three sources are read-only in this lane. Existing `reconcileTargetsStage` has ROW EXCLUSIVE table locks and row/FK locks, but no source SHARE locks; do not claim it already provides the stronger raw-source absence fence. Keep this strengthening local to the new page entry unless separately justified.
4. Discover at most 200 live person-linked participants in stable ID order. Preserve each discovered participant ID, exact person ID, original message ID and original messageThread ID. Use a LEFT JOIN for the message hint, or a separate nonlocking hint read, so an orphan/deleted-message candidate still advances the participant cursor. Hints are not authority. Do not use FOR UPDATE on this discovery query.
5. Reuse the private stage's parent-first graph locks: Thread, Message, Participant, Person, Company, Opportunity, Target (Company SHARE). Add a narrowly typed private selector parameter, not a generic callback. After locks, admit only roots with at least one discovered participant still live, still selected by person ID, and still attached through the exact discovered live Message to the exact discovered live Thread. A participant moved to another selected person is only admissible if the agreed contract explicitly permits selector-set membership rather than exact original person ID; use exact original person ID for this lane to avoid silently changing the triggering relationship.
6. Keep discovery roots and admitted target roots separate. Existing stage currently selects all live unowned candidate threads; intersect this with revalidated person-selector roots for the new entry. BOTH desired targets and existing target rows supplied to the planner must use the admitted roots. A stale/moved hint must not clear targets on its former thread, and must not authorize work on its new thread. Existing direct thread-ID entry retains its original selection behavior.
7. Retain original discovered Participant and Message IDs in proof reads, not only the live selector. Otherwise an audit/deferred trigger can move a selected child out of the root query and hide a change. An already moved hint before locking is skipped, not followed into a new parent. To preserve parent-first locking, do not blindly acquire child locks on moved original IDs outside the locked roots: read these original IDs for rejection/validation separately, or use an equivalent closed graph proof that does not lock a new parent after its child. Capture selection proof before target DML and register its verifier inside the same private session, including the final post-deferred verification. Source/selector changes after capture fail the page atomically.
8. Call the private target stage once, then finalize exactly once; no later domain writes in that transaction. Cursor is the last DISCOVERED participant on a full page, even if all hints are stale, deleted, omni-owned or otherwise skipped. Underfull/empty pages return null. Do not derive progress from writes or admitted IDs.
9. Replace only the legacy messaging branch of public `reconcileTargetsForPeople` with these strict pages. Keep messaging-then-calendar ordering, per-page commit semantics, shared correlation and fresh operation IDs. Propagate errors unchanged and stop later pages/calendar on an error or unsafe commit outcome. Do not replay ambiguous committed pages automatically. Preserve generic `reconcileParticipantTargets`, `reconcileMessageThreadTargetsFromMessageIds` and `reconcileMessageThreadTargets` for other callers.

## APP and ownership distinction

The current target-only job does NOT exclude every APP channel. It excludes omni-owned threads via `findOmniOwnedMessageThreadIds`. Both that helper and `findOmniNativeWriteOwnedRecords` derive ownership from `omniConversation`, `omniMessageLink`, and `omniAccountBinding` (including bound associations), not `messageChannel.type = APP`. APP filtering belongs to `MatchParticipantService.withoutAppChannelParticipants`, a different matching lane. Preserve those existing APP matcher exclusions by leaving matching untouched; preserve target-only eligibility for an ordinary APP thread without omni ownership. Add controls for both cases rather than introducing a new blanket APP exclusion under the name of compatibility.

The existing native target owner also filters deleted Threads; legacy generic target reconciliation does not directly check Thread liveness. Using the existing owner therefore explicitly adopts its live-Thread policy for this migrated job. Test that deleted Thread targets stay untouched; do not describe exact legacy Thread-liveness compatibility. Message/Participant/Person/Opportunity liveness and deleted-Company-link behavior are already covered by the existing target owner tests and should remain unchanged.

## Verification required before publication

- Actual public service/job path, real issued strict/exclusive scope and real target repositories; invalid actor/initiator/correlation/person selector rejected before any writes. No additional injection or concrete scope imports. Actual enterprise dependency guard is required; source inspection is not proof that new import edges pass it. Never amend the baseline or hide imports with opaque DI.
- Global thread derivation: one triggering person admits a thread with another person's participants; targets for BOTH people/company/opportunities remain correct. Sources and participant links remain unchanged.
- Discovery race: participant person changes, participant moves to another message/thread, message moves to another thread, deleted participant/message/thread; stale former-root targets remain unchanged unless another valid candidate admits that root. Original IDs remain in final proof.
- 200 full-page candidates, all skipped full page, cursor ordering, underfull page, multiple pages and message-before-calendar ordering. Fresh operation IDs with shared correlation; stop on ordinary/unsafe failures.
- Ordinary APP thread remains eligible; omni Conversation/link/binding-owned thread untouched, including ownership changes at flush. Mixed ordinary/owned pages do not affect owned targets.
- Source SHARE blocking tests with independent raw writer; source rows/late Opportunity creation serialized before source capture or after commit. Required FK rejection, generated target images and source-trigger tampering, skipped insert/update/delete actual-effect audit, audit failure/deferred resurrection rollback, real commit-ACK loss.
- Existing `crm-audit-native-target-reconciliation.postgres-spec.ts` regression (manual/tombstone, source-liveness, no-op, skipped DML, ownership at flush, deferred delete resurrection, FK/incoming cascade, source concurrency, ambiguous commit), existing LOG146 calendar target suite, rematch suites and generic messaging controls.

Existing target-stage update validation permits only automatic-flag and updatedAt changes; generated dependent fields may fail closed rather than be accepted. Do not silently assert generated-column support from the fact that full snapshots are read. Test the new lane and either document the inherited fail-closed behavior or make a separately reviewed narrow generated-image correction using the existing generated-image primitive.

## Evidence paths

All paths below are relative to `packages/twenty-server`:

- `src/modules/match-participant/participant-target-reconciliation.service.ts`: public operation validation, remaining ordinary messaging loop, LOG146 calendar owner and legacy global-target policy.
- `src/modules/match-participant/jobs/reconcile-person-company-targets.job.ts`: captured system operation and unchanged DI.
- `src/modules/match-participant/listeners/participant-target-person.listener.ts`: event selection.
- `src/engine/core-modules/crm-audit/native-message-cleanup-with-audit.ts`: session prepare/finalize, private target stage and terminal export.
- `src/engine/core-modules/crm-audit/reconcile-native-message-thread-targets-with-audit.ts`: existing leaf facade.
- `src/engine/twenty-orm/repository/omni-native-write-capability.ts`: issued scope/lifecycle/exclusive checks.
- `src/modules/omnichannel/services/find-omni-owned-native-record-ids.ts` and `assert-omni-native-write-unowned.ts`: real ownership selector.
- `src/modules/match-participant/match-participant.service.ts`: separate APP matching filter.
- `test/fork-migration/crm-audit-native-target-reconciliation.postgres-spec.ts`: existing terminal-owner runtime contract tests.
