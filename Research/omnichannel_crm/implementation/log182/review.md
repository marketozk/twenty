# LOG182 - Независимое ревью реализации (`commandMenuItem`)

## Вердикт
`pass` (блокеров не выявлено)

## Матрица проверки

| Проверка | Статус | Доказательство |
|---|---|---|
| Сокрытие чувствительных метаданных `commandMenuItem` | `pass` | В `CATALOG.commandMenuItem` в `values` вынесены только скалярные идентификаторы и флаги `['applicationId', 'workflowVersionId', 'coreWorkflowVersionId', 'frontComponentId', 'engineComponentKey', 'isPinned', 'availabilityType', 'availabilityObjectMetadataId', 'navigationTargetObjectMetadataId', 'pageLayoutId', 'isActive', 'isSystemSideEffect']`, а `['label', 'icon', 'shortLabel', 'position', 'payload', 'hotKeys', 'conditionalAvailabilityExpression', 'conditionalPinnedExpression', 'overrides']` хешируются в `redacted`. |
| Захват атрибуции в `CommandMenuItemResolver`, `CommandMenuItemService`, workflow и object-metadata сервисах | `pass` | `CommandMenuItemResolver` передаёт `auditIdentity: context?.req` и `authUserWorkspaceId` в `CommandMenuItemService` (`create`, `update`, `reset`, `delete`). `CommandMenuItemService` синхронно захватывает входные параметры и контекст аудита до первого `await`. Также проброшен `auditIdentity` в `CoreWorkflowMutationWorkspaceService.updateWorkflow` (`syncCommandMenuItemLabelFromCore`), `CoreWorkflowLifecycleWorkspaceService` (`activateCoreWorkflowVersion`, `deactivateCoreWorkflowVersion`), `ObjectMetadataService.updateManyObjects` (`ObjectMetadataResolver`, `ObjectMetadataController`, `UpdateObjectMetadataTool`, `UpdateManyObjectMetadataTool`) и сидерах `prefillWorkflowCommandMenuItems` / `prefillFrontComponentCommandMenuItems`. |
| Каскадные мутации и защита удаления `core.application` | `pass` | `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES`, `runAuditedApplicationMetadataMigration`, `assertNoRemainingApplicationRoleOrPermissionMetadata` и `reconcileApplicationRoleAndPermissionOperations` покрывают `commandMenuItem`, включая каскады при создании/обновлении/удалении `objectMetadata`, удалении `frontComponent`, `pageLayout`, `workflow`/`workflowVersion` и блокировку удаления `core.application` при наличии живых строк `core."commandMenuItem"`. |
| Типобезопасность и границы лицензий | `pass` | Дифференциальный `tsc` (`500` baseline / `501` current корней, `262` baseline / `262` current диагностик, `0` новых и `0` в изменённом коде), `check_enterprise_dependencies.py --verify-baseline` (`status: pass`, `0` нарушений), `check_fork_migration_sources.py` (`Verified 10 fork migration source(s)`), `33` теста охранных скриптов (`0.191s`). |
