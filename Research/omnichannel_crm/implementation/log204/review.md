# LOG-204 Independent Code Review

## Verdict
PASS (after addressing 1 Major and 2 Minor findings; 0 Blocker).

## Scope Reviewed
- `packages/twenty-server/src/engine/core-modules/crm-audit/membership-cleanup-identity.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-attribution-context.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-transaction.ts`
- `packages/twenty-server/src/engine/twenty-orm/datasource/workspace-data-source.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/record-share-audit.ts`
- 7 mutating `record-crud` services (`create-record`, `create-many-records`, `update-record`, `update-many-records`, `delete-many-records`, `upsert-record`, `upsert-many-records`)
- `packages/twenty-server/test/fork-migration/crm-audit-public-attribution-and-crud.postgres-spec.ts`
- Cross-checked against `Research/omnichannel_crm/implementation/log204/design.md`, `design-review.md`, `CommonBaseQueryRunnerService`, `ShareWithService`, `role-update-audit.ts`, `WorkspaceAuthContextMiddleware`, `AgentRunService`, `RecordCrudModule`, and `check_enterprise_dependencies.py --verify-baseline`.

## Findings and Resolutions

### Blocker
None.

### Major
1. **False-positive conflict in `assertNestedScopeAttribution` when explicit `options.correlationId` or `options.causationId` overrides an active ALS**
   - Location: `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-transaction.ts` (`assertNestedScopeAttribution`).
   - Issue: when an outer `WorkspaceDataSource.transaction(..., { nativeAudit: { correlationId: explicitCorr } })` ran inside an active `withCrmAuditRequest`/`withCrmAuditIdentity` whose `ambientCorrelationId !== explicitCorr`, a nested `Common*QueryRunnerService` or Branch A `ShareWithService` call inside the exact same ALS had `expected.operation.correlationId === expected.ambientCorrelationId === ambientCorr`, which failed the check `expected.operation.correlationId !== binding.operation.correlationId` and falsely poisoned the outer transaction.
   - Resolution: updated `assertNestedScopeAttribution` so that when `binding.ambientCorrelationId !== undefined` it compares `expected.ambientCorrelationId !== binding.ambientCorrelationId` (catching both ALS drift and ALS masking without conflicting with an outer explicit override); only when `binding.ambientCorrelationId === undefined` does it check `expected.ambientCorrelationId !== undefined || (expected.operation.correlationId !== undefined && expected.operation.correlationId !== binding.operation.correlationId)`. Applied the same symmetric rule to `causationId`. Added a real PostgreSQL regression test covering explicit `correlationId` + `causationId` overrides inside active ALS with nested `CommonUpdateOneQueryRunnerService`.

### Minor
1. **Unused unvalidated `userWorkspaceId` in `NativeCrmAuditAuth` port and unvalidated optional fields**
   - Location: `native-crm-audit-transaction.ts`, `record-share-audit.ts`.
   - Resolution: removed unused `userWorkspaceId` from `NativeCrmAuditAuth` and `toNativeAuthPort`; validated `auth.agentId` via `uuid(...)` inside `captureNativeCrmAuditOperation` for `type: 'application'`; validated `meta.ambientCorrelationId` and `meta.ambientCausationId` via `identifier(...)` inside `withNativeCrmAuditTransaction` before storing them on `scopes`.

2. **Narrowed `application` without `actingAgent`/`agentId` inside resolved `withCrmAuditIdentity` agent context**
   - Location: `native-crm-audit-transaction.ts`, `record-share-audit.ts`.
   - Disposition: acknowledged as Note. Matches the unified `ResolvedCrmAuditOperation` contract of `captureCurrentCrmAuditOperation` and `record-share-audit.ts` (agreed in Design Review m1) so `buildApplicationAuthContext` reconstruction inside agent-scoped HTTP requests stays supported without changing the ALS return shape outside LOG-204 scope.

3. **Test coverage gaps in `crm-audit-public-attribution-and-crud.postgres-spec.ts`**
   - Resolution: added all missing test cases:
     - `DESTROY_ONE` correlation propagation in Test 1,
     - DB state immutability check after missing/soft-deleted impersonator rollback,
     - `user` inside `withCrmAuditIdentity` with resolved `coreUser` initiator and `causationId`,
     - `user` with `application` + `agentId` (`actor: agent`, `initiator: workspaceMember`),
     - explicit `options.correlationId` + `options.causationId` override inside active ALS with nested `UPDATE_ONE` (Major #1 regression),
     - nested `causationId` drift poisoning and rollback,
     - conflicting `auth.agentId` vs ambient agent actor for `application` without `actingAgent`,
     - invalid `causationId` (`""`, 257 chars) rejection in `copyMembershipCleanupIdentity`,
     - direct `withNativeCrmAuditTransaction` pre-lock validation of `impersonatorUserWorkspaceId` and actor kind (`rawQuerySpy` not called).

## Post-Fix Verification
- Enterprise dependency guard: `status: pass`, `0` violations (`edges: 137821`).
- Migration source guard: `10` sources verified, `33/33` Python guard tests OK.
- Differential typecheck: `baselineDiagnostics: 275`, `currentDiagnostics: 275`, `newDiagnostics: []` (only pre-existing upstream `TS2769` at `upsert-many-records.service.ts:71` on untouched `isFreshlyCreatedRecord` line).
- Targeted PostgreSQL 17 suites: `7/7` suites, `226/226` tests passed (`36.375s` before final test type fix; updated `crm-audit-public-attribution-and-crud.postgres-spec.ts` `3/3` passed in `11.467s`).
