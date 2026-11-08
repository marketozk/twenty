# Независимое ревью реализации LOG169

Дата: 08.11.2026
Задача: ROB-765 (`LOG169` - транзакционный аудит смены владельца и видимости `coreWorkflow` и `coreView` и долговечное намерение `sync_workflowRunShares`)
Вердикт: `pass`

## 1. Полнота охвата точек записи

Проверены все обращения к `core.workflow` (`createdByUserWorkspaceId`, `visibility`) и `core.view` (`createdByUserWorkspaceId`, `visibility`):

- `CoreWorkflowMutationWorkspaceService.updateWorkflowVisibility` (вызывается из `CoreWorkflowResolver.updateCoreWorkflowVisibility`) переведён на `runAuditedCoreWorkflowVisibilityUpdate`:
  - синхронно до первого `await` захватывает и валидирует входные параметры и идентичность аудита (`captureCoreWorkflowVisibilityAudit`);
  - требует транзакционный репозиторий `coreWorkflowRepository.withManager(runner.manager)` (M5);
  - при фактическом изменении `createdByUserWorkspaceId` или `visibility` атомарно в одной транзакции `runInCoreAuditTransaction` сохраняет долговечное намерение `sync_workflowRunShares` в `core."deferredWorkspaceMigrationAction"`, записывает `coreWorkflow:update` (`metadataAccess: 'currentWorkspaceAdministration'`) и повторно проверяет состояние строки `core.workflow` и намерения после `audit.flush()`;
  - после успешного синхронного пересчёта шар в `updateAccessThenSyncRuns` удаляет выполненное `PENDING` намерение через `completeWorkflowRunShareReconciliationIntent`, а при сбое пересчёта шар или неопределённом коммите намерение остаётся в `core."deferredWorkspaceMigrationAction"` для фонового повтора (M3);
  - при идемпотентном вызове без фактических изменений (`changed === false`) пропускает лишний пересчёт шар, не создаёт дублирующих намерений и не пишет шумовой аудит (T1);
  - при отсутствии рабочего процесса (`not_found`) возвращает `null` без вызова `replaceSharesOfAllRuns`, а при попытке не-автора изменить видимость (`forbidden`) выбрасывает `WorkflowQueryValidationException(FORBIDDEN)` до вызова `replaceSharesOfAllRuns`.
- `ViewService.updateOne` (вызывается из `ViewResolver.updateView`, `ViewController.update` и `UpdateViewTool.execute`) интегрирован с `captureCoreViewUpdateAudit` и `withCoreViewUpdateAudit`:
  - при наличии `visibility` во входном запросе идентичность проверяется синхронно до первого `await`;
  - при изменении `visibility` или `createdByUserWorkspaceId` выполнение `validateBuildAndRunWorkspaceMigration` оборачивается в `withCoreViewUpdateAudit` и обрабатывается в `WorkspaceMigrationRunnerService.executeRun` через `runAuditedCoreViewUpdate`;
  - обновление обычных UI-полей (`name`, `icon` и др.) без изменения `visibility` и `createdByUserWorkspaceId` не порождает шумовых событий `coreView:update`.
- `runAuditedApplicationMetadataMigration` (`application-metadata-audit.ts`) и `WorkspaceMigrationRunnerService.executeRun`:
  - блокируют и снимают полные снимки `core.workflow` и `core.view` во всех миграциях приложений, отвергая любые незапланированные изменения `visibility` или `createdByUserWorkspaceId` (M2);
  - при запланированном обновлении `visibility` или `createdByUserWorkspaceId` записывают `coreWorkflow:update` (вместе с долговечным намерением `sync_workflowRunShares` и постановкой в очередь `deferredWorkspaceMigrationActionRunnerService.enqueue(workspaceId)`) и `coreView:update`;
  - в `WorkspaceMigrationRunnerService.executeRun` установлен fail-closed барьер (`isAuditedWorkflowOrViewUpdateAction`), отклоняющий любые неаудируемые миграции `update_workflow` и `update_view`, затрагивающие `visibility` или `createdByUserWorkspaceId`.

## 2. Устранённые замечания ревью (M1-M5, T1-T2)

- **M1 (привязка субъекта `workspaceMember` и `coreUser` к `userWorkspaceId`)**: в `verifyActiveWorkspaceAndMembership` проверено, что вызывающий субъект является пользовательским (`coreUser` или `workspaceMember`), для `coreUser` `actor.id === membership.userId`, а для `workspaceMember` запись в `"workspace_<id>"."workspaceMember"` активна (`deletedAt IS NULL`) и имеет `userId === membership.userId`. Подмена чужого `userWorkspaceId` при своём `workspaceMemberId` блокируется fail-closed.
- **M2 (полный контроль `core.workflow` и `core.view` в `runAuditedApplicationMetadataMigration`)**: снимки `beforeWorkflows`/`afterWorkflows` и `beforeViews`/`afterViews` снимаются безусловно при наличии таблиц `core.workflow` и `core.view`; проверяются все строки рабочего пространства на отсутствие незапланированных изменений `visibility` и `createdByUserWorkspaceId`, а также валидируется инвариант `visibility IN ('WORKSPACE', 'UNLISTED')` и наличие владельца у `UNLISTED`.
- **M3 (жизненный цикл намерения `sync_workflowRunShares`)**: в `updateWorkflowVisibility` после успешного `updateAccessThenSyncRuns` выполненное `PENDING` намерение очищается через `completeWorkflowRunShareReconciliationIntent`, а при сбое остаётся для фонового обработчика; в `WorkspaceMigrationRunnerService.executeRun` при обновлении видимости рабочего процесса вызывается `deferredWorkspaceMigrationActionRunnerService.enqueue(workspaceId)` (в том числе best-effort при `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`).
- **M4 (проверка прав владельца в `runAuditedCoreViewUpdate`)**: внутри транзакции под `FOR NO KEY UPDATE` проверяется, что изменение `visibility`/`createdByUserWorkspaceId` или редактирование `UNLISTED` представления выполняется аутентифицированным `userWorkspaceId`, совпадающим с текущим владельцем `beforeCreatedBy` (если он задан), а также безусловно сверяются `afterVisibility === expectedVisibility` и `afterCreatedBy === expectedCreatedBy`.
- **M5 (запрет нетранзакционного fallback репозитория)**: в `CoreWorkflowMutationWorkspaceService.updateWorkflowVisibility` отсутствие `coreWorkflowRepository.withManager` вызывает немедленный fail-closed отказ внутри транзакции.
- **T1 / T2 (пропуск пересчёта шар на no-op и расширение PostgreSQL-тестов)**: на идемпотентном повторе `updateWorkflowVisibility` пересчёт шар не вызывается; в `crm-audit-core-workflow-and-view.postgres-spec.ts` добавлены проверки отказа при рассинхронизации `workspaceMember` / `coreUser` и `userWorkspaceId`, очистки `sync_workflowRunShares` после синхронного пересчёта, отказа при захвате чужого представления и отказа при незапланированной мутации `core.workflow` в миграции приложения.
