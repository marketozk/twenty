# LOG-210 Design (Revised after Design Review)

## Goal and Scope

Expand native transactional CRM audit coverage (`AUDITED_OBJECTS` in `native-crm-audit-record.ts`) to `note` and `task`, enable Branch A `ShareWithService` atomic auditing on covered `INHERITED`/`PRIVATE`/`shareWith` creates in `CommonCreateManyQueryRunnerService.isNativeAuditCreateEligible`, and move `NotePostQueryHookService` and `TaskPostQueryHookService` (`noteTarget` / `taskTarget` soft-delete and restore) onto strict audited transactions with preserved database batch events.

Out of scope for `LOG-210`:
- `dashboard` (separate direct writers `DashboardDuplicationService` and `createCreateCompleteDashboardTool` plus `pageLayout` cross-DB correlation).
- `workflow` (synchronized with `core.workflow`; remains the standard uncovered `isSystem: false` object for negative fail-closed tests).
- Direct arbitrary writes on `noteTarget` / `taskTarget` outside the explicit FK delete-effect, merge-child, and target-lifecycle grants.
- Database schema changes / fork migrations (none; all 10 fork migrations stay unchanged).

## Architecture and Design Decisions

### 1. Adding `note` and `task` to `AUDITED_OBJECTS` and Enabling Branch A on `CREATE` (B1)

- `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-record.ts`:
  - Add `note: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.note` and `task: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.task` to `AUDITED_OBJECTS`.
- `packages/twenty-server/src/engine/api/common/common-query-runners/common-create-many-query-runner/common-create-many-query-runner.service.ts`:
  - Remove the obsolete pre-Branch-A `resolveShareWithToWrite(...) !== null` rejection from `isNativeAuditCreateEligible`. Because `note` and `task` have `MetadataReadability.INHERITED`, `resolveObjectSharing` always returns `RecordSharingMode.INHERITED` and `resolveShareWithToWrite` always returns an array (`[]`), which previously bypassed `withNativeCrmAuditTransaction` and dropped `crmRecord:create` audit entries. With `ShareWithService` Branch A (`runAuditedShareWithInsert` -> `runDelegatedRecordShareWrite`) already implemented in LOG-200/LOG-204, all covered `CREATE_ONE`/`CREATE_MANY`/`UPSERT` (including `INHERITED`, `PRIVATE`, and explicit `shareWith`) now audit both `crmRecord:create` and `recordShare:create` atomically under a single `operationId`.
  - Uncovered objects (`workflow`, `dashboard`, etc.) remain `isNativeCrmAuditMetadata === false` and keep standalone Branch B (`runInStandaloneShareWithScope`).

### 2. Least-Privilege `runInNativeCrmTargetLifecycleScope` (Minor 1)

- `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-transaction.ts`:
  - Add `NativeCrmTargetLifecycleGrant = Readonly<{ objectMetadataId: string; kind: 'soft-delete' | 'restore' }>`, `targetLifecycleScopes` `WeakMap`, `getNativeCrmTargetLifecycleScope`, and `runInNativeCrmTargetLifecycleScope`.
  - Enforce mutual exclusion between `targetLifecycleScopes`, `mergeChildScopes`, and `delegatedRecordShareExecutors` on `binding.executor`; require proven `nativeAudit` scope, normalize `objectMetadataId` via `uuid(...)`, validate `kind`, clear in `finally`.
- `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-record.ts`:
  - In `assertNativeCrmAuditWriteSupported` (`isCoveredFkChild`), allow `targetLifecycleGrant` ONLY when:
    - `metadata.nameSingular === 'noteTarget' || metadata.nameSingular === 'taskTarget'`
    - `targetLifecycleGrant.objectMetadataId === metadata.id.toLowerCase()`
    - `targetLifecycleGrant.kind === kind`
    - `definedEntries.length === 0`
    - `shape.columnShapeByColumnName.deletedAt?.fieldMetadataType === 'DATE_TIME'`

### 3. Auditing `NotePostQueryHookService` and `TaskPostQueryHookService` Without New Enterprise Edges or Event Loss (B2, B3, M1, M2)

- `packages/twenty-server/src/engine/twenty-orm/workspace-orm.manager.ts`:
  - Add `getObjectMetadataId(nameSingular: string): string | undefined` reading `getWorkspaceContext().objectIdByNameSingular[nameSingular]` so hooks do NOT import `orm-workspace-context.storage.ts` (which is in `reaches_enterprise`, keeping Enterprise violations at `0`).
- `packages/twenty-server/src/modules/note/query-hooks/note-post-query-hook.service.ts` and `packages/twenty-server/src/modules/task/query-hooks/task-post-query-hook.service.ts`:
  - If `!payload || payload.length === 0`, return early.
  - For non-empty `payload`, validate every item has a valid UUID `id` (fail closed on malformed `id`, deduplicate to `parentIds`).
  - Inside `this.workspaceOrmManager.executeInWorkspaceContext(..., authContext)`:
    - Resolve `targetObjectMetadataId = this.workspaceOrmManager.getObjectMetadataId('noteTarget' | 'taskTarget')`; fail closed if missing.
    - Build `nativeAuditOptions` (`operationId: randomUUID()`, plus `systemActorId: 'note-targets-post-query-hook' | 'task-targets-post-query-hook'` when `authContext.type === 'system'`) and capture `binding = captureNativeCrmAuditBinding(workspace.id, authContext, nativeAuditOptions)` before the transaction.
    - Inside `this.workspaceOrmManager.runInWorkspaceTransaction(async (transactionScope) => { ... }, { nativeAudit: nativeAuditOptions })`:
      1. Select and lock only transitioning rows in canonical order via `transactionScope.executeRawQuery`:
         - soft-delete: `SELECT id FROM "${schemaName}"."noteTarget" WHERE "noteId" = ANY($1::uuid[]) AND "deletedAt" IS NULL ORDER BY id FOR UPDATE`
         - restore: `SELECT id FROM "${schemaName}"."noteTarget" WHERE "noteId" = ANY($1::uuid[]) AND "deletedAt" IS NOT NULL ORDER BY id FOR UPDATE`
         (and symmetrically for `taskTarget` / `"taskId"`).
      2. Validate returned IDs as UUIDs; if empty, return without mutating or writing audit entries.
      3. Acquire `targetRepository = transactionScope.getRepository('noteTarget' | 'taskTarget', { shouldBypassPermissionChecks: true })` and run `targetRepository.softDelete({ id: In(targetIds) })` or `targetRepository.restore({ id: In(targetIds) })` inside `runInNativeCrmTargetLifecycleScope(...)`.
         Filtering by `id: In(targetIds)` avoids placing `deletedAt IS NULL`/`IS NOT NULL` into `eventSelectQueryBuilder`, preserving `DELETED`/`RESTORED` database batch events while locking transitioning rows under `FOR UPDATE`.
    - On error, call `recordPostRollbackNativeCrmAuditAttempt` with `{ action: 'update', resourceId: targetObjectMetadataId, objectMetadataId: targetObjectMetadataId, binding, error }` and rethrow.
  - Note on correlation / `afterCommit`: under HTTP/job ALS (`withCrmAuditRequest` / `withCrmAuditIdentity`), parent and target transactions share the same `correlationId`; without outer ALS, they run as two separate transactions without correlation. Under an inherited `transactionScope`, `executePostQueryHooks` runs in `transactionScope.afterCommit`, where `recordPostRollbackNativeCrmAuditAttempt` executes before rethrowing.

### 4. Updating Existing Tests (Minor 2 + B1)

- Replace `task` with `workflow` as the uncovered standard object in 7 existing PG specs (`crm-audit-custom-record`, `crm-audit-native-company`, `crm-audit-native-lifecycle`, `crm-audit-public-destroy`, `crm-audit-public-merge`, `crm-audit-public-update`, `crm-audit-fk-delete-effects-coverage`), adding `'workflow'` to `additionalTables` where needed.
- Update the 3 pre-Branch-A `isNativeAuditCreateEligible` / child `shareWith` assertions in `crm-audit-public-update.postgres-spec.ts` to reflect Branch A support on covered objects.
