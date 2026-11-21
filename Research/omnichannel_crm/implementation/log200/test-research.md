# Test Research LOG-200

## Целевой новый PostgreSQL-спек
`packages/twenty-server/test/fork-migration/crm-audit-record-share-writers.postgres-spec.ts` (4 сценария, least-privilege runtime роль, строгий guard `FORK_MIGRATION_TEST_URL`):
1. `ShareWithService.insertRecordSharesForCreatedRecords`:
   - Внутри активного `withNativeCrmAuditTransaction` (`nativeAudit` scope): `crmRecord:create` + `recordShare:create` (и очистка orphan `recordShare:delete` при переиспользованном `recordId`) попадают в `crm_audit."crmAuditEntry"` под ОДНИМ `operationId` и одним `audit.flush()`.
   - В standalone строгой транзакции (`commitOutcome: 'strict'` без `nativeAudit`): аудит `recordShare:create` с атрибуцией `user` (+ имперсонация), `application` (`actingAgent` и без), `apiKey`, `system`.
   - Fail-closed на не-`strict` транзакции, на `deletedAt IS NOT NULL` в `recordShare`, на несовпадении `after` с `desiredShares` (несанкционированная вставка/эскалация `accessLevel`), и на конфликте `authContext` с ALS.
2. `WorkflowRunRecordShareService` (`updateAccessThenSyncRuns`, `syncRunsOfCoreWorkflows`, `syncRuns`):
   - Первичная синхронизация `WORKSPACE`-видимого workflow создаёт `EVERYONE/RULE/FULL` + `OWNER/FULL` под одним `operationId` с переданным `auditOperation`.
   - Повторная синхронизация без изменений - чистый idempotent no-op (`0` новых записей аудита, сохранение `id` строк).
   - Смена видимости `WORKSPACE -> PRIVATE` удаляет `EVERYONE/RULE` (и `APPLICATION` гранты), оставляя `OWNER/FULL` и нетронутым сторонний `MANUAL` грант с другим `sourceId`; в аудите только реальные `delete`.
   - Системная атрибуция в `SyncWorkflowRunSharesDeferredActionHandlerService` (`system:sync_workflow_run_shares`) и ALS/system fallback в `syncRuns`.
   - Ранняя валидация `auditOperation.workspaceId` даже при пустом списке `workflowRunIds`/`coreWorkflowIds`.
3. Инварианты и fail-closed проверки:
   - Отказ при повреждении не-управляемой строки (`MANUAL` не-`EVERYONE` с чужим `sourceId`) во время `replaceShares`.
   - Отказ при `deletedAt IS NOT NULL` в `replaceShares`.
   - Проверка `CommonCreateManyQueryRunnerService` передачи `{ commitOutcome: 'strict' }` при открытии транзакции для `shareWith`.
4. Атомарность и откат:
   - Откат `ShareWithService` (standalone и внутри `withNativeCrmAuditTransaction`) и `WorkflowRunRecordShareService.replaceShares` при сбое `audit.flush()` (триггер `BEFORE INSERT ON crm_audit."crmAuditEntry"`) и при post-flush row drift (триггер `AFTER INSERT ON crm_audit."crmAuditEntry"`).

## Связанные регрессионные спеки для таргетного прогона
- `packages/twenty-server/test/fork-migration/crm-audit-record-share-writers.postgres-spec.ts` (новый)
- `packages/twenty-server/test/fork-migration/crm-audit-record-share.postgres-spec.ts` (`LOG199`)
- `packages/twenty-server/test/fork-migration/crm-audit-core-workflow-and-view.postgres-spec.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-membership-cleanup.postgres-spec.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-public-update.postgres-spec.ts`
