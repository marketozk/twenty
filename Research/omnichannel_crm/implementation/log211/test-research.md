# LOG-211: Test Research (Revised after Design Review)

## 1. Real paths to verify against PostgreSQL 17

1. **Metadata coverage & fail-closed gate**:
   - `isNativeCrmAuditMetadata` returns `true` for standard `dashboard` metadata.
   - Direct `dashboardRepository.insert/update/delete` outside `runInWorkspaceTransaction` fails closed with zero DB changes.
   - Forged (non-WeakSet) `nativeAuditBinding` passed to `runInWorkspaceTransaction` fails closed with `Untrusted native audit binding`.
   - `nativeAuditBinding` combined with non-system `authContext` or with `nativeAudit` fails closed.
2. **Standard CRUD + Branch A `ShareWithService`**:
   - `CommonCreateMany` (`OPEN` + `shareWith`) commits `crmRecord:create` + `recordShare:create` atomically under one `operationId`.
   - `CommonUpdateMany` (title / position) records exact `before`/`after` snapshot.
   - `CommonDeleteMany` (soft-delete) and `CommonRestoreMany` (restore).
   - `CommonDestroyMany` with attached `attachment` (referencing `core.file`) and `timelineActivity`:
     - `crmRecord:delete` (`dashboard`),
     - `crmRecord:delete` (`attachment`, `ON DELETE CASCADE`),
     - `crmFile:update` + `delete_filesFieldFiles` intent for the attachment's file,
     - `crmRecord:update` (`timelineActivity`, `targetDashboardId` `ON DELETE SET NULL`),
     - all under one `operationId`.
   - `CommonMergeMany` merging two dashboards with `attachment` and `timelineActivity` re-parenting.
   - `TrashCleanupService` hard-deleting an expired soft-deleted dashboard (including cascading `attachment` + `FILES` and `timelineActivity` `SET NULL`) under `systemActorId: 'trash_cleanup'`.
   - Post-rollback `denied` (`PermissionsException`) and `failed` attempts on CRUD.
3. **`DashboardDuplicationService.duplicateDashboard`**:
   - Success with authenticated `user` `authContext` inside `withCrmAuditRequest`: duplicates layout and inserts `dashboard` with `crmRecord:create`, preserving `correlationId` and `impersonatorUserWorkspaceId` (when impersonated).
   - Success with `system` `authContext`: attributes to `system:dashboard-duplication:duplicate`.
   - `PermissionsException` (no insert permission or missing `rolePermissionConfig`): records post-rollback `denied` attempt and does NOT duplicate `pageLayout`.
   - `DASHBOARD_NOT_FOUND`: throws `DashboardException` and does NOT write a bogus `create` attempt.
   - Insert DB failure: rolls back `dashboard`, records single post-rollback `failed` attempt (no double-recording), and destroys duplicated `pageLayout` with `isLinkedDashboardAlreadyDestroyed: true`.
   - `NativeTransactionOutcomeUnknownError`: skips both post-rollback DB attempt and compensating `pageLayoutService.destroy`.
4. **`createCreateCompleteDashboardTool`**:
   - Success with `{ auth: userAuth, agentId }` (no `application`) inside `withCrmAuditRequest`: creates `dashboard` attributed to `{ kind: 'agent', id: agentId }`, initiator `{ kind: 'workspaceMember', id }`, inheriting request `correlationId`.
   - Impersonated `withCrmAuditRequest` + `{ auth: userAuth, agentId }`: fails closed BEFORE `pageLayoutService.create` (`Native audit impersonation cannot combine with agent or application`).
   - Cross-user `withCrmAuditRequest` (User A) + `{ auth: userBAuth, agentId }`: fails closed BEFORE `pageLayoutService.create` (`Native audit ambient user conflict`).
   - Success with `auditIdentity: { user: { id } }` (no `workspaceMemberId`) and with `authUserWorkspaceId`-only: attributes to `coreUser` (or `agent` + `coreUser` when `agentId` is set).
   - Success with `auditIdentity: undefined` outside ALS: attributes to `system:dashboard-tool:create-complete-dashboard`.
   - Unsupported explicit `auditIdentity` (`pendingActivationUser` or bare `agentId`): fails closed BEFORE `pageLayoutService.create` (zero metadata mutations, zero dashboard rows).
   - DB failure on insert: records post-rollback `failed` attempt and destroys `pageLayout` with `isLinkedDashboardAlreadyDestroyed: true`.
   - `NativeTransactionOutcomeUnknownError`: skips `pageLayoutService.destroy` and skips post-rollback DB attempt.
5. **`DashboardSyncService.updateLinkedDashboardsUpdatedAtByPageLayoutId`**:
   - Updates linked dashboard `updatedAt` in audited transaction (`system:dashboard-sync:update-linked-dashboards`), inheriting ambient `correlationId` from `withCrmAuditRequest`.
   - Zero dashboards matching `pageLayoutId`: commits cleanly with zero audit rows.
   - Transaction error: logs error without throwing AND records post-rollback `failed` attempt inside workspace context.
6. **`PageLayoutService.destroy` -> `destroyAssociatedDashboards`**:
   - Real HTTP Express `RequestLikeAuditIdentity` (`{ user: { id }, workspaceMemberId, application, impersonationContext }`) inside `withCrmAuditRequest` (standard user + OAuth client + impersonated user): destroys layout and associated dashboard(s) atomically with cascading `attachment` (+ `FILES`) and `timelineActivity` `SET NULL`, matching actor and `correlationId`.
   - `authUserWorkspaceId`-only identity: resolves `coreUser` from `core."userWorkspace"` (no silent downgrade to `system`).
   - Invalid dashboard audit identity (e.g. cross-user conflict with ambient `withCrmAuditRequest`): fails closed BEFORE `validateBuildAndRunWorkspaceMigration` so `core.pageLayout` is NOT orphaned/deleted.
   - Transaction error during `destroyAssociatedDashboards`: records post-rollback `failed` attempt inside workspace context and rethrows.
   - `isLinkedDashboardAlreadyDestroyed: true`: skips `destroyAssociatedDashboards`.

## 2. Verification gates

- Targeted unit tests: `packages/twenty-server/src/modules/dashboard/tools/__tests__/create-complete-dashboard.tool.spec.ts`
- Targeted PG 17 suites on Schrodinger:
  - `test/fork-migration/crm-audit-dashboard.postgres-spec.ts`
  - `test/fork-migration/crm-audit-custom-record.postgres-spec.ts`
  - `test/fork-migration/crm-audit-note-task.postgres-spec.ts`
  - `test/fork-migration/crm-audit-fk-delete-effects.postgres-spec.ts`
- Differential TypeScript typecheck on Schrodinger (`ES2022` target, `lib.es2022.d.ts` + `lib.dom.d.ts`).
- Local guards:
  - `python -I -X utf8 scripts/omnichannel/check_enterprise_dependencies.py --verify-baseline`
  - `python -I -X utf8 scripts/omnichannel/check_fork_migration_sources.py`
  - `python -I -X utf8 -m unittest discover -s scripts/omnichannel -v`
- Full PG 17 regression on Schrodinger (all `148` suites in `test/fork-migration/`).
