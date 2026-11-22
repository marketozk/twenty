# LOG-202 Code Review

Date: 2026-11-22
Reviewer: independent adversarial review agent (`a0ace45636fe1333e`)
Verdict: **PASS** (0 Blocker, 2 Major, 2 Minor - all resolved and re-verified)

## Verified Invariants
- `CommonBaseQueryRunnerService.executeQueryAndEnrichResults` routes `DESTROY_ONE` and `DESTROY_MANY` on covered objects (`company`, `person`, `opportunity`, custom objects) through `withNativeCrmAuditTransaction` (or `runInExistingNativeCrmAuditScope` when `transactionScope` is supplied) with explicit `systemActorId: 'crm-api-destroy'` for `system` auth.
- All public entry points (GraphQL `DirectExecutionService` / `DestroyOneResolverFactory` / `DestroyManyResolverFactory`, REST `RestApiDestroyOneHandler` / `RestApiDestroyManyHandler`, and `DeleteRecordService(soft: false)`) flow through `CommonDestroyOneQueryRunnerService` / `CommonDestroyManyQueryRunnerService` without audit bypasses or double auditing (`destroyOne.run` calls `destroyMany.run`, not `.execute`).
- `CommonDestroyManyQueryRunnerService` passes `repository: queryRunnerContext.repository` into `ProcessNestedRelationsHelper.processNestedRelations`, keeping nested relation reads on the active transactional connection.
- `DeleteRecordService.execute` rethrows `NativeTransactionOutcomeUnknownError` so lost `COMMIT` ACK is never masked as `{ success: false }`.
- Enterprise dependency boundary (`check_enterprise_dependencies.py --verify-baseline`) remains clean with `0` violations.

## Findings and Resolutions

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| R1 | Major | `CommonDestroyOneQueryRunnerService.validate` used manual checks with non-standard messages (`STANDARD_ERROR_MESSAGE`, `Invalid UUID: ...`) instead of matching `assertMutationNotOnRemoteObject` / `assertIsValidUuid` messages and documenting why those helpers cannot be imported directly. | Aligned error messages and `userFriendlyMessage` (`'Remote objects are read-only'`, `Value "${args.id}" is not a valid UUID`, `msg\`Invalid UUID format.\``) while preserving `isValidUuid` + `flatObjectMetadata.isRemote` to avoid adding Enterprise-reachable dependency edges rejected by `check_enterprise_dependencies.py --verify-baseline`; updated `design.md` and `design-review.md` accordingly. |
| R2 | Major | `crm-audit-public-destroy.postgres-spec.ts` had a no-op `CommonRecordVisibilityService` spy without a registered handler, omitted plain external `transactionScope` / wrong `workspaceId` / `RECORD_NOT_FOUND` outer poisoning / multi-row `destroyMany` (>= 2 rows) / happy-path `DeleteRecordService(soft: false)` / `CommonDestroyManyQueryRunnerService.validate` cases, and used broad `.rejects.toThrow()` / `.toBeInstanceOf(...)` assertions without checking error codes or post-condition DB state. | Registered a real `company` visibility handler asserting actual masking on nested records, added all missing test scenarios (plain external scope, wrong `workspaceId` poisoning, `RECORD_NOT_FOUND` outer poisoning, multi-row `destroyMany` with 2 records under 1 `operationId`, parent + CASCADE child `FILES`, `CASCADE`/`SET NULL`/`RESTRICT` uncovered FK child tables, happy-path `DeleteRecordService`, `CommonDestroyManyQueryRunnerService.validate`), and tightened assertions to exact error codes (`RECORD_NOT_FOUND`, `INVALID_QUERY_INPUT`, `PERMISSION_DENIED`), DB state, `releaseRecordStock` quantities, and audit payload fields. |
| R3 | Minor | `design.md` cited HTTP 500 for all fail-closed FK errors, whereas REST maps non-`HttpException` errors to HTTP `400` via `RestApiExceptionFilter`; `design-review.md` referenced `README.md` before creation. | Clarified GraphQL `INTERNAL_SERVER_ERROR` vs REST HTTP `400` in `design.md` and `design-review.md`. |
| R4 | Minor | `CommonDestroyManyQueryRunnerService.validate` does not reject empty `filter: {}` before opening a transaction (handled in `runFilteredMutation` via `isRecordFilterEmpty`, matching `CommonDeleteMany`/`UpdateMany`/`RestoreMany`). | Kept consistent with sibling `*Many` runners and added a regression test asserting empty `filter: {}` rejects with `0` audit rows. |

## Adjacent Observations (Out of Scope for LOG-202)
- Other `record-crud` services (`DeleteManyRecordsService`, `UpdateRecordService`, `UpdateManyRecordsService`, `CreateRecordService`, `CreateManyRecordsService`, `UpsertManyRecordsService`) still catch non-`RecordCrudException` errors and return `{ success: false }`; tracked for follow-up.
- `CommonMergeManyQueryRunnerService` is tracked as the next boundary (`LOG-203`).
