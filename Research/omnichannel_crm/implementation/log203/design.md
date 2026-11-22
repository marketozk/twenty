# LOG-203 Design: Transactional Audit of Public CRM Record Merge (`MERGE_MANY`)

## Goal
Connect public CRM record merging (`CommonMergeManyQueryRunnerService`, serving GraphQL `DirectExecutionService` / `MergeManyResolverFactory` and REST `RestApiMergeManyHandler`) to the transactional native CRM audit boundary (`withNativeCrmAuditTransaction` / `runInExistingNativeCrmAuditScope`) for covered objects (`company`, `person`, `opportunity`, custom objects with `duplicateCriteria`), ensuring that parent locking, record reads, related-record migration/soft-delete, physical deletion of merged duplicates, priority-record update, and nested relation reads all execute atomically inside one proven native audit transaction under a single `operationId`.

## Findings from Research & Design Review
1. `CommonBaseQueryRunnerService.executeQueryAndEnrichResults` (`common-base-query-runner.service.ts:340-398`) excludes `CommonQueryNames.MERGE_MANY` from `auditedMutation`.
2. `processedArgs.dryRun` is not frozen/captured before deciding `auditedMutation` vs `run()`, allowing a getter or hook mutation to flip `dryRun` from `true` to `false` and bypass `withNativeCrmAuditTransaction` (Blocker B1).
3. `CommonMergeManyQueryRunnerService.executeMergeWithinTransaction` (`common-merge-many-query-runner.service.ts:485`) unconditionally calls `this.workspaceOrmManager.runInWorkspaceTransaction(...)`, ignoring `queryRunnerContext.transactionScope`.
4. Under PostgreSQL `READ COMMITTED`, `fetchRecordsToMerge` runs an unlocked `SELECT` before `mergeRelatedRecordsIntoPriorityRecord` (child) and `delete` (parent), creating TOCTOU lost-update/child-insert windows and inverting lock order (`child -> parent` vs `DESTROY`'s `parent -> child`) (Major M1).
5. `mergeRelatedRecordsIntoPriorityRecord` reads child rows through `relatedRepository` (`select`-RLS filtered) without checking actual live child counts in the DB; a live child hidden by `select`-RLS would be silently `SET NULL`ed or physically `CASCADE`-deleted when `DELETE` runs through `prepareNativeCrmDeleteEffects` (Blocker B2).
6. `mergeRelatedRecordsIntoPriorityRecord` and `executeMergeWithinTransaction` do not verify mutation cardinality (`softDeleted.length === idsChunk.length`, `migrated.length === idsChunk.length`, `deletedRecords.length === idsToDelete.length`), allowing RLS `delete`/`update`/`soft-delete` mismatches or `BEFORE DELETE`/`BEFORE UPDATE` trigger skips to commit half-merged state.
7. `processNestedRelations` (`lines 149, 562`) does not pass `repository: queryRunnerContext.repository`, breaking transactional reads of just-migrated child relations.
8. `validate()` does not validate `Array.isArray(ids)`, string UUID elements (`isValidUuid`), duplicate IDs (case-insensitive), integer `conflictPriorityIndex`, or boolean `dryRun` (REST `RestApiMergeManyHandler` skips `assertMergeManyArgs`, Major M4), and uppercase UUIDs in `args.ids` break lowercase `record.id` matching in `run()` (Major M2).
9. `getRelationFieldsPointingToCurrentObject` does not filter inactive/remote child objects (`isActive: false`, `isRemote: true`) or sort relation fields deterministically, and `relatedRecordsOfRecordsToDelete` lacks deterministic `id` ordering before deduplication and chunking (Minor m1, m2).

## Surgical Changes

### 1. `CommonBaseQueryRunnerService` (`common-base-query-runner.service.ts`)
- For `CommonQueryNames.MERGE_MANY`, snapshot `const isMergeDryRun = this.operationName === CommonQueryNames.MERGE_MANY && Boolean((processedArgs as MergeManyQueryArgs).dryRun);` once, and pass a shallow copy `{ ...processedArgs, dryRun: isMergeDryRun }` into `this.run(...)` so `auditedMutation` and `CommonMergeManyQueryRunnerService.run` observe the exact same boolean `dryRun` value (closes B1).
- Include `CommonQueryNames.MERGE_MANY` in `auditedMutation` when `!isMergeDryRun` AND `(isNativeCrmAuditObject(...) || isNativeCrmAuditMetadata(...))`.
  - When `isMergeDryRun === true`: read-only preview (`auditedMutation === false`, no write transaction, `0` audit entries).
  - When `!isMergeDryRun` and `queryRunnerContext.transactionScope` is supplied: route through `runInExistingNativeCrmAuditScope(queryRunnerContext.transactionScope, auth, () => prepareAndRun(queryRunnerContext))` (reuses proven `operationId`; fails closed and poisons on plain external scope, `standaloneShareWithScope`, shallow copy, expired scope, wrong actor, or wrong `workspaceId`).
  - When `!isMergeDryRun` and no `transactionScope` is supplied: open `this.workspaceOrmManager.runInWorkspaceTransaction((transactionScope) => prepareAndRun({ ...queryRunnerContext, transactionScope }), { nativeAudit: { operationId: randomUUID(), ... } })`.
- For `auth.type === 'system'` and `this.operationName === CommonQueryNames.MERGE_MANY`, assign explicit `systemActorId: 'crm-api-merge'`.

### 2. `CommonMergeManyQueryRunnerService` (`common-merge-many-query-runner.service.ts`)
- **Normalize IDs (M2)**:
  - Normalize `const normalizedIds = args.ids.map((id) => id.toLowerCase())` at the start of `run()` so uppercase UUIDs match PostgreSQL lowercase `record.id` consistently across sorting, priority selection, `idsToDelete`, and `FOR UPDATE`.
- **Single transactional scope + fail-closed defense-in-depth (B1)**:
  - Keep `args.dryRun === true` read-only without opening a write transaction (still passing `repository: queryRunnerContext.repository` to `processNestedRelationsHelper.processNestedRelations`).
  - For `!args.dryRun`:
    - If `isDefined(queryRunnerContext.transactionScope)`: execute the entire merge (`FOR UPDATE` lock -> `fetchRecordsToMerge` -> `performDeepMerge` -> `mergeRelatedRecordsIntoPriorityRecord` -> `delete` -> `resolveNestedRelations` -> `update` -> `processNestedRelations`) inside `queryRunnerContext.transactionScope`.
    - If `!isDefined(queryRunnerContext.transactionScope)`: check `isNativeCrmAuditObject(...) || isNativeCrmAuditMetadata(...)`; if covered, throw `Error('Public CRM merge requires a proven native audit scope')` fail-closed (never fall back to an unaudited transaction for covered objects). Only uncovered objects without an outer scope fall back to `this.workspaceOrmManager.runInWorkspaceTransaction(...)`.
- **Parent-first `ORDER BY id FOR UPDATE` lock (M1)**:
  - Inside the non-`dryRun` transaction, before `fetchRecordsToMerge` and before `mergeRelatedRecordsIntoPriorityRecord`, acquire row locks in canonical order:
    `SELECT id FROM <schema>.<table> WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE` via `transactionScope.executeRawQuery`.
  - Eliminates TOCTOU lost updates and blocks concurrent child FK `INSERT`/`UPDATE` (`FOR KEY SHARE`) against `idsToDelete` while aligning lock order (`parent -> child`) with `DESTROY_ONE`/`DESTROY_MANY`.
- **Transactional nested relation reads**:
  - Pass `repository` (`objectRepository` inside the merge transaction; `queryRunnerContext.repository` in `dryRun`) to `this.processNestedRelationsHelper.processNestedRelations(...)`, so post-merge nested relations observe uncommitted migrations/updates on the same connection without calling `workspaceOrmManager.getRepository`.
- **Deterministic & safe relation field traversal (m1, m2)**:
  - Filter `getRelationFieldsPointingToCurrentObject` to exclude `objMetadata.isRemote` and inactive child objects (`resolveEffectiveFlatEntityProperty({ metadataName: 'objectMetadata', flatEntity: objMetadata, property: 'isActive' })`).
  - Sort `relationFields` deterministically by `(objectMetadata.nameSingular, joinColumnName)`.
  - Sort `relatedRecordsOfRecordsToDelete` by `id` (`a.id.localeCompare(b.id)`) before `splitRelatedRecordIdsToMigrateAndSoftDelete` and chunking.
- **`select`-RLS hidden live child guard (B2)**:
  - In `mergeRelatedRecordsIntoPriorityRecord`, after `relatedRepository.createQueryBuilder(...).getMany()` succeeds (preserving object-level `PERMISSION_DENIED`), compare `relatedRecordsOfRecordsToDelete.length` against actual live DB row count via `transactionScope.executeRawQuery`:
    `SELECT COUNT(*)::int AS count FROM <schema>.<relatedTable> WHERE <joinColumn> = ANY($1::uuid[]) [AND "deletedAt" IS NULL]`.
  - If `actualCount > relatedRecordsOfRecordsToDelete.length` (or for `priorityRecordId` when `relatedRecordsOfRecordsToDelete.length > 0 && duplicateKeyColumnGroups.length > 0`, `actualPriorityCount > relatedRecordsOfPriorityRecord.length`), throw `CommonQueryRunnerException('Cannot merge records with inaccessible related records', RECORD_NOT_FOUND)` to roll back the entire merge before any `SET NULL` / `CASCADE` or duplicate-key violation can occur.
- **Self-referencing relation hygiene (M3)**:
  - For any self-referencing relation (`relationField.objectMetadata.id === flatObjectMetadata.id`), if `mergedData[joinColumnName]` points to one of `idsToDelete`, clear it to `null` before updating `priorityRecordId` so the update cannot re-point `priorityRecordId` to a deleted duplicate; note that PostgreSQL self-referencing FKs with remaining references to `idsToDelete` remain fail-closed in `prepareNativeCrmDeleteEffects` (`LOG-106`, `childTable === parentTable`).
- **Fail-closed mutation cardinality checks**:
  - Assert `softDeleted.length === idsChunk.length`, `migrated.length === idsChunk.length`, and `deletedRecords.length === idsToDelete.length`; any mismatch throws `CommonQueryRunnerException(..., RECORD_NOT_FOUND)` and rolls back the entire transaction.
- **Input validation hardening (`validate`, M4)**:
  - Require `Array.isArray(ids)` and `ids.length >= 2` and `ids.length <= MUTATION_MAX_MERGE_RECORDS`.
  - Require every element of `ids` to be `typeof id === 'string' && isValidUuid(id)` (imported from `twenty-shared/utils`, `0` new Enterprise edges).
  - Reject duplicate IDs (case-insensitive Set) with `CommonQueryRunnerException('Duplicate record IDs are not allowed for merge', INVALID_QUERY_INPUT)`.
  - Require `Number.isInteger(conflictPriorityIndex)` and `0 <= conflictPriorityIndex < ids.length`.
  - Require `dryRun === undefined || typeof args.dryRun === 'boolean'` (`CommonQueryRunnerException('Invalid dryRun flag', INVALID_QUERY_INPUT)`).

## Enterprise Boundary & Known Limitations
- Zero new imports from `@license Enterprise` modules: `isValidUuid` is imported from `twenty-shared/utils`; `isNativeCrmAuditObject`/`isNativeCrmAuditMetadata`, `computeTableName`, and `getWorkspaceSchemaName` have zero Enterprise edges (verified by `check_enterprise_dependencies.py --verify-baseline`).
- **Intentional Phase 2a fail-closed invariant for uncovered standard FK child tables (M5)**:
  - Real workspaces attach standard child tables (`timelineActivity`, `noteTarget`, `taskTarget`, `attachment`, `favorite`, `messageParticipant`, `calendarEventParticipant`, `messageThreadTarget`, `calendarEventTarget`, `agentChatThreadTarget`, `messageListMember`) to `company`/`person`/`opportunity`. When a merged duplicate (`idsToDelete`) has live or soft-deleted rows in any uncovered child table, `MERGE_MANY` intentionally fails closed (GraphQL `INTERNAL_SERVER_ERROR` / REST HTTP `400` via `RestApiExceptionFilter`) rather than silently mutating or deleting uncovered rows without audit. Existing GraphQL integration suites that call `waitForTimelineActivities` (`companies-merge-many.integration-spec.ts`, `people-merge-many.integration-spec.ts`) fall under this Phase 2a invariant until those child tables have audited coverage; production merge UX for records with timeline history is not claimed complete here.
- Other known limitations kept out of scope for `LOG-203`:
  - Self-referencing PostgreSQL FKs with remaining references to `idsToDelete` fail closed in `prepareNativeCrmDeleteEffects` (`LOG-106`).
  - Pre-existing `performDeepMerge` lookup uses `fieldIdByName` without `fieldIdByJoinColumnName` (unchanged in `LOG-203`).
  - ALS `impersonator` / `viaApplication` / `correlationId` propagation in `CommonBaseQueryRunnerService` / `captureNativeCrmAuditOperation` (shared across all public CRM mutations).
  - Remaining `record-crud` services masking `NativeTransactionOutcomeUnknownError`.
  - Durable audited `FILES` hard-delete owner and `recordShare` merge/cleanup semantics.
