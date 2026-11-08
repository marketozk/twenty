# LOG169 - план проверок PostgreSQL (`crm-audit-core-workflow-and-view.postgres-spec.ts`)

## Целевые сценарии

1. **Захват владения и смена видимости рабочего процесса без автора (`createdByUserWorkspaceId: null` -> `userWorkspaceId`, `'WORKSPACE'` -> `'UNLISTED'`)**:
   - `CoreWorkflowMutationWorkspaceService.updateWorkflowVisibility` (и `CoreWorkflowResolver.updateCoreWorkflowVisibility`) захватывает владение и переводит процесс в `'UNLISTED'`, записывает в одной транзакции событие `coreWorkflow:update` (`changedFields: ['createdByUserWorkspaceId', 'visibility']`), сохраняет долговечное намерение `sync_workflowRunShares` в `core."deferredWorkspaceMigrationAction"`, ставит задачу в очередь, пересчитывает шары запусков и инвалидирует `flatWorkflowMaps`.
2. **Смена видимости существующим владельцем (`'UNLISTED'` -> `'WORKSPACE'`) и идемпотентный повтор**:
   - Когда `createdByUserWorkspaceId` уже равен `userWorkspaceId`, смена `visibility` записывает `coreWorkflow:update` только с `changedFields: ['visibility']` и создаёт намерение `sync_workflowRunShares`.
   - Повторный вызов с тем же `visibility` и тем же владельцем является идемпотентным: не создаёт дублирующей записи в `crm_audit."crmAuditEntry"` и не плодит лишних строк `sync_workflowRunShares`.
3. **Отказ по правам (`FORBIDDEN`) и отсутствие процесса (`null`) без побочных эффектов**:
   - Попытка другого участника изменить видимость чужого рабочего процесса (`createdByUserWorkspaceId !== userWorkspaceId`) выбрасывает `WorkflowQueryValidationException(FORBIDDEN)` без изменения строки `core.workflow`, без записи в `crm_audit."crmAuditEntry"`, без намерения `sync_workflowRunShares` и без вызова `replaceSharesOfAllRuns`.
   - Вызов для несуществующего `coreWorkflowId` возвращает `null` без записи в аудит и без намерения `sync_workflowRunShares`.
4. **Отказоустойчивость при `CoreAuditPostCommitError` и `NativeTransactionOutcomeUnknownError` в `updateWorkflowVisibility`**:
   - При сбое post-commit проверки (`CoreAuditPostCommitError`) или неизвестном исходе коммита (`NativeTransactionOutcomeUnknownError`) вызываются best-effort `enqueueDeferredWorkspaceMigrationActions`, `workflowRunRecordShareService.syncRunsOfCoreWorkflows` и инвалидация `flatWorkflowMaps`, а ошибка пробрасывается вызывающему коду без маскирования.
5. **Смена видимости и захват владения представлением (`ViewService.updateOne`, `ViewResolver.updateView`, `ViewController.update`) через `WorkspaceMigrationRunnerService`**:
   - Перевод представления из `'WORKSPACE'` (с `createdByUserWorkspaceId: null`) в `'UNLISTED'` устанавливает `createdByUserWorkspaceId = userWorkspaceId` и `visibility = 'UNLISTED'` и записывает `coreView:update` (`changedFields: ['createdByUserWorkspaceId', 'visibility']`).
   - Обратный перевод `'UNLISTED'` -> `'WORKSPACE'` тем же владельцем записывает `coreView:update` (`changedFields: ['visibility']`).
   - Обновление несвязанных UI-полей представления (`name`, `icon`) без изменения `visibility` и `createdByUserWorkspaceId` проходит штатно и не создаёт шумовых записей `coreView:update`.
6. **Пакетная синхронизация манифеста (`runAuditedApplicationMetadataMigration`) и fail-closed барьер `WorkspaceMigrationRunnerService`**:
   - Обновление `visibility` или `createdByUserWorkspaceId` для `workflow` и `view` внутри `withApplicationMetadataAudit` записывает `coreWorkflow:update` и `coreView:update` в общей транзакции миграции.
   - Прямой вызов `WorkspaceMigrationRunnerService.run` с действием `update_workflow` или `update_view`, затрагивающим `visibility` или `createdByUserWorkspaceId`, без активного контекста аудита отклоняется fail-closed (`Workspace migration touching role or permission metadata requires an active CRM audit scope`) до открытия транзакции БД.
