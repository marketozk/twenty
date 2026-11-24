# LOG-211: Design (Revised after Design Review)

## 1. Goal and boundary

`LOG-211` closes native CRM audit coverage for `dashboard` - the last user-facing (`isSystem: false`) standard CRM object outside `workflow` (`ROB-769`) - and brings all runtime direct non-CRUD `dashboard` writers under the fail-closed `runInWorkspaceTransaction` audit contract.

### In scope
1. Enable `dashboard` in `AUDITED_OBJECTS` in `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-record.ts`:
   - Covers standard CRUD (`CommonCreateMany`, `CommonUpdateMany`, `CommonDeleteMany`, `CommonRestoreMany`, `CommonDestroyMany`, `CommonMergeMany`), Branch A `ShareWithService` (from `LOG-210`), `TrashCleanupService` (`systemActorId: 'trash_cleanup'`), and incoming FK effects:
     - `attachment.targetDashboard` (`ON DELETE CASCADE`, including `attachment.file` `FILES` via `prepareNativeCrmDeleteFiles` -> `crmFile:update` + `delete_filesFieldFiles` intent).
     - `timelineActivity.targetDashboard` (`ON DELETE SET NULL`).
   - Pre-query hooks (`DashboardCreateOne/ManyPreQueryHook`, `DashboardDestroyOne/ManyPreQueryHook` -> `DashboardToPageLayoutSyncService`) already propagate `auditIdentity: { auth: authContext }` to `PageLayoutService` / `PageLayoutTabService` (from `LOG-183`).
2. Add a `WeakSet`-verified navigation-identity bridge in `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-transaction.ts` (`captureNativeCrmAuditBindingFromNavigationIdentity` + `assertTrustedNativeCrmAuditBinding`), wired into `WorkspaceTransactionOptions.nativeAuditBinding` (`workspace-transaction-lifecycle.type.ts`) and `WorkspaceDataSource.transaction` (`workspace-data-source.ts`):
   - Keeps `WorkspaceAuthContext` (`buildSystemAuthContext(workspaceId)`) untouched in bridge services (`createCreateCompleteDashboardTool`, `PageLayoutService.destroyAssociatedDashboards`) so existing RLS, role resolution, and event behavior do not regress (`M2`).
   - Never masks or overwrites ALS via `withCrmAuditIdentity`: always reads the active `captureCurrentCrmAuditOperation(workspaceId)` and validates `auditIdentity` against it (`B1`, `B2`), rejecting impersonation+agent combinations and cross-user / cross-application / cross-apiKey conflicts.
   - Preserves all principal fields on `RequestLikeAuditIdentity` (`user`, `workspaceMemberId`, `application`, `viaApplication`, `apiKey`, `agentId`, `impersonatorUserWorkspaceId`, `impersonationContext.impersonatorUserWorkspaceId`) so real GraphQL/REST `PageLayoutService.destroy` requests pass ambient validation (`B3`).
   - Supports `authUserWorkspaceId` via `pendingAuthUserWorkspaceId` (+ optional `pendingAgentId` / `pendingUserWorkspaceActor`) resolved inside `withNativeCrmAuditTransaction` and `recordPostRollbackNativeCrmAuditAttempt` from `core."userWorkspace"` (`WHERE id = $1 AND "workspaceId" = $2 AND "deletedAt" IS NULL`), matching `navigation-menu-item-audit.ts` (`M1`).
   - Allows `impersonatorUserWorkspaceId` on `coreUser` as well as `workspaceMember` actors in `withNativeCrmAuditTransaction` and `recordPostRollbackNativeCrmAuditAttempt` (rejecting impersonation combined with `agent` or `application`).
   - Accepts `nativeAuditBinding` in `WorkspaceDataSource.transaction` ONLY when:
     - `options.nativeAudit` is absent (mutually exclusive),
     - `this.authContext.type === 'system'`,
     - the binding object is present in the module-private `trustedNavigationBindings` `WeakSet`, and
     - `binding.operation.workspaceId === normalizedWorkspaceId`.
   - Fails closed on unsupported/invalid explicit principals (`pendingActivationUser`, bare `agentId` without user/member/application/authUserWorkspaceId, workspace mismatch) - never downgrades an explicit principal to `system`.
   - Zero new imports into Enterprise-reachable modules (`B4`).
3. Audit all 4 runtime direct `dashboard` writers outside `Common*QueryRunnerService`:
   - **`DashboardDuplicationService.duplicateDashboard`** (`packages/twenty-server/src/modules/dashboard/services/dashboard-duplication.service.ts`):
     - Use a consistent `systemActorId: 'dashboard-duplication:duplicate'` when `authContext.type === 'system'` for both `captureNativeCrmAuditBinding` and `pageLayoutDuplicationService.duplicate` (`M3`).
     - If `!isDefined(rolePermissionConfig)` or `assertCanCreateDashboardOrThrow` throws `PermissionsException`, safely capture `binding` (catching attribution errors so non-auditable auth still rethrows `PermissionsException`) and record post-rollback `denied` attempt inside `executeInWorkspaceContext` with `resourceId: dashboardObjectMetadataId` (`M3`).
     - Capture `binding` (with pre-generated `operationId`) BEFORE calling `pageLayoutDuplicationService.duplicate` so ambient/attribution conflicts fail closed before creating any layout (`M3`).
     - Pre-generate `newDashboardId = uuidv4()`. Inside `runInWorkspaceTransaction(async (transactionScope) => ..., { nativeAudit })`, obtain `txDashboardRepository = transactionScope.getRepository<DashboardWorkspaceEntity>('dashboard', rolePermissionConfig)`, insert `{ ...recordWithActor, id: newDashboardId }`, and read back with `findOne`.
     - In `createDuplicatedDashboardOrRollback`'s `catch` (and NOT in `duplicateDashboard`'s outer `catch`, preventing bogus attempts on `DASHBOARD_NOT_FOUND` or double-recording, `M3`):
       - Call `recordPostRollbackNativeCrmAuditAttempt` (`action: 'create'`, `resourceId: newDashboardId`, `objectMetadataId`).
       - Skip compensating `pageLayoutService.destroy(...)` when `isTransactionUnsafeToRetry(error)` is true.
       - When compensation runs, pass `isLinkedDashboardAlreadyDestroyed: true` to `pageLayoutService.destroy(...)`.
   - **`createCreateCompleteDashboardTool`** (`packages/twenty-server/src/modules/dashboard/tools/create-complete-dashboard.tool.ts`):
     - Validate and capture `nativeAuditBinding` via `captureNativeCrmAuditBindingFromNavigationIdentity` at the start of `execute(...)` BEFORE `pageLayoutService.create(...)` (`M2`), using `defaultSystemActorId: 'dashboard-tool:create-complete-dashboard'`, `auditIdentity: context.auditIdentity`, `authUserWorkspaceId: context.authUserWorkspaceId`.
     - Keep `deps.recordPositionService.buildRecordPosition(...)` outside `runInWorkspaceTransaction` so it does not check out a second connection while holding `lockOmniNativeOwnership` (`m3`).
     - Keep `buildSystemAuthContext(context.workspaceId)` for `executeInWorkspaceContext` and pass `{ nativeAuditBinding }` to `runInWorkspaceTransaction`, getting `txDashboardRepository = transactionScope.getRepository('dashboard', context.rolePermissionConfig)` (`M2`).
     - Inside `executeInWorkspaceContext`, wrap `runInWorkspaceTransaction` in `try/catch` and call `recordPostRollbackNativeCrmAuditAttempt` (`action: 'create'`, `resourceId: dashboardId`, `objectMetadataId`).
     - In `createDashboardRecordOrRollBackLayout`, skip `pageLayoutService.destroy(...)` when `isTransactionUnsafeToRetry(error)` is true.
   - **`DashboardSyncService.updateLinkedDashboardsUpdatedAtByPageLayoutId`** (`packages/twenty-server/src/modules/dashboard-sync/services/dashboard-sync.service.ts`):
     - Inside `executeInWorkspaceContext`, capture `binding = captureNativeCrmAuditBinding(workspaceId, authContext, { operationId, systemActorId: 'dashboard-sync:update-linked-dashboards' })` and run `txDashboardRepository.update({ pageLayoutId }, { updatedAt })` inside `runInWorkspaceTransaction(..., { nativeAudit })` with `transactionScope.getRepository('dashboard', { shouldBypassPermissionChecks: true })`.
     - Ambient `correlationId`/`causationId` is automatically inherited by `captureNativeCrmAuditBinding` for `auth.type === 'system'`.
     - Catch transaction errors INSIDE `executeInWorkspaceContext` (`m1`), call `recordPostRollbackNativeCrmAuditAttempt` (`action: 'update'`, `resourceId: dashboardObjectMetadataId`, `objectMetadataId: dashboardObjectMetadataId`), and log the error (preserving existing best-effort non-throwing sync semantics).
     - Note (`m2`): `update({ pageLayoutId }, { updatedAt })` matches live and soft-deleted dashboards with that `pageLayoutId` and is subject to `QUERY_MAX_RECORDS` (exceeding it records a post-rollback `failed` attempt and logs).
   - **`PageLayoutService.destroy` / `destroyAssociatedDashboards`** (`packages/twenty-server/src/engine/metadata-modules/page-layout/services/page-layout.service.ts`):
     - When `flatPageLayoutToDestroy.type === PageLayoutType.DASHBOARD && !isLinkedDashboardAlreadyDestroyed`, capture `dashboardAuditBinding` via `captureNativeCrmAuditBindingFromNavigationIdentity` BEFORE `validateBuildAndRunWorkspaceMigration` so invalid dashboard audit identity fails closed before committing `core.pageLayout` deletion (`M1`).
     - Pass `dashboardAuditBinding` into `destroyAssociatedDashboards`.
     - Inside `executeInWorkspaceContext(..., buildSystemAuthContext(workspaceId))`, run `runInWorkspaceTransaction(..., { nativeAuditBinding: dashboardAuditBinding })`: select associated `dashboard` IDs (`where: { pageLayoutId }`, `select: ['id']`, `order: { id: 'ASC' }`) and hard-delete in chunks of `1000` via `txDashboardRepository.delete(chunk)` (so `WorkspaceRepository.delete` atomically audits `dashboard` deletes, `attachment` cascades + `FILES` intents, and `timelineActivity` `SET NULL` updates under one `operationId`).
     - Catch errors INSIDE `executeInWorkspaceContext` (`m1`), record `recordPostRollbackNativeCrmAuditAttempt` (`action: 'delete'`, `resourceId: dashboardIds.length === 1 ? dashboardIds[0] : dashboardObjectMetadataId`, `objectMetadataId: dashboardObjectMetadataId`), and rethrow.
4. Update `packages/twenty-server/test/fork-migration/crm-audit-custom-record.postgres-spec.ts` to remove `'dashboard'` from the uncovered standard object list.

### Out of scope
- `workflow` / `workflowVersion` / `workflowRun` / `workflowAutomatedTrigger` (deferred to `ROB-769`).
- Bootstrap / dev seeding direct SQL writers using raw TypeORM `EntityManager` (matching `prefillCompanies`/`prefillPeople`/`prefillOpportunities`):
  - `packages/twenty-server/src/engine/workspace-manager/standard-objects-prefill-data/utils/prefill-dashboards.util.ts`
  - `packages/twenty-server/src/engine/workspace-manager/dev-seeder/data/services/dev-seeder-data.service.ts`
- Messaging / calendar standard objects (`message`, `messageThread`, `calendarEvent`, etc. - separate boundaries).
- Changing `DashboardSyncService` from best-effort `try/catch` to throwing on sync failure.
- Deleting soft-deleted dashboards in `PageLayoutService.destroyAssociatedDashboards`.

## 2. Enterprise dependency safety

Verified against `scripts/omnichannel/check_enterprise_dependencies.py`:
- `src/engine/core-modules/crm-audit/*.ts` and `src/engine/twenty-orm/error-handling/is-transaction-outcome-unknown.ts` are all `enterprise_reachable: false`.
- `workspace-transaction-lifecycle.type.ts` adds only type imports from `src/engine/core-modules/crm-audit/crm-audit.types.ts` (not Enterprise-reachable, acyclic).
- `create-complete-dashboard.tool.ts` does NOT import `twenty-shared/utils` (`B4`).
- No new imports from `build-system-auth-context.util.ts`, `workspace-auth-context.type.ts`, or `orm-workspace-context.storage.ts`.

## 3. Files to modify / create

| File | Action | Purpose |
|---|---|---|
| `packages/twenty-server/src/engine/twenty-orm/types/workspace-transaction-lifecycle.type.ts` | Modify | Define `NativeCrmAuditBinding` and optional `nativeAuditBinding?: NativeCrmAuditBinding` on `WorkspaceTransactionOptions` |
| `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-record.ts` | Modify | Add `dashboard` to `AUDITED_OBJECTS` |
| `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-transaction.ts` | Modify | Add `captureNativeCrmAuditBindingFromNavigationIdentity` + `assertTrustedNativeCrmAuditBinding`, support `pendingAuthUserWorkspaceId` and `coreUser` impersonation in `withNativeCrmAuditTransaction` |
| `packages/twenty-server/src/engine/core-modules/crm-audit/post-rollback-crm-audit-attempt.ts` | Modify | Support `pendingAuthUserWorkspaceId` and `coreUser` impersonation in `recordPostRollbackNativeCrmAuditAttempt` |
| `packages/twenty-server/src/engine/twenty-orm/datasource/workspace-data-source.ts` | Modify | Accept trusted `options.nativeAuditBinding` for system-context bridges |
| `packages/twenty-server/src/modules/dashboard/services/dashboard-duplication.service.ts` | Modify | Audited duplication transaction, pre-layout capture, `systemActorId`, `denied`/`failed` attempts, safe compensation guard |
| `packages/twenty-server/src/modules/dashboard/tools/create-complete-dashboard.tool.ts` | Modify | Early `nativeAuditBinding` capture, audited insert transaction, post-rollback attempt, safe compensation guard |
| `packages/twenty-server/src/modules/dashboard-sync/services/dashboard-sync.service.ts` | Modify | Audited system transaction (`dashboard-sync:update-linked-dashboards`) + in-context post-rollback attempt |
| `packages/twenty-server/src/engine/metadata-modules/page-layout/services/page-layout.service.ts` | Modify | Pre-migration `dashboardAuditBinding` capture, chunked audited `destroyAssociatedDashboards` + in-context post-rollback attempt |
| `packages/twenty-server/src/modules/dashboard/tools/__tests__/create-complete-dashboard.tool.spec.ts` | Modify | Update mocks and add unit tests for `nativeAuditBinding`, `auditIdentity`, `NativeTransactionOutcomeUnknownError`, and fail-closed early rejection |
| `packages/twenty-server/test/fork-migration/crm-audit-custom-record.postgres-spec.ts` | Modify | Remove `'dashboard'` from uncovered standard objects |
| `packages/twenty-server/test/fork-migration/crm-audit-dashboard.postgres-spec.ts` | Create | Real PostgreSQL 17 integration suite covering all production paths and review edge cases |
