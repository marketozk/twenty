# LOG146 design — calendar targets after company enrichment

Read-only source design. No application changes, test execution, dependency-guard run or runtime acceptance claim. Examined LOG145 next-boundary, MatchParticipantService, ParticipantTargetReconciliationService, ReconcilePersonCompanyTargetsJob, ParticipantTargetPersonListener, native calendar/message cleanup helpers and dependency guard resolver rules.

## Decision

Keep transaction ownership in **ParticipantTargetReconciliationService**, which already imports WorkspaceOrmManager. The job retains its existing DI dependency. Replace the calendar branch of its one orchestration method; do not call an audited calendar pass followed by the old two-object loop.

Do not inject MatchParticipantService into the job or back into the target service. The former adds a new enterprise-reaching edge; the latter also creates a service cycle. Do not use strings, ModuleRef, callbacks or baseline edits to evade the graph. Moving the entire matching engine to a new helper would require changing email-helper type imports and entity/query-builder dependencies; that is materially larger than the target-only task.

## Exact proposed files

1. `src/modules/match-participant/participant-target-reconciliation.service.ts`: keep existing messaging primitives; add a private closed calendar-person-target page method and switch `reconcileTargetsForPeople` orchestration to messaging pages followed by calendar pages. It already owns WorkspaceOrmManager, coreDataSource, scope type, Person/Opportunity entities and the pure target planner.
2. `src/modules/match-participant/jobs/reconcile-person-company-targets.job.ts`: capture workspace, copied personIds and `systemMembershipCleanupIdentity(workspaceId, ReconcilePersonCompanyTargetsJob.name)` before any await; make `membershipCleanupOperation` and pass it to the existing service. No new DI edge or ACTIVE precheck is required. Existing listener coverage stays unchanged.
3. New `src/engine/core-modules/crm-audit/calendar-target-proof.ts`: structural proof calculations shared with MatchParticipantService. Extract the PostgreSQL expected-image calculation currently in `castMatchingImage` and the fixed parent/original-ID snapshot read currently in `readMatchingGraph`. These helpers do not own an audit context or perform repository INSERT/UPDATE/DELETE. They accept no mutation callback, allowed-write mask or caller-supplied audit session. Keep allowed-column decisions private to each closed owner.
4. `src/modules/match-participant/match-participant.service.ts`: delegate only those extracted proof calculations to the new leaf. Its import/rematch policies, writers, audit lifetime and public contracts remain unchanged. This is a mechanical reuse change, verified by all LOG144/145 tests.
5. Focused PG/job tests; update the sole existing direct `reconcileTargetsForPeople` PG caller to pass a trusted test operation. Existing messaging assertions remain controls.

The extraction avoids copying the full matching engine. The target service still needs its own small terminal owner because its source predicate and write authority are different: Participant.personId selects hints, Participant links never change, only CalendarEventTarget mutates. Reuse the existing pure planner and native audit primitives rather than a generic callback-driven transaction framework.

## Safe structural import boundary

The proof leaf should import only `calendar-save-proof` scalar helpers/types, `native-crm-audit-record` shape/read primitive, and optionally the type of `createCrmAuditWorkspaceExecutor`'s argument:

```ts
type CalendarProofQueryScope = Parameters<typeof createCrmAuditWorkspaceExecutor>[0];
```

That executor's own scope is structural: workspaceId, transactionLifecycle and executeRawQuery. It imports only the small lifecycle type. The existing `native-message-cleanup-with-audit.ts` and `native-calendar-cleanup-with-audit.ts` use this pattern successfully for their repository-shaped internal capabilities.

Do **not** import WorkspaceTransactionScope, WorkspaceRepository, WorkspaceOrmManager, PersonWorkspaceEntity, WorkspaceMemberWorkspaceEntity or email query-builder helpers into the new leaf, even as `type`. `workspace-transaction-scope.type.ts` reaches WorkspaceRepository; `add-person-email-filters-to-query-builder.ts` imports WorkspaceSelectQueryBuilder; `find-person-by-primary-or-additional-email.ts` imports PersonWorkspaceEntity. The guard counts type imports as edges.

Additional target-service imports can use the same audit leaves introduced in LOG144: CrmAuditTransactionContext, createCrmAuditWorkspaceExecutor, CrmAuditOperation, canonicalAuditJson, native record snapshots, getIssuedNativeCleanupMetadata, getIncomingRecordForeignKeys, assertNoReferentialUpdateEffects, and calendar-save-proof scalar functions. LOG144's checked dependency evidence supports these existing paths; the actual new graph still must pass the unchanged guard. No new generated barrel export or package export is needed.

## Public and private API

Keep the job-facing orchestration name but make attribution explicit:

```ts
reconcileTargetsForPeople({workspaceId, personIds, operation}): Promise<void>
```

Capture and validate all inputs before starting the legacy messaging pass, so invalid attribution cannot cause messaging writes followed by a calendar validation error. The method has exactly one production caller, the job, and one existing direct PG test. No public HTTP/API compatibility change is involved.

Use a private terminal method such as:

```ts
reconcileCalendarTargetsForPeoplePage({
  workspaceId, personIds, operation, afterParticipantId,
}): Promise<{nextCursor: string | null}>
```

It creates SYSTEM context and a strict/exclusive transaction itself. No external transaction/audit context parameter. It captures a fresh operation ID per page and keeps invocation correlation. The outer method runs existing messaging-only pages first, then loops calendar pages. No old calendar writer is called afterward. An error stops subsequent pages; earlier committed pages remain committed. Messaging remains explicitly legacy, including its current transaction/error semantics.

## Calendar page algorithm

1. Validate issued original scope via getIssuedNativeCleanupMetadata, exact standard metadata and live workspace. Acquire the native ownership fence through WorkspaceDataSource before callback; keep workspace lock. Source tables Person/Company/Opportunity receive sorted SHARE locks before discovery; graph tables receive deterministic DDL-protecting locks. WorkspaceMember is not a target source and is not written/read to derive targets; five graph plus three source tables suffice. Retain nine if mechanical reuse proves simpler, but document any additional broad lock.
2. Discover at most 200 live Participants ordered by ID with current personId in the captured IDs and id > cursor. Copy both personId and calendarEventId in each discovery hint. Do not lock children before Event parents.
3. Set fixed proof roots/original participant IDs, lock Event then graph children, read exact snapshots including tombstones and original IDs. Admit only still-live candidates whose current parent and personId equal their captured discovery values and whose personId remains in the allowed set. Initial move/change skips; late changes after baseline fail. Cursor advances by final discovered ID even for an all-skipped page.
4. Target roots are only parents of admitted participants. Derive desired targets from **all live participants of those events**, live Person, their companyId regardless of Company tombstone, and live Opportunity.pointOfContactId. Capture fixed source predicates plus original source IDs before first mutation; include later new/changed relevant source candidates in final validation. Person/Company/Opportunity SHARE locks protect source absence from other transactions; final readback protects own triggers.
5. Filter BOTH desired and existing targets by admitted target roots. Preserve all Participant links and other graph rows exactly. Use computeTargetReconciliationOperations for manual/tombstone policy.
6. Only actual returned target INSERT/flag UPDATE/DELETE rows change expected images and audit. Use deterministic full PostgreSQL expected images, actual defaults/generated columns, incoming FK mutation-effect refusal, FILES constraints and all fixed source/graph checks before each stage. Do not treat a conflict-created unexpected row as a successful audited insert.
7. One audit flush, SET CONSTRAINTS ALL IMMEDIATE, then final source/graph verification. No later mutation in that scope. Propagate unknown/confirmed-postcommit errors unchanged to the queue layer. No retries or durable-delivery claims.

The existing person-ID chunking may be retained in the orchestration; duplicate event visits across chunks/pages should become no-ops through actual comparison. A page limits selected participants, not all graph rows of their parent events. New raw matches behind a cursor may require a future invocation; no whole-job snapshot guarantee.

## Focused acceptance

- Actual job/service calendar pass creates Person/Company/Opportunity targets while Participant and every retained graph row remain byte-exact; no matching of email or member links.
- Preserve existing messaging behavior and prove calendar legacy branch no longer runs a second time.
- Company add with manual/tombstone targets; live Person / trashed Company / live Opportunity behavior; unsupported incoming effects and generated target fields.
- Participant personId or parent changes between discovery and lock: skip and retain old-parent targets. Late trigger changes fail exact proof; full skipped page still progresses.
- Skipped target INSERT/UPDATE/DELETE, audit failure, deferred effects, lost COMMIT acknowledgement and prior-page commit retained after later failure.
- Source absent/new/changed candidates, original-ID source removal, real source SHARE contention.
- Import and rematch suites must remain unchanged after proof extraction; typecheck and unchanged enterprise/migration guards must pass before publication.

This is a recommended design based on source facts, not an implemented or dependency-verified patch.
