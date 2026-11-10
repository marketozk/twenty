# LOG180 - План проверок (`logicFunction`)

## 1. Целевые PostgreSQL интеграционные сценарии (`crm-audit-logic-function.postgres-spec.ts`)

1. **Жизненный цикл `logicFunction` через `LogicFunctionResolver`, `LogicFunctionFromSourceService`, `CodeStepBuildService` и каскад удаления workflow**:
   - Создание серверной функции через `LogicFunctionResolver.createOneLogicFunction` (под пользователем с имперсонацией) -> `logicFunction:create` с `values: { applicationId: customAppId, executionMode: 'LIVE', isBuildUpToDate: true, runtime: 'nodejs22.x', timeoutSeconds: 300 }` и хешированными `name`, `description`, `sourceHandlerPath`, `builtHandlerPath`, `handlerName`, `checksum` и `toolTriggerSettings`/`workflowActionTriggerSettings`.
   - Идемпотентный `LogicFunctionFromSourceHelperService.updateOneFromMetadata` без фактических изменений -> `0` новых записей аудита.
   - Обновление кода и метаданных (`name`, `description`, `timeoutSeconds`, `toolTriggerSettings`, `cronTriggerSettings`) через `LogicFunctionResolver.updateOneLogicFunction` (под `apiKey`) -> `logicFunction:update` с `changedFields` и `values: { timeoutSeconds: { before: 300, after: 120 } }`.
   - Переключение функции шага `CODE` в `PREBUILT` через `CodeStepBuildService.switchCodeStepLogicFunctionsToPrebuilt` -> `logicFunction:update` с `actor: { kind: 'system', id: 'code-step-build:switch-to-prebuilt' }` и `values: { executionMode: { before: 'LIVE', after: 'PREBUILT' } }`.
   - Каскадное удаление эксклюзивно принадлежащей шагу `CODE` функции при удалении `workflow` через `WorkflowCoreSyncService.deleteFromCore` -> `logicFunction:delete`.
   - Прямое удаление через `LogicFunctionResolver.deleteOneLogicFunction` -> `logicFunction:delete`.
2. **Пакетные миграции приложений (`runAuditedApplicationMetadataMigration` и `isSystemBuild: true`) и барьер удаления `core.application`**:
   - Создание `logicFunction` через `withApplicationMetadataAudit` -> `logicFunction:create`.
   - Идемпотентный повтор и обновление `logicFunction` (`description`, `timeoutSeconds`, `isBuildUpToDate`, `executionMode`, `httpRouteTriggerSettings`, `databaseEventTriggerSettings`) -> `logicFunction:update`.
   - Блокировка `runAuditedApplicationDelete` (`assertNoRemainingApplicationRoleOrPermissionMetadata`), пока у приложения остаётся строка `core."logicFunction"`.
   - Аудируемое удаление `logicFunction`, после которого `runAuditedApplicationDelete` проходит штатно, а также проверка автоматического системного аудита при `isSystemBuild: true`.
   - Fail-closed отказ `WorkspaceMigrationRunnerService.executeRun` при попытке выполнить неаудируемую миграцию `logicFunction`.
3. **Инварианты отказоустойчивости**:
   - Post-flush триггер, изменяющий `core."logicFunction"` после вставки в `crm_audit."crmAuditEntry"`, приводит к полному откату транзакции.
   - Потеря подтверждения `COMMIT` пробрасывает `NativeTransactionOutcomeUnknownError` без выполнения `ROLLBACK`.
