# LOG169 - аудит смены владельца и видимости `coreWorkflow` и `coreView` и долговечное намерение `sync_workflowRunShares`

## 1. Область задачи

`LOG169` закрывает транзакционный аудит всех runtime-операций обновления владельца (`createdByUserWorkspaceId`) и видимости (`visibility`) для рабочих процессов в схеме `core` (`core.workflow` -> `coreWorkflow`) и представлений (`core.view` -> `coreView`), а также сохранение долговечного намерения пересчёта прав на запуски рабочего процесса (`sync_workflowRunShares` в `core."deferredWorkspaceMigrationAction"`) при смене видимости или захвате владения в `CoreWorkflowMutationWorkspaceService.updateWorkflowVisibility`.

К моменту `LOG169` обнуление `createdByUserWorkspaceId` (`ON DELETE SET NULL`) для `core.workflow` и `core.view` при удалении `core."userWorkspace"` уже закрыто в `membership-cleanup-audit.ts` (`LOG114`/`LOG115`). Прямое обновление `core.workflow` в `CoreWorkflowMutationWorkspaceService.updateWorkflowVisibility`, обновление видимости и владения `core.view` в `ViewService.updateOne` (`ViewResolver.updateView`, `ViewController.update`) и пакетные обновления `workflow`/`view` через `WorkspaceMigrationRunnerService` оставались неподключёнными к `crm_audit."crmAuditEntry"`.

## 2. Полная инвентаризация точек записи

### 2.1. `core.workflow` (`coreWorkflow`)
1. **Смена видимости и захват владения (`CoreWorkflowMutationWorkspaceService.updateWorkflowVisibility`)**:
   - Вызывается из `CoreWorkflowResolver.updateCoreWorkflowVisibility`.
   - Текущее поведение до `LOG169`:
     - Вызывает `coreWorkflowAccessService.assertCoreWorkflowsAreEditableOrThrow`.
     - Внутри `workflowRunRecordShareService.updateAccessThenSyncRuns` выполняет `coreWorkflowRepository.update(workspaceId, { id: coreWorkflowId, createdByUserWorkspaceId: Or(IsNull(), Equal(userWorkspaceId)) }, { visibility, createdByUserWorkspaceId: userWorkspaceId })`.
     - Не использует `runInCoreAuditTransaction`, не пишет событие `coreWorkflow:update` в `crm_audit."crmAuditEntry"`, не сохраняет долговечное намерение `sync_workflowRunShares` в `core."deferredWorkspaceMigrationAction"` до коммита (поэтому при сбое процесса или `replaceSharesOfAllRuns` после коммита `core.workflow` записи `_recordShares` для `workflowRun` остаются рассинхронизированными, например сохраняют `EVERYONE` после перевода в `UNLISTED`), вызывает `replaceSharesOfAllRuns` даже при `affected === 0` и не инвалидирует кэш `flatWorkflowMaps` в `finally`.
2. **Пакетные миграции метаданных (`UpdateWorkflowActionHandlerService` в `WorkspaceMigrationRunnerService`)**:
   - При синхронизации манифеста приложения (`ApplicationManifestMigrationService.syncMetadataFromManifest`) свойство `visibility` имеет `toCompare: true` и может сбрасываться обратно в `'WORKSPACE'` через действие `update_workflow`.
   - Любое действие `update_workflow`, затрагивающее `visibility` или `createdByUserWorkspaceId`, должно выполняться только внутри активного контекста аудита (`applicationMetadataAudit` или `coreWorkflowAndViewAudit`) и отклоняться fail-closed в `WorkspaceMigrationRunnerService.executeRun` при отсутствии контекста аудита.

### 2.2. `core.view` (`coreView`)
1. **Обновление видимости и захват владения представлением (`ViewService.updateOne`)**:
   - Вызывается из `ViewResolver.updateView`, `ViewController.update` и `UpdateViewTool.execute`.
   - В `fromUpdateViewInputToFlatViewToUpdateOrThrow` при переводе `visibility` из `'WORKSPACE'` в `'UNLISTED'` с определённым `userWorkspaceId` автоматически устанавливается `flatViewToUpdate.createdByUserWorkspaceId = userWorkspaceId` (даже если прежде `createdByUserWorkspaceId` был `null` или указывал на другого участника).
   - Выполнение проходит через `WorkspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration` -> `WorkspaceMigrationRunnerService.executeRun` -> `UpdateViewActionHandlerService.executeForMetadata`.
2. **Пакетные миграции метаданных (`ApplicationManifestMigrationService.syncMetadataFromManifest`, `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`)**:
   - Выполняются под `withApplicationMetadataAudit`; если действие `update_view` изменяет `visibility` или `createdByUserWorkspaceId`, изменение фиксируется как `coreView:update` в том же `CrmAuditTransactionContext`.
   - Любое неаудируемое действие `update_view`, содержащее `visibility` или `createdByUserWorkspaceId` в `action.update`, блокируется fail-closed барьером в `WorkspaceMigrationRunnerService.executeRun`.

## 3. Архитектура и модель данных аудита

### 3.1. Расширение каталога `CrmAuditTransactionContext`
В `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`:
- `CATALOG.coreWorkflow`:
  - `values: ['createdByUserWorkspaceId', 'visibility']`, `redacted: []`
- `CATALOG.coreView`:
  - `values: ['createdByUserWorkspaceId', 'visibility']`, `redacted: []`
- `ADMINISTRATIVE_ACTIONS`:
  - `coreWorkflow: ['update']`
  - `coreView: ['update']`
- Обратная совместимость с `membership-cleanup-audit.ts` (`LOG115`) полностью сохраняется: `membership-cleanup-audit.ts` передаёт снимки `{ createdByUserWorkspaceId }` без ключа `visibility`, а `capture()` в `crm-audit-transaction-context.ts` проверяет `Object.hasOwn(input, field)` и игнорирует отсутствующие ключи, формируя прежний `changedFields: ['createdByUserWorkspaceId']`.

### 3.2. Новый модуль `core-workflow-and-view-audit.ts`
Создаётся `packages/twenty-server/src/engine/core-modules/crm-audit/core-workflow-and-view-audit.ts`:
- Регистрируется в `registerMetadataAuditScopeCheck(getCoreWorkflowAndViewAudit)` для защиты от вложенных и конфликтующих контекстов аудита.
- `captureCoreWorkflowVisibilityAudit({ workspaceId, coreWorkflowId, userWorkspaceId, visibility, auditIdentity, runByVersion })`:
  - Синхронно (до первого `await`) валидирует UUID `workspaceId`, `coreWorkflowId`, `userWorkspaceId`, значение `visibility` (`'WORKSPACE' | 'UNLISTED'`) и захватывает `operation` из `auditIdentity` или ambient `captureCurrentCrmAuditOperation`.
- `runAuditedCoreWorkflowVisibilityUpdate(dataSource, request, work)`:
  - Внутри `runInCoreAuditTransaction` устанавливает `SET LOCAL lock_timeout = '8s'`.
  - Блокирует `core.workspace` (`FOR KEY SHARE`, проверяя `deletedAt IS NULL`) и `core."userWorkspace"` вызывающего участника (`FOR KEY SHARE`, проверяя принадлежность `workspaceId`, `deletedAt IS NULL` и совпадение `userId` с `operation.actor.id` для `coreUser`).
  - Блокирует строку `core.workflow` по `(id, workspaceId)` (`FOR NO KEY UPDATE OF w`) вместе с `core.application` (`LEFT JOIN`).
  - Если строка не найдена или `deletedAt !== null` - возвращает `{ status: 'not_found' }` без DML, без намерения `sync_workflowRunShares` и без записи аудита.
  - Если `before.createdByUserWorkspaceId !== null && before.createdByUserWorkspaceId !== request.userWorkspaceId` - возвращает `{ status: 'forbidden' }` без DML, без намерения `sync_workflowRunShares` и без записи аудита.
  - Иначе вызывает `await work(runner)`, повторно читает строку `core.workflow` и проверяет постусловия (`createdByUserWorkspaceId === request.userWorkspaceId`, `visibility === request.visibility`, `deletedAt === null`).
  - Если изменился `createdByUserWorkspaceId` или `visibility`:
    1. Вставляет долговечное намерение `sync_workflowRunShares` (`payload: { version: 1, coreWorkflowId }`, `status: 'PENDING'`, `attempts: 0`) в `core."deferredWorkspaceMigrationAction"` (при наличии таблицы и валидного `applicationUniversalIdentifier` в `workspaceId`) и проверяет созданную строку.
    2. Разрешает `initiator` через `resolveRoleAuditInitiator` и записывает `coreWorkflow:update` в `CrmAuditTransactionContext`.
    3. Вызывает `audit.flush()` и повторно сверяет строку `core.workflow` и намерение `sync_workflowRunShares` после `audit.flush()`.
  - Если ни `createdByUserWorkspaceId`, ни `visibility` не изменились (идемпотентный повтор владельцем с той же видимостью) - не создаёт шумовой записи аудита и лишнего намерения `sync_workflowRunShares`, возвращая `{ status: 'updated', changed: false }`.
- `captureCoreViewUpdateAudit`, `withCoreViewUpdateAudit`, `runAuditedCoreViewUpdate`:
  - Синхронно захватывает контекст аудита для обновления представления.
  - В `WorkspaceMigrationRunnerService.executeRun` при активном `coreViewUpdateAudit` выполняет миграцию внутри `runAuditedCoreViewUpdate`:
    - Блокирует `core.workspace` (`FOR KEY SHARE`), `core."userWorkspace"` (если `userWorkspaceId` задан, `FOR KEY SHARE`) и целевую строку `core.view` (`FOR NO KEY UPDATE`, проверяя `workspaceId` и `deletedAt IS NULL`).
    - Проверяет, что при переводе в `'UNLISTED'` итоговый `createdByUserWorkspaceId` не равен `null` (и совпадает с `request.userWorkspaceId`, если `visibility` меняется с `'WORKSPACE'` на `'UNLISTED'`).
    - После выполнения `work(runner)` сверяет сохранённое состояние `core.view`, записывает `coreView:update` при фактическом изменении `createdByUserWorkspaceId` или `visibility`, вызывает `audit.flush()` и повторно сверяет снимок `core.view` после `audit.flush()`.

### 3.3. Обработка `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError`
- В `CoreWorkflowMutationWorkspaceService.updateWorkflowVisibility`:
  - При `NativeTransactionOutcomeUnknownError` или `CoreAuditPostCommitError` транзакция в БД уже могла закоммититься (видимость и владелец `core.workflow` изменены, намерение `sync_workflowRunShares` сохранено в `core."deferredWorkspaceMigrationAction"`). Перед повторным пробросом ошибки best-effort ставятся в очередь отложенные действия (`enqueueDeferredWorkspaceMigrationActions`) и вызывается `workflowRunRecordShareService.syncRunsOfCoreWorkflows` в защищённом `try / catch`, а в `finally` безусловно инвалидируется кэш `flatWorkflowMaps`.
- В `WorkspaceMigrationRunnerService.executeRun`:
  - При ошибке в `runAuditedCoreViewUpdate` кэш `flatViewMaps` (и связанных карт) безусловно инвалидируется в `finally`.
