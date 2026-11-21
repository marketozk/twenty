# Design LOG-200: транзакционный аудит `ShareWithService` и `WorkflowRunRecordShareService` (`recordShare`)

## 1. Цель и границы участка
Закрыть транзакционный аудит оставшихся `WorkspaceTransactionScope` / `RecordShareStorageService` писателей таблицы `workspace_*."recordShare"`:
1. **Создание шаров вместе с записями (`ShareWithService` + `CommonCreateManyQueryRunnerService` + `CommonBaseQueryRunnerService`)**:
   - `ShareWithService.insertRecordSharesForCreatedRecords` (`@license Enterprise` сохраняется)
   - `CommonCreateManyQueryRunnerService.run` (`:177`): открывать `{ commitOutcome: 'strict' }` для обеих ветвей (`isDefined(resolveShareWithToWrite(...)) || containsNestedRelationCreate(...)`) и оборачивать выполнение в `runInStandaloneShareWithScope(transactionScope, ...)`.
   - `CommonBaseQueryRunnerService.executeQueryAndEnrichResults` (`:333`): исключить `isStandaloneShareWithScope(queryRunnerContext.transactionScope)` из ветки `createCandidate` (сохраняя `isNativeAuditCreateEligible` и все внешние strict-транзакции без изменений).
   - `native-crm-audit-transaction.ts`: добавить `runInStandaloneShareWithScope` / `isStandaloneShareWithScope` и безопасный хелпер `runInNativeCrmAuditScopeIfPresent(scope, auth, work)` с error latching (`runNativeCrmAuditWrite`), проверкой `workspaceId`/актора и `postFlushChecks` после `await audit.flush()`.
   - `build-record-share-inputs-for-created-records.util.ts` и `validate-share-with-arg-or-throw.util.ts` (`@license Enterprise` сохраняются): регистронезависимое сравнение UUID (`principalId`, `creatorRoleId`).
2. **Синхронизация шаров запусков рабочих процессов (`WorkflowRunRecordShareService` и callers)**:
   - `WorkflowRunRecordShareService` (`updateAccessThenSyncRuns`, `syncRunsOfCoreWorkflows`, `syncRuns`, `replaceShares`) с поддержкой `auditOperation?: CrmAuditOperation` и `auditImpersonatorUserWorkspaceId?: string`.
   - `CoreWorkflowMutationWorkspaceService.updateWorkflowVisibility` (`:810`, `:887`): пробрасывает `auditOperation: auditRequest.operation` и `auditImpersonatorUserWorkspaceId: auditRequest.impersonatorUserWorkspaceId`.
   - `UserWorkspaceService.deleteUserWorkspace` (`:571`): пробрасывает `auditOperation` (либо `system:membership_cleanup_workflow_run_share_sync` при отсутствии) и оборачивает best-effort вызов в `try/catch` с `this.logger.error(...)`, не срывая post-commit очистку (durable-интенты уже закоммичены).
   - `SyncWorkflowRunSharesDeferredActionHandlerService.execute` (`:54`): проверяет `!queryRunner.isTransactionActive`, расширяет inline-интерфейс опциональным `auditOperation?: CrmAuditOperation` (без Enterprise-импорта) и передаёт `system:sync_workflow_run_shares`.

### Явно вне границ LOG-200 (остаётся для LOG-201)
- `AgentHistoryRepository` (`EntityManager` / SQL CTE) писатели `recordShare` для чатов ИИ (`AgentChatSharingService`, `AgentChatChannelGrantService`, `RewriteAgentChatChannelGrantsJob`, `backfillWorkspaceChatThreadOwnerGrants`, `buildAgentChatThreadParticipantOwnerShareInsert`).
- Dev-seeder и one-off upgrade commands (`2-43`..`2-46`).

## 2. Граница Enterprise
- `record-share-audit.ts` не импортирует Enterprise-модули (`record-share/*`, `twenty-orm/types/workspace-transaction-scope.type`, `twenty-shared/constants`, `twenty-shared/utils`, `workspace-auth-context.type`).
- `record-share-audit.ts` импортирует `runInNativeCrmAuditScopeIfPresent` из `native-crm-audit-transaction.ts` (подтверждено 0 Enterprise-рёбер).
- Все маркеры `/* @license Enterprise */` сохраняются.

## 3. Контур 1: `ShareWithService` -> `runAuditedShareWithInsert`
- Валидация до `execute()`:
  - `executor = createCrmAuditWorkspaceExecutor(scope)` (проверяет `commitOutcome === 'strict'` и совпадение `workspaceId`).
  - Валидация `authContext` (отклоняется `pendingActivationUser` и невалидные UUID), `objectMetadataId`, `recordIds` (нормализация, дедупликация, сортировка) и `desiredShares` (принадлежность к `objectMetadataId` и `recordIds`, валидные enum, отсутствие конфликтов `accessLevel`/`principalType` по 5-кортежу `(objectMetadataId, recordId, principalId, rowCause, sourceId)`).
  - При `recordIds.length === 0` ранний возврат после валидации `scope` и `authContext`.
- **Ветка A (внутри `withNativeCrmAuditTransaction`, через `runInNativeCrmAuditScopeIfPresent`)**:
  - Выполняется под `runNativeCrmAuditWrite` (error latching `binding.failure`), сверяет `workspaceId` и актора (и отклоняет несогласованную имперсонацию/ALS).
  - `core.workspace FOR KEY SHARE` (без AB-BA дедлока после уже выполненного `INSERT` в целевую таблицу).
  - `before` snapshot `ORDER BY id FOR UPDATE` без фильтра `deletedAt` (`deletedAt !== null` -> fail-closed) -> `await execute()` -> `after` snapshot -> проверка полного удаления `before` (запрет `update`) и точного совпадения мультимножества `after` с дедуплицированным `desiredShares` -> запись `delete`/`create` через `record(...)`.
  - Регистрирует `postFlushCheck`: `SET CONSTRAINTS ALL IMMEDIATE`, повторная проверка `core.workspace` и повторный снимок `recordShare` сразу после централизованного `await audit.flush()` в `withNativeCrmAuditTransaction`.
- **Ветка B (standalone строгая транзакция, без `withNativeCrmAuditTransaction`)**:
  - Атрибуция из `authContext` (`user` со сверкой ALS / имперсонацией / `application`/`viaApplication` / `agentId`; `application` -> `actingAgent` или `application`, не путая token `agentId`; `apiKey` -> `apiKey`; `system` -> `system:share_with_create`).
  - Общий `correlationId` для множественных вызовов в рамках одного standalone `scope` кэшируется в `WeakMap<object, string>`.
  - `SET LOCAL lock_timeout = '8s'`, `core.workspace FOR KEY SHARE`, разрешение `impersonatorUserWorkspaceId` в `core."userWorkspace"`.
  - Снимки `before`/`after` и инварианты идентичны Ветке A; при `recordedMutations > 0` выполняются `await audit.flush()`, `SET CONSTRAINTS ALL IMMEDIATE`, повторная проверка `core.workspace` и пост-flush сверка снимка `recordShare`.

## 4. Контур 2: `WorkflowRunRecordShareService` -> `runAuditedWorkflowRunShareSync`
- Валидация `workspaceId`, `auditOperation` (совпадение `workspaceId`), `auditImpersonatorUserWorkspaceId` выполняется до ранних возвратов (даже при пустом списке `workflowRunIds`/`coreWorkflowIds`).
- `replaceShares`:
  - Нормализует и дедуплицирует `workflowRunIds`, `objectMetadataId`, `creatorWorkspaceMemberId` к lowercase.
  - Открывает `runInWorkspaceTransaction(..., { commitOutcome: 'strict' })` (default `nativeOwnershipLock: 'shared'`).
  - Порядок блокировок: `nativeOwnershipLock(shared)` -> `SET LOCAL lock_timeout = '8s'` -> `core.workspace FOR NO KEY UPDATE` -> разрешение `impersonatorUserWorkspaceId` (если есть) -> `before` snapshot `ORDER BY id FOR UPDATE` без фильтра `deletedAt`.
  - **Diff-preserving idempotent sync**:
    - Управляемые строки `before`: `batchSet.has(sourceId) || rowCause === 'APPLICATION' || principalType === 'EVERYONE'`.
    - Неуправляемые строки (`preservedUnmanaged`): не трогаются; в `after` проверяется точное совпадение `Map<id, proj>`.
    - Среди управляемых строк сохраняется не более 1 строки на каждый 7-кортеж из `desiredShares`; остальные управляемые строки удаляются чанками по `1000` (`deleteMatching([{ id: In(chunk) }])`, только при `idsToDelete.length > 0`).
    - Недостающие кортежи `desiredShares` вставляются через `insertMany`.
    - При `0` удалений и `0` вставок: `0` DML и `0` записей в `crm_audit`.
  - В `after`: `update` запрещён; неуправляемые строки идентичны `before`; мультимножество управляемых строк точно равно `desiredShares`.
  - Строгий fail-closed `await audit.flush()`, `SET CONSTRAINTS ALL IMMEDIATE`, повторная проверка `core.workspace` и пост-flush сверка снимка `recordShare` (без `SAVEPOINT`, так как durable recovery `sync_workflowRunShares` безопасно повторит задачу при откате).
