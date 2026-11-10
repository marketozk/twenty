# LOG180 - Независимое ревью дизайна (`logicFunction`)

## Вердикт
`pass` (блокеров не выявлено)

## Проверенные аспекты

| Линза | Результат | Детали |
|---|---|---|
| Полнота схемы и проекции `logicFunction` | `pass` | Все сравниваемые свойства `LogicFunctionEntity` (`all-entity-properties-configuration-by-metadata-name.constant.ts:700-790`: `name`, `description`, `timeoutSeconds`, `checksum`, `sourceHandlerPath`, `builtHandlerPath`, `handlerName`, `isBuildUpToDate`, `executionMode`, `cronTriggerSettings`, `databaseEventTriggerSettings`, `httpRouteTriggerSettings`, `serverRouteTriggerSettings`, `toolTriggerSettings`, `workflowActionTriggerSettings`), неизменяемый `runtime` и `applicationId` включены в `projectLogicFunction` (`values: ['applicationId', 'runtime', 'timeoutSeconds', 'isBuildUpToDate', 'executionMode']`, `redacted: ['name', 'description', 'sourceHandlerPath', 'builtHandlerPath', 'handlerName', 'checksum', 'cronTriggerSettings', 'databaseEventTriggerSettings', 'httpRouteTriggerSettings', 'serverRouteTriggerSettings', 'toolTriggerSettings', 'workflowActionTriggerSettings']`). |
| Покрытие всех входных путей и сайд-эффектов | `pass` | Охвачены все пути создания, обновления и удаления `core."logicFunction"`: `LogicFunctionFromSourceHelperService`, `LogicFunctionFromSourceService`, `LogicFunctionResolver`, `PrefillLogicFunctionService`, `createUpdateLogicFunctionSourceTool`, `CodeStepBuildService`, `WorkflowVersionStepOperationsWorkspaceService`, каскадное удаление `CODE`-функций при удалении `workflow` / `workflowVersion` (`WorkflowCoreSyncService.deleteFromCore`, `CoreWorkflowMutationWorkspaceService.discardDraftVersion`), `ApplicationManifestMigrationService.syncPreInstallLogicFunctionFromManifest` и `syncMetadataFromManifest`, `ApplicationSyncService.uninstallApplication` и `assertNoRemainingApplicationRoleOrPermissionMetadata`. |
| Защита от удаления `core.application` при живых `logicFunction` | `pass` | `assertNoRemainingApplicationRoleOrPermissionMetadata` проверяет наличие строк `core."logicFunction"` с `applicationId = application.id` до удаления `core.application`, исключая тихий `ON DELETE CASCADE`. |
| Изоляция от `@license Enterprise` | `pass` | Затронутые файлы не импортируют модули `@license Enterprise` и не добавляют новых зависимостей от `twenty-shared/utils`. |
