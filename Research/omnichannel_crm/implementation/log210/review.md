# LOG-210 Code Review

## Verdict

- Independent adversarial code review: `NEEDS_REVISION` (0 Blocker, 2 Major, 3 Minor).
- All 5 findings resolved and re-verified against real PostgreSQL 17, differential `typecheck`, and Enterprise/migration guards: `PASS`.

## Findings and Resolutions

### Major

1. **Unchunked `In(targetIds)` in `NotePostQueryHookService` / `TaskPostQueryHookService` risks hitting PostgreSQL 65,535 bind parameter limit**
   - Files: `packages/twenty-server/src/modules/note/query-hooks/note-post-query-hook.service.ts`, `packages/twenty-server/src/modules/task/query-hooks/task-post-query-hook.service.ts`
   - Resolution: Chunk `targetIds` in batches of `1000` inside the single `runInNativeCrmTargetLifecycleScope` transaction, preserving atomicity, single `operationId`, and database batch events while preventing bind-parameter overflow on high fan-out `deleteMany`/`restoreMany`.
2. **Test coverage gaps in `crm-audit-note-and-task.postgres-spec.ts`**
   - File: `packages/twenty-server/test/fork-migration/crm-audit-note-and-task.postgres-spec.ts`
   - Resolution: Added real PG 17 regressions for:
     - `CREATE_ONE` on `note` under `apiKey` (Branch A `ROLE` `recordShare` + `crmRecord:create` under one `operationId`) and on `task` under `system` (`0` `recordShare` rows + `crm-api-create`),
     - mixed `UPSERT` (`createMany` with `upsert: true`) updating an existing `note` and inserting a new `note` with Branch A `recordShare` under one `operationId`,
     - end-to-end real `ShareWithService` Branch A on an `OPEN` `company` with explicit `shareWith`,
     - `DELETE_MANY` / `RESTORE_MANY` on `note` (including a targetless note producing `0` target audit rows) and `system`-actor hook execution (`note-targets-post-query-hook`),
     - non-audit DB error inside `TaskPostQueryHookService` (temporary `BEFORE UPDATE` trigger) rolling back `taskTarget` and recording a post-rollback `failed` attempt (`resourceId = taskTarget` objectMetadataId, `actor = task-targets-post-query-hook`).

### Minor

1. **Prototype property lookup in `WorkspaceOrmManager.getObjectMetadataId`**
   - File: `packages/twenty-server/src/engine/twenty-orm/workspace-orm.manager.ts`
   - Resolution: Guarded lookup with `Object.hasOwn(objectIdByNameSingular, nameSingular)`.
2. **Validate `workspace.id` as UUID before `uuidToBase36` in post-query hooks**
   - Files: `note-post-query-hook.service.ts`, `task-post-query-hook.service.ts`
   - Resolution: Added explicit `typeof workspace.id !== 'string' || !isValidUuid(workspace.id)` check immediately after `assertIsDefinedOrThrow`.
3. **Read active `getWorkspaceContext().authContext` in test harness `runInWorkspaceTransaction`**
   - File: `packages/twenty-server/test/fork-migration/crm-audit-note-and-task.postgres-spec.ts`
   - Resolution: Updated harness `manager` to build `WorkspaceDataSource` from `getWorkspaceContext().authContext` matching production `WorkspaceOrmManager` behavior.

## Post-Fix Verification

- Targeted PG 17 suites: 13/13 PASS, 269/269 tests (re-run of `crm-audit-note-and-task.postgres-spec.ts`: 4/4 PASS in 12.644 s).
- Differential typecheck: `pass-no-new-diagnostics` (`baselineRootFiles: 416`, `currentRootFiles: 417`, `baselineDiagnostics: 150`, `currentDiagnostics: 150`, `0` new/changed-file/changed-code).
- Guards: `check_enterprise_dependencies.py --verify-baseline` PASS (`0` violations, `34820` code files, `21468` runtime files, `138028` edges), `10` fork migration sources verified, Python guard tests OK (`26` passed, `7` Linux-only startup entrypoint tests skipped on Windows).
