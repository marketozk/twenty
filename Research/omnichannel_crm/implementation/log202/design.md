# LOG-202 Design: Transactional Audit of Public Physical Record Deletion (`DESTROY_ONE` / `DESTROY_MANY`)

## Goal
Connect the public CRM physical deletion query runners (`CommonDestroyOneQueryRunnerService` and `CommonDestroyManyQueryRunnerService` - serving GraphQL `destroyOne`/`destroyMany`, REST `RestApiDestroyOneHandler`/`RestApiDestroyManyHandler`, and record CRUD/AI tools `DeleteRecordService(soft: false)`) to the existing transactional native CRM audit boundary (`withNativeCrmAuditTransaction` / `WorkspaceRepository.performMutation('delete')` from `LOG-105..108`) for covered objects (`company`, `person`, `opportunity`, and custom objects).

## Background & Existing Infrastructure
- `WorkspaceRepository.runMutation` / `performMutation('delete')` (`workspace-repository.ts:1905-2295`) already implements full fail-closed physical delete auditing when executed inside `withNativeCrmAuditTransaction`:
  - `validateWriteIsPermitted` (including `canDestroyObjectRecords`) and `applyRowLevelPermissionPredicates(selectQueryBuilder, 'delete')`;
  - `buildEventSnapshotQueryBuilder` (with `.withDeleted()`, covering both live and already soft-deleted records) -> `lockNativeWriteRows` (`SELECT * ... ORDER BY id FOR UPDATE`) -> `readNativeCrmAuditRows`;
  - `findOmniProtectedParentIds` (`OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND` unless an explicit detached-parent grant matches);
  - `assertNativeCrmDeleteFilesEmpty` (refuses physical deletion of records or CASCADE children with linked `FILES`, keeping `FilesFieldDeletionListener` side-effect free);
  - `prepareNativeCrmDeleteEffects` (inspects `pg_constraint` incoming FKs; audits direct `ON DELETE SET NULL` on covered objects as `update` with strict all-column postcondition and direct `ON DELETE CASCADE` on covered objects as `delete`; refuses uncovered child tables, self-referencing FKs, composite FKs, `RESTRICT`/`NO ACTION`/`SET DEFAULT`, and transitive FK chains before DML);
  - `recordNativeCrmDeletes` with `securityDescriptor: { resourceKind: 'crmRecord', resourceId, objectMetadataId, deletedRecord: { access: 'currentWorkspaceAdministration' } }`, atomic rollback of DB writes + events + `releaseRecordStock` on audit failure, and `NativeTransactionOutcomeUnknownError` without retry on lost `COMMIT` ACK.
- However, `CommonBaseQueryRunnerService.executeQueryAndEnrichResults` (`common-base-query-runner.service.ts:340-390`) excluded `CommonQueryNames.DESTROY_ONE` and `CommonQueryNames.DESTROY_MANY`, leaving public physical deletion completely outside `withNativeCrmAuditTransaction`.

## Surgical Changes

### 1. `CommonBaseQueryRunnerService` (`common-base-query-runner.service.ts`)
- Add `CommonQueryNames.DESTROY_ONE` and `CommonQueryNames.DESTROY_MANY` to `auditedMutation` (for objects matching `isNativeCrmAuditObject(...) || isNativeCrmAuditMetadata(...)`, i.e., `company`, `person`, `opportunity`, and custom objects).
- For `auth.type === 'system'`, assign explicit `systemActorId: 'crm-api-destroy'` for `DESTROY_ONE` and `DESTROY_MANY` (preserving `'crm-api-update'`, `'crm-api-create'`, `'crm-api-lifecycle'` for existing operations).
- When `queryRunnerContext.transactionScope` is already provided, route through `runInExistingNativeCrmAuditScope(queryRunnerContext.transactionScope, auth, ...)` (reusing the proven native audit `operationId` and failing closed on any unproven/external `transactionScope` including `standaloneShareWithScope`).
- When no `transactionScope` is provided, open `this.workspaceOrmManager.runInWorkspaceTransaction((transactionScope) => prepareAndRun({ ...queryRunnerContext, transactionScope }), { nativeAudit: { operationId: randomUUID(), ... } })`.

### 2. `CommonDestroyManyQueryRunnerService` (`common-destroy-many-query-runner.service.ts`)
- Pass `repository: queryRunnerContext.repository` to `this.processNestedRelationsHelper.processNestedRelations(...)` (matching `CommonDeleteManyQueryRunnerService:77`, `CommonRestoreManyQueryRunnerService:77`, and `CommonUpdateManyQueryRunnerService:78`) so nested relation reads inside `destroyOne`/`destroyMany` execute on the same transaction connection rather than opening an external pool connection.

### 3. `CommonDestroyOneQueryRunnerService` (`common-destroy-one-query-runner.service.ts`)
- Harden `validate(args, queryRunnerContext)` without adding new edges into Enterprise-reachable modules (`check_enterprise_dependencies.py --verify-baseline` rejects importing `assertMutationNotOnRemoteObject` / `assertIsValidUuid` into `common-destroy-one-query-runner.service.ts` because their transitive graphs reach Enterprise-licensed files):
  - reject `queryRunnerContext.flatObjectMetadata.isRemote` with `CommonQueryRunnerException('Remote objects are read-only', INVALID_QUERY_INPUT, { userFriendlyMessage: msg\`Remote objects are read-only.\` })`;
  - keep existing `if (!isDefined(args.id))` -> `CommonQueryRunnerException('Missing id', INVALID_QUERY_INPUT)`;
  - reject `!isValidUuid(args.id)` (from `twenty-shared/utils`) with `CommonQueryRunnerException(\`Value "${args.id}" is not a valid UUID\`, INVALID_QUERY_INPUT, { userFriendlyMessage: msg\`Invalid UUID format.\` })`.

### 4. `DeleteRecordService` (`delete-record.service.ts`)
- Rethrow `NativeTransactionOutcomeUnknownError` inside `DeleteRecordService.execute`'s `catch (error)` block instead of converting it to `{ success: false }`, so callers never mistake an unknown post-`COMMIT` outcome for a clean rollback failure.

### 5. `CommonDestroyOne` / `CommonDestroyMany` Non-Covered Objects & Error Semantics
- Non-covered standard/system objects (`dashboard`, `workspaceMember`, `workflow`, `workflowVersion`, `blocklist`, etc.) remain unaffected (`auditedMutation === false`), preserving their existing pre-query hooks and behavior.
- Unmatched `destroyOne` throws `RECORD_NOT_FOUND` inside the transaction, rolling back cleanly with `0` audit rows. Unmatched `destroyMany` commits with `0` deleted rows and `0` audit rows.
- Permission denial (`canDestroyObjectRecords === false`), non-empty `FILES`, `OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND`, uncovered FK references, and transitive FK chains all fail closed before mutation with `0` audit rows and no post-query hooks / event emissions.

## Enterprise Boundary & Known Limitations
- Zero imports from `@license Enterprise` modules; `CommonBaseQueryRunnerService`, `CommonDestroyOneQueryRunnerService`, `CommonDestroyManyQueryRunnerService`, and `DeleteRecordService` already reside outside Enterprise boundaries.
- Known limitations kept out of scope for `LOG-202`:
  - **Uncovered standard FK child tables (`timelineActivity`, `noteTarget`, `taskTarget`, `attachment`, `favorite`, `messageParticipant`, `calendarEventParticipant`, `messageThreadTarget`, `calendarEventTarget`, `agentChatThreadTarget`, `messageListMember`)**: intentional Phase 2a fail-closed invariant - physical deletion of any `company`/`person`/`opportunity` row still referenced by these tables is refused (GraphQL `INTERNAL_SERVER_ERROR` / HTTP 500; REST HTTP `400` via `RestApiExceptionFilter` for non-`HttpException` errors, same as `NativeTransactionOutcomeUnknownError` on REST) until those child tables have audited delete/FK coverage; production hard-delete UX for records with timeline history is not claimed complete here.
  - **ALS `impersonator` / `viaApplication` / `correlationId` propagation in `CommonBaseQueryRunnerService` / `captureNativeCrmAuditOperation`**: shared limitation across all public native CRM mutations (`CREATE`/`UPDATE`/`DELETE`/`RESTORE`/`DESTROY`), tracked as a dedicated follow-up so `LOG-202` stays surgical.
  - `CommonMergeManyQueryRunnerService` (scheduled for `LOG-203`).
  - Physical deletion of records that carry non-empty `FILES` fields (still refused fail-closed until a durable audited file-deletion owner is implemented) and post-commit `person.DESTROYED` participant rematch listener queue jobs.
  - Polymorphic `recordShare` rows have no FK to object tables and are not mutated by `DESTROY_ONE`/`DESTROY_MANY` (existing Twenty behavior; no unaudited DML occurs; audit entries for destroyed records are protected by `deletedRecord: { access: 'currentWorkspaceAdministration' }` rather than stale `recordShare` grants).
