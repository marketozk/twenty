# LOG182 - Дизайн транзакционного аудита полного жизненного цикла элементов командного меню (`commandMenuItem`, `core."commandMenuItem"`) и каскадов метаданных и приложений

## 1. Контекст и постановка задачи

После закрытия `LOG181` (`timelineActivityType`) в контуре безопасности, маршрутизации действий и метаданных приложений остаётся открытой поверхность элементов командного меню (`core."commandMenuItem"`, `CommandMenuItemEntity`):
1. **Элементы командного меню (`core."commandMenuItem"`, `CommandMenuItemEntity`)**:
   - Определяют глобальные и контекстные действия командной палитры (`TRIGGER_WORKFLOW_VERSION`, `FRONT_COMPONENT_RENDERER`, `NAVIGATION` и системные действия), горячие клавиши, условные выражения доступности и закрепления (`conditionalAvailabilityExpression`, `conditionalPinnedExpression`), целевые версии workflow (`workflowVersionId`, `coreWorkflowVersionId`), фронтенд-компоненты (`frontComponentId`), объекты (`availabilityObjectMetadataId`, `navigationTargetObjectMetadataId`), макеты страниц (`pageLayoutId`), активность (`isActive`) и переопределения (`overrides`).
   - Мутируются через:
     - `CommandMenuItemResolver` (`createCommandMenuItem`, `updateCommandMenuItem`, `resetCommandMenuItem`, `deleteCommandMenuItem`, защищены `SettingsPermissionGuard(PermissionFlagType.LAYOUTS)`);
     - `CommandMenuItemService` (`create`, `update`, `reset`, `delete`);
     - `CoreWorkflowMutationWorkspaceService.updateWorkflow` (`syncCommandMenuItemLabelFromCore`) и `CoreWorkflowLifecycleWorkspaceService` (`activateCoreWorkflowVersion`, `deactivateCoreWorkflowVersion`);
     - сидеры `prefillWorkflowCommandMenuItems` и `prefillFrontComponentCommandMenuItems`;
     - side-effect обработчики жизненного цикла объектов и workflow (`ObjectNavigationCommandOnCreateSideEffectHandlerService`, `ObjectNavigationCommandOnUpdateSideEffectHandlerService`, `ObjectSystemSideEffectsOnDeleteSideEffectHandlerService`, `buildWorkflowVersionDependenciesDeleteOperations`, `buildWorkflowVersionSideEffects`);
     - синхронизацию манифеста (`ApplicationManifestMigrationService.syncMetadataFromManifest`), синхронизацию стандартного приложения (`TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`), удаление приложения (`ApplicationSyncService.uninstallApplication`) и `WorkspaceMigrationRunnerService.executeRun` (`CreateCommandMenuItemActionHandlerService`, `UpdateCommandMenuItemActionHandlerService`, `DeleteCommandMenuItemActionHandlerService`).
   - Таблица `core."commandMenuItem"` имеет внешние ключи с `ON DELETE CASCADE` на `core.application(id)`, `core."frontComponent"(id)`, `core."objectMetadata"(id)` (`availabilityObjectMetadataId`, `navigationTargetObjectMetadataId`) и `core."pageLayout"(id)`.

## 2. Рассмотренные варианты

### Вариант A (Рекомендуемый)
1. **Каталог ресурсов и административных действий (`crm-audit.types.ts`, `crm-audit-transaction-context.ts`)**:
   - Добавить `'commandMenuItem'` в `CrmAuditResourceKind`.
   - В `CATALOG` добавить `commandMenuItem`:
     - `values: ['applicationId', 'workflowVersionId', 'coreWorkflowVersionId', 'frontComponentId', 'engineComponentKey', 'isPinned', 'availabilityType', 'availabilityObjectMetadataId', 'navigationTargetObjectMetadataId', 'pageLayoutId', 'isActive', 'isSystemSideEffect']`
     - `redacted: ['label', 'icon', 'shortLabel', 'position', 'payload', 'hotKeys', 'conditionalAvailabilityExpression', 'conditionalPinnedExpression', 'overrides']`
   - В `ADMINISTRATIVE_ACTIONS` установить `commandMenuItem: ['create', 'update', 'delete']`.
2. **Точечный и каскадный аудит в `navigation-menu-item-audit.ts`**:
   - Расширить `NavigationMenuItemAuditMode` режимом `'commandMenuItem'`, добавить `expectedCommandMenuItemCreateIds`, `expectedCommandMenuItemUpdateIds`, `expectedCommandMenuItemDeleteIds`, `expectedUpdatedObjectIds` в `NavigationMenuItemAuditRequest` и `captureNavigationMenuItemAudit`, а также `commandMenuItems` в `NavigationMenuItemAuditMappings`.
   - Включить `'commandMenuItem'` в `CASCADE_ALLOWED_METADATA_NAMES`.
   - В `runAuditedNavigationMenuItemMigration`:
     - Считывать снимок `core."commandMenuItem"` под `ORDER BY id FOR UPDATE` при любых действиях `commandMenuItem` и при каскадных удалениях `frontComponent`, `pageLayout`, `workflow`, `workflowVersion`.
     - Проверять инварианты всех строк (`assertCommandMenuItemRowInvariants`), проверять активность приложения-владельца при переопределении/сбросе (`overrides` / `reset` / `delete` с деактивацией) стандартных или сторонних элементов командного меню, сверять созданные, обновлённые и удалённые строки (включая `ON DELETE CASCADE` от `frontComponent` и `pageLayout`, а также side-effect удаление от `workflow` / `workflowVersion`), записывать `commandMenuItem:create`, `commandMenuItem:update`, `commandMenuItem:delete` и выполнять post-flush сверку снимка.
   - Подключить захват контекста аудита в `CommandMenuItemService` (`create`, `update`, `reset`, `delete`), `CommandMenuItemResolver`, `CoreWorkflowMutationWorkspaceService.updateWorkflow`, `CoreWorkflowResolver.updateCoreWorkflow`, `CoreWorkflowLifecycleWorkspaceService` (`activateCoreWorkflowVersion`, `deactivateCoreWorkflowVersion`), `CoreWorkflowVersionMutationResolver`, `ObjectMetadataService.updateManyObjects` (`updateOneObject`), `ObjectMetadataResolver`, `ObjectMetadataController`, `prefillWorkflowCommandMenuItems` и `prefillFrontComponentCommandMenuItems`.
3. **Пакетные миграции приложений и барьер удаления `core.application` (`application-metadata-audit.ts`, `workspace-migration-runner.service.ts`)**:
   - Добавить `'commandMenuItem'` в `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES`.
   - В `runAuditedApplicationMetadataMigration` добавить чтение `core."commandMenuItem"` под `ORDER BY id FOR UPDATE`, запрет её мутаций в режиме `fieldDelete` и разрешение только `delete` в режиме `objectDelete`, сверку `create`/`update`/`delete` (включая `ON DELETE CASCADE` от `frontComponent`, `objectMetadata`, `pageLayout` и side-effect удаление от `workflow`/`workflowVersion`), запись событий аудита и post-flush сверку снимка.
   - В `assertNoRemainingApplicationRoleOrPermissionMetadata` и `reconcileApplicationRoleAndPermissionOperations` добавить проверку и согласование `core."commandMenuItem"` (по `applicationId`, `frontComponentId`, `availabilityObjectMetadataId`, `navigationTargetObjectMetadataId`, `pageLayoutId`).

### Вариант B (Отклонён)
- Аудировать только прямые вызовы `CommandMenuItemService`, игнорируя каскадные удаления при удалении `frontComponent`, `objectMetadata`, `pageLayout`, `workflow` и `workflowVersion`.
- **Причина отклонения**: каскадное удаление `frontComponent`, `objectMetadata`, `pageLayout` или `workflowVersion` удаляет строки `core."commandMenuItem"` в базе данных; пропуск этих путей оставил бы неаудируемые удаления элементов командного меню и позволил бы обойти барьер удаления `core.application`.

## 3. Стратегия тестирования

- Новый PostgreSQL-спецификационный файл `packages/twenty-server/test/fork-migration/crm-audit-command-menu-item.postgres-spec.ts`:
  1. Полный жизненный цикл `commandMenuItem` через `CommandMenuItemResolver` и `CommandMenuItemService`:
     - создание кастомного `commandMenuItem` (`FRONT_COMPONENT_RENDERER` и `NAVIGATION`) через `createCommandMenuItem` (под пользователем с имперсонацией) -> `commandMenuItem:create`;
     - обновление кастомного `commandMenuItem` через `updateCommandMenuItem` (`label`, `shortLabel`, `icon`, `position`, `isPinned`, `availabilityType`, `availabilityObjectMetadataId`, `hotKeys`, `conditionalAvailabilityExpression`) -> `commandMenuItem:update`;
     - идемпотентный повтор `updateCommandMenuItem` без фактических изменений -> `0` новых записей аудита;
     - переопределение стандартного `commandMenuItem` через `updateCommandMenuItem` и деактивация через `deleteCommandMenuItem` (`shouldDeactivate = true`) -> `commandMenuItem:update` с `changedFields: ['overrides']`, а затем сброс через `resetCommandMenuItem` (под `apiKey`) -> `commandMenuItem:update` с `overrides: null`;
     - физическое удаление кастомного `commandMenuItem` через `deleteCommandMenuItem` (`shouldDeactivate = false`) -> `commandMenuItem:delete`;
     - каскадное удаление `commandMenuItem` при удалении родительского `frontComponent` (`FrontComponentService.deleteOne`) и `pageLayout` (`PageLayoutService.destroy`).
  2. Пакетные миграции приложений (`runAuditedApplicationMetadataMigration`, `isSystemBuild: true`, `objectDelete`), блокировка `assertNoRemainingApplicationRoleOrPermissionMetadata` / `runAuditedApplicationDelete` при наличии собственного или зависимого `core."commandMenuItem"` и fail-closed отказ `WorkspaceMigrationRunnerService.executeRun` на неаудируемых миграциях `commandMenuItem`.
  3. Откат транзакции при срабатывании post-flush триггера на `core."commandMenuItem"` и корректный проброс `NativeTransactionOutcomeUnknownError` без `ROLLBACK` при потере подтверждения `COMMIT`.
