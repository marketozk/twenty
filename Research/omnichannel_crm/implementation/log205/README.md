# LOG-205 - Transactional audit and durable hard-delete owner for covered CRM `FILES`

## Scope
Closes the `File hard-delete` row in `rob765-progress.md` (`ROB-765`) for covered CRM records:
1. Extended `crmFile` audit descriptor validation in `crm-audit-transaction-context.ts` to support `crmFile:delete` (`before !== null, after === null`, exact `fileParent` + `deletedRecord: { access: 'currentWorkspaceAdministration' }`, preserving `appendCrmAuditAttempt` without snapshots and rejecting `deletedRecord` on `crmFile:update`).
2. Replaced the temporary `assertNativeCrmDeleteFilesEmpty` block in `workspace-repository.ts` and `native-crm-audit-delete-effects.ts` with transactional `prepareNativeCrmDeleteFiles` (`native-crm-audit-files.ts`): single canonical `ORDER BY id FOR UPDATE` lock across parent and `ON DELETE CASCADE` children, strict eligibility checks (`UPLOADED`, `files-field/...`, `isTemporaryFile === false`, `toDelete === false`, valid UUID `applicationId`), `BEFORE DELETE` trigger skip verification, `crmFile:update` retirement under the same `operationId`, and atomic persistence of one durable `delete_filesFieldFiles` intent in `core."deferredWorkspaceMigrationAction"`.
3. Added deterministic fail-closed `MERGE_MANY` `FILES` guards (`CommonMergeManyQueryRunnerService`): refuses transferring duplicate `FILES` onto a priority record without files (both live and `dryRun: true`) and refuses shared `fileId` across priority and duplicates (including when hidden by `restrictedFields`).
4. Implemented the durable post-commit hard-delete owner (`files-field-hard-delete-audit.ts`, `DeleteFilesFieldFilesDeferredActionHandlerService`, `DeferredWorkspaceMigrationActionHandlerRegistryService`, `FilesFieldService`, `FilesFieldModule`): atomic claim (`IN_PROGRESS`, monotonic `attempts` fencing token, `MAX_ATTEMPTS`, `FAILED`), idempotent storage deletion (`FILE_NOT_FOUND`), strict `runInCoreAuditTransaction` (`DELETE FROM core.file` + `crmFile:delete` + atomic intent cursor advancement/deletion), `isTransactionUnsafeToRetry` fencing (`payload.unsafeOutcome`), inactive workspace cleanup, and post-commit `releaseStorageStock`.
5. Updated `FilesFieldDeletionListener` (routes retired audited files and `CASCADE`-only pending intents to `workspaceQueue` while preserving `FilesFieldDeletionJob` for un-audited active files such as `TrashCleanupService`, and skips malformed/non-UUID `fileId` entries without breaking the batch) and hardened `FilesFieldDeletionJob` + `FilesFieldService.deleteFilesFieldFile` for idempotent retries without silently swallowing errors.

## Changed Files
- `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-transaction.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/files-field-hard-delete-audit.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-files.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-delete-effects.ts`
- `packages/twenty-server/src/engine/twenty-orm/repository/workspace-repository.ts`
- `packages/twenty-server/src/engine/api/common/common-query-runners/common-merge-many-query-runner.service.ts`
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/types/deferred-workspace-migration-action-name.type.ts`
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/types/deferred-workspace-migration-action.type.ts`
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/deferred-action-handlers/services/delete-files-field-files-deferred-action-handler.service.ts`
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/registry/deferred-workspace-migration-action-handler-registry.service.ts`
- `packages/twenty-server/src/engine/core-modules/file/files-field/services/files-field.service.ts`
- `packages/twenty-server/src/engine/core-modules/file/files-field/files-field.module.ts`
- `packages/twenty-server/src/engine/core-modules/file/files-field/listeners/files-field-deletion.listener.ts`
- `packages/twenty-server/src/engine/core-modules/file/files-field/jobs/files-field-deletion.job.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-file-hard-delete.postgres-spec.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-native-delete.postgres-spec.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-delete-set-null.postgres-spec.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-public-destroy.postgres-spec.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-public-merge.postgres-spec.ts`

## Artifacts
- [design.md](design.md)
- [design-review.md](design-review.md)
- [test-research.md](test-research.md)
- [review.md](review.md)
- [results.json](results.json)
- [source-snapshot.json](source-snapshot.json)
- [next-boundary.md](next-boundary.md)
