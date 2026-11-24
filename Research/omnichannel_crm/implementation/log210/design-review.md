# LOG-210 Design Review

## Verdict

- Independent adversarial design review: `NEEDS_REVISION` (3 Blocker, 2 Major, 2 Minor).
- All 7 findings addressed in the revised [design.md](design.md) before implementation.

## Findings and Resolutions

### Blocker

1. **B1 - Silent `nativeAudit` bypass on all `CREATE_ONE` / `CREATE_MANY` / `UPSERT` for `note` and `task`**
   - Root cause: `note` and `task` have `MetadataReadability.INHERITED`, so `resolveObjectSharing` always returns `RecordSharingMode.INHERITED` and `resolveShareWithToWrite` always returns an array (`[]`, never `null`). The obsolete pre-Branch-A check `resolveShareWithToWrite(...) !== null` in `CommonCreateManyQueryRunnerService.isNativeAuditCreateEligible` therefore returned `false` for every `note`/`task` create, routing them to standalone Branch B without `crmRecord:create` audit.
   - Resolution: Remove `resolveShareWithToWrite(...) !== null` from `isNativeAuditCreateEligible` so covered `INHERITED`/`PRIVATE`/`shareWith` creates use `withNativeCrmAuditTransaction` + `ShareWithService` Branch A atomically, and update the 3 pre-Branch-A tests in `crm-audit-public-update.postgres-spec.ts`.
2. **B2 - Enterprise dependency guard failure from importing `orm-workspace-context.storage.ts` into note/task hooks**
   - Root cause: `orm-workspace-context.storage.ts` is in `reaches_enterprise` (imports Enterprise RLS map types); importing `getWorkspaceContext` into `NotePostQueryHookService` / `TaskPostQueryHookService` would add 2 new edges into `enterprise_edges`.
   - Resolution: Add `WorkspaceOrmManager.getObjectMetadataId(nameSingular: string): string | undefined` (`workspace-orm.manager.ts` already imports `getWorkspaceContext` in baseline) and resolve `targetObjectMetadataId` through `this.workspaceOrmManager` without importing `orm-workspace-context.storage.ts`.
3. **B3 - Silent suppression of `noteTarget`/`taskTarget` `DELETED` and `RESTORED` database batch events**
   - Root cause: Passing `deletedAt: IsNull()` / `Not(IsNull())` into `softDelete`/`restore` copies that predicate into `eventSelectQueryBuilder`, which runs again after `UPDATE` and returns `[]`, causing `formatTwentyOrmEventToDatabaseBatchEvent` to emit `undefined`.
   - Resolution: Inside the hook's `nativeAudit` transaction, select and lock only transitioning row IDs (`WHERE "noteId" = ANY($1::uuid[]) AND "deletedAt" IS NULL / IS NOT NULL ORDER BY id FOR UPDATE`) via `transactionScope.executeRawQuery`, return early if empty, and call `targetRepository.softDelete({ id: In(targetIds) })` / `restore({ id: In(targetIds) })`.

### Major

1. **M1 - Unspecified `recordPostRollbackNativeCrmAuditAttempt` target fields and `targetRepository` source**
   - Resolution: Explicitly use `action: 'update'`, `objectMetadataId: targetObjectMetadataId`, `resourceId: targetObjectMetadataId` (matching `deleteMany`/`restoreMany` semantics without cross-object ID corruption), and acquire `targetRepository` strictly from `transactionScope.getRepository(...)`.
2. **M2 - Malformed `payload` ID handling and correlation / `afterCommit` boundaries**
   - Resolution: Fail closed on any non-UUID `id` in a non-empty `payload` instead of silently dropping entries, and document correlation/afterCommit semantics in `design.md`.

### Minor

1. **Minor 1 - Mutual exclusion with `delegatedRecordShareExecutors`**
   - Resolution: Reject overlap across `targetLifecycleScopes`, `mergeChildScopes`, and `delegatedRecordShareExecutors` in `native-crm-audit-transaction.ts`.
2. **Minor 2 - Explicit `'workflow'` table setup in updated negative tests**
   - Resolution: Add `'workflow'` to `additionalTables` in `crm-audit-public-destroy.postgres-spec.ts` and `crm-audit-public-merge.postgres-spec.ts`, move `companyId` + `duplicateCriteria` to `workflow` in `crm-audit-public-merge`, and use `workflow` + `timelineActivity.targetWorkflowId` in `crm-audit-fk-delete-effects-coverage.postgres-spec.ts`.
