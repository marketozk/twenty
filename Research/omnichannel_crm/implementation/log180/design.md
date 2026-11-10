# LOG180 - Дизайн транзакционного аудита полного жизненного цикла серверных функций (`logicFunction`, `core."logicFunction"`)

## 1. Контекст и постановка задачи

После закрытия `LOG179` (`frontComponent` и `settingsMenuItem`) в контуре безопасности, исполняемого кода приложений и автоматизаций остаётся открытой поверхность серверных функций (`core."logicFunction"`, `LogicFunctionEntity`):
1. **Серверные функции (`core."logicFunction"`, `LogicFunctionEntity`)**:
   - Определяют исполняемый на сервере код расширений, AI-инструментов, маршрутов и шагов workflow (`name`, `description`, `runtime` `'nodejs18.x' | 'nodejs22.x'`, `timeoutSeconds` `1..900`, `sourceHandlerPath`, `builtHandlerPath`, `handlerName`, `checksum`, `isBuildUpToDate`, `executionMode` `'LIVE' | 'PREBUILT'`, `cronTriggerSettings`, `databaseEventTriggerSettings`, `httpRouteTriggerSettings`, `serverRouteTriggerSettings`, `toolTriggerSettings`, `workflowActionTriggerSettings`).
   - Мутируются через:
     - `LogicFunctionResolver` (`createOneLogicFunction`, `updateOneLogicFunction`, `deleteOneLogicFunction`, `executeOneLogicFunction`, защищены `SettingsPermissionGuard(PermissionFlagType.WORKFLOWS)`);
     - `LogicFunctionFromSourceService` (`createOneFromSource`, `duplicateOneWithSource`, `updateOneFromSource`, `deleteOneWithSource`, `buildOneFromSource`, `executeOneFromSource`) и `LogicFunctionFromSourceHelperService` (`createOneFromMetadata`, `updateOneFromMetadata`);
     - `PrefillLogicFunctionService.ensureSeeded` (в `DevSeederWorkspaceService`);
     - `createUpdateLogicFunctionSourceTool` (`update_logic_function_source` AI-инструмент workflow);
     - `CodeStepBuildService` (`createCodeStepLogicFunction`, `duplicateCodeStepLogicFunction`, `buildCodeStepsFromSourceForSteps`, `switchCodeStepLogicFunctionsToPrebuilt`) и `WorkflowVersionStepOperationsWorkspaceService` (`runWorkflowVersionStepDeletionSideEffects`, `runStepCreationSideEffectsAndBuildStep`, `cloneStep`, `createDraftStep`);
     - каскадное удаление эксклюзивно принадлежащих шагам `CODE` серверных функций при удалении `workflow` (`WorkflowCoreSyncService.deleteFromCore` / `CoreWorkflowMutationWorkspaceService.deleteWorkflows` / `CoreWorkflowResolver.deleteCoreWorkflows` / `createDeleteWorkflowTool`) или черновой версии `workflowVersion` (`CoreWorkflowMutationWorkspaceService.discardDraftVersion` / `CoreWorkflowResolver.discardCoreWorkflowDraft`) через `WorkflowVersionOnDeleteSideEffectHandlerService` и `WorkflowVersionDependenciesOnDeleteSideEffectHandlerService`;
     - синхронизацию манифеста (`ApplicationManifestMigrationService.syncPreInstallLogicFunctionFromManifest` и `syncMetadataFromManifest`), удаление приложения (`ApplicationSyncService.uninstallApplication`) и `WorkspaceMigrationRunnerService.executeRun` (`CreateLogicFunctionActionHandlerService`, `UpdateLogicFunctionActionHandlerService`, `DeleteLogicFunctionActionHandlerService`).
   - Таблица `core."logicFunction"` наследует `SyncableEntity` с `ON DELETE CASCADE` на `core.application(id)`, поэтому без проверки в `assertNoRemainingApplicationRoleOrPermissionMetadata` прямое удаление `core.application` (`ApplicationService.delete`) могло бы тихо удалить серверные функции без аудита.

## 2. Рассмотренные варианты

### Вариант A (Рекомендуемый)
1. **Каталог ресурсов и административных действий (`crm-audit.types.ts`, `crm-audit-transaction-context.ts`)**:
   - Добавить `'logicFunction'` в `CrmAuditResourceKind`.
   - В `CATALOG` добавить `logicFunction`:
     - `values: ['applicationId', 'runtime', 'timeoutSeconds', 'isBuildUpToDate', 'executionMode']`
     - `redacted: ['name', 'description', 'sourceHandlerPath', 'builtHandlerPath', 'handlerName', 'checksum', 'cronTriggerSettings', 'databaseEventTriggerSettings', 'httpRouteTriggerSettings', 'serverRouteTriggerSettings', 'toolTriggerSettings', 'workflowActionTriggerSettings']`
   - В `ADMINISTRATIVE_ACTIONS` установить `logicFunction: ['create', 'update', 'delete']`.
2. **Точечный аудит `LogicFunctionFromSourceHelperService`, `LogicFunctionFromSourceService`, `LogicFunctionResolver`, workflow-шагов и каскадов удаления workflow (`navigation-menu-item-audit.ts`, `logic-function-from-source-helper.service.ts`, `logic-function-from-source.service.ts`, `logic-function.resolver.ts`, `prefill-logic-function.service.ts`, `update-logic-function-source.tool.ts`, `code-step-build.service.ts`, `workflow-version-step-operations.workspace-service.ts`, `workflow-core-sync.service.ts`, `core-workflow-mutation.workspace-service.ts`, `core-workflow.resolver.ts`, `workspace-migration-runner.service.ts`)**:
   - Расширить `NavigationMenuItemAuditMode` режимом `'logicFunction'`, добавить `expectedLogicFunctionCreateIds`, `expectedLogicFunctionUpdateIds`, `expectedLogicFunctionDeleteIds`, `expectedParentWorkflowDeleteIds`, `expectedParentWorkflowVersionDeleteIds` в `NavigationMenuItemAuditRequest` и `captureNavigationMenuItemAudit`, а также `logicFunctions`, `workflows` и `workflowVersions` в `NavigationMenuItemAuditMappings`.
   - В `runAuditedNavigationMenuItemMigration` (`mode: 'logicFunction'`):
     - Разрешать действия `logicFunction` (`create`, `update`, `delete`), а при каскадном удалении `workflow` / `workflowVersion` (`expectedParentWorkflowDeleteIds` или `expectedParentWorkflowVersionDeleteIds`) - также сопутствующие `delete`-действия `workflow`, `workflowVersion` и `commandMenuItem`, сверяя множество удаляемых `logicFunction` с эксклюзивно принадлежащими удаляемым версиям шагами `CODE`.
     - Под блокировкой `ORDER BY id FOR UPDATE` считывать снимок `core."logicFunction"`, проверять инварианты всех строк (`assertLogicFunctionRowInvariants`), сверять созданные, обновлённые и удалённые строки после миграции, записывать `logicFunction:create`, `logicFunction:update`, `logicFunction:delete` и выполнять post-flush сверку снимка.
3. **Пакетные миграции приложений и барьер удаления `core.application` (`application-metadata-audit.ts`, `application-manifest-migration.service.ts`, `workspace-migration-runner.service.ts`)**:
   - Добавить `'logicFunction'` в `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES`.
   - Обернуть `validateBuildAndRunWorkspaceMigrationFromTo` в `ApplicationManifestMigrationService.syncPreInstallLogicFunctionFromManifest` в `withApplicationMetadataAudit`.
   - В `reconcileApplicationRoleAndPermissionOperations` согласовывать каскадное удаление эксклюзивно принадлежащих удаляемым `workflow`/`workflowVersion` серверных функций шагов `CODE`.
   - В `runAuditedApplicationMetadataMigration` добавить чтение `core."logicFunction"` под `ORDER BY id FOR UPDATE`, запрет её мутаций в режимах `objectDelete`/`fieldDelete`, сверку `create`/`update`/`delete` (включая каскадное удаление от удаляемых `workflowVersion`), запись событий аудита и post-flush сверку снимка.
   - В `assertNoRemainingApplicationRoleOrPermissionMetadata` добавить проверку `core."logicFunction"` перед удалением `core.application`.

### Вариант B (Отклонён)
- Аудировать только прямые вызовы `LogicFunctionResolver`, пропуская `syncPreInstallLogicFunctionFromManifest`, `CodeStepBuildService` и каскады удаления `workflow` / `workflowVersion`.
- **Причина отклонения**: все эти пути мутируют `core."logicFunction"` через `WorkspaceMigrationRunnerService.executeRun`, где fail-closed барьер `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES` требует активной области аудита на каждой мутации `logicFunction`.

## 3. Стратегия тестирования

- Новый PostgreSQL-спецификационный файл `packages/twenty-server/test/fork-migration/crm-audit-logic-function.postgres-spec.ts`:
  1. Полный жизненный цикл `logicFunction` через `LogicFunctionResolver`, `LogicFunctionFromSourceService`, `LogicFunctionFromSourceHelperService`, `CodeStepBuildService` и `WorkflowCoreSyncService`: создание через `LogicFunctionResolver.createOneLogicFunction` (под пользователем с имперсонацией), идемпотентный `updateOneLogicFunction` без изменений, обновление кода и метаданных (`name`, `description`, `timeoutSeconds`, `toolTriggerSettings`, `cronTriggerSettings`) под `apiKey`, переключение в `PREBUILT` через `CodeStepBuildService.switchCodeStepLogicFunctionsToPrebuilt`, каскадное удаление `logicFunction` шага `CODE` при удалении `workflow` через `WorkflowCoreSyncService.deleteFromCore`, и прямое удаление через `LogicFunctionResolver.deleteOneLogicFunction`.
  2. Пакетная синхронизация `logicFunction` (`create`, идемпотентный повтор, `update` триггеров и параметров, `delete`) в `runAuditedApplicationMetadataMigration` и при `isSystemBuild: true`, блокировка `assertNoRemainingApplicationRoleOrPermissionMetadata` / `runAuditedApplicationDelete` при наличии оставшихся строк `core."logicFunction"` и fail-closed отказ `WorkspaceMigrationRunnerService.executeRun` на неаудируемых миграциях `logicFunction`.
  3. Откат транзакции при срабатывании post-flush триггера на `core."logicFunction"` и корректный проброс `NativeTransactionOutcomeUnknownError` без `ROLLBACK` при потере подтверждения `COMMIT`.
