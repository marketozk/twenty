# LOG181 - Дизайн транзакционного аудита полного жизненного цикла типов событий таймлайна (`timelineActivityType`, `core."timelineActivityType"`)

## 1. Контекст и постановка задачи

После закрытия `LOG180` (`logicFunction`) в контуре безопасности, маршрутизации событий таймлайна и метаданных приложений остаётся открытой поверхность типов событий таймлайна (`core."timelineActivityType"`, `TimelineActivityTypeEntity`):
1. **Типы событий таймлайна (`core."timelineActivityType"`, `TimelineActivityTypeEntity`)**:
   - Определяют правила маршрутизации, эмиссии, замещения и отображения событий таймлайна в карточках CRM (`name`, `label`, `action`, `icon`, `frontComponentUniversalIdentifier`, `objectUniversalIdentifier`, `targetRelationFieldUniversalIdentifier`, `triggerFieldUniversalIdentifiers`, `happensAtFieldUniversalIdentifier`, `replacesTimelineActivityTypeUniversalIdentifier`, `isActive`, `overrides`).
   - Изменение `isActive`, `overrides` (`isActive`, `label`, `icon`, `translations`), `replacesTimelineActivityTypeUniversalIdentifier` или `frontComponentUniversalIdentifier` позволяет подавлять отображение событий аудита/таймлайна в карточках сделок, контактов и компаний или подменять компонент их рендеринга.
   - Мутируются через:
     - `TimelineActivityTypeResolver` (`updateTimelineActivityType`, `resetTimelineActivityType`, защищены `SettingsPermissionGuard(PermissionFlagType.APPLICATIONS)`);
     - `TimelineActivityTypeService` (`update`, `reset` -> `persistUpdate`);
     - синхронизацию манифеста (`ApplicationManifestMigrationService.syncMetadataFromManifest`), синхронизацию стандартного приложения (`TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`), удаление приложения (`ApplicationSyncService.uninstallApplication`) и `WorkspaceMigrationRunnerService.executeRun` (`CreateTimelineActivityTypeActionHandlerService`, `UpdateTimelineActivityTypeActionHandlerService`, `DeleteTimelineActivityTypeActionHandlerService`).
   - Таблица `core."timelineActivityType"` наследует `OverridableEntity` (`SyncableEntity`) с `ON DELETE CASCADE` на `core.application(id)`, поэтому без проверки в `assertNoRemainingApplicationRoleOrPermissionMetadata` прямое удаление `core.application` (`ApplicationService.delete`) могло бы тихо удалить типы событий таймлайна без аудита.

## 2. Рассмотренные варианты

### Вариант A (Рекомендуемый)
1. **Каталог ресурсов и административных действий (`crm-audit.types.ts`, `crm-audit-transaction-context.ts`)**:
   - Добавить `'timelineActivityType'` в `CrmAuditResourceKind`.
   - В `CATALOG` добавить `timelineActivityType`:
     - `values: ['applicationId', 'action', 'frontComponentUniversalIdentifier', 'objectUniversalIdentifier', 'targetRelationFieldUniversalIdentifier', 'happensAtFieldUniversalIdentifier', 'replacesTimelineActivityTypeUniversalIdentifier', 'isActive']`
     - `redacted: ['name', 'label', 'icon', 'triggerFieldUniversalIdentifiers', 'overrides']`
   - В `ADMINISTRATIVE_ACTIONS` установить `timelineActivityType: ['create', 'update', 'delete']`.
2. **Точечный аудит `TimelineActivityTypeService` и `TimelineActivityTypeResolver` (`navigation-menu-item-audit.ts`, `timeline-activity-type.service.ts`, `timeline-activity-type.resolver.ts`, `workspace-migration-runner.service.ts`)**:
   - Расширить `NavigationMenuItemAuditMode` режимом `'timelineActivityType'`, добавить `expectedTimelineActivityTypeCreateIds`, `expectedTimelineActivityTypeUpdateIds`, `expectedTimelineActivityTypeDeleteIds` в `NavigationMenuItemAuditRequest` и `captureNavigationMenuItemAudit`, а также `timelineActivityTypes` в `NavigationMenuItemAuditMappings`.
   - В `runAuditedNavigationMenuItemMigration` (`mode: 'timelineActivityType'`):
     - Разрешать только действия `timelineActivityType` (`create`, `update`, `delete`).
     - Под блокировкой `ORDER BY id FOR UPDATE` считывать снимок `core."timelineActivityType"`, проверять инварианты всех строк (`assertTimelineActivityTypeRowInvariants`), проверять активность приложения-владельца при переопределении/сбросе (`overrides` / `reset`) типов стандартного или стороннего приложения, сверять созданные, обновлённые и удалённые строки после миграции, записывать `timelineActivityType:create`, `timelineActivityType:update`, `timelineActivityType:delete` и выполнять post-flush сверку снимка.
   - В `TimelineActivityTypeService` (`update`, `reset`) захватывать входные параметры и контекст аудита синхронно до первого `await` и оборачивать `validateBuildAndRunWorkspaceMigration` в `withNavigationMenuItemAudit`.
   - В `TimelineActivityTypeResolver` (`updateTimelineActivityType`, `resetTimelineActivityType`) передавать `authUserWorkspaceId`, `authApiKeyId`, `authApplicationId` и `auditIdentity: context?.req` в `TimelineActivityTypeService`.
3. **Пакетные миграции приложений и барьер удаления `core.application` (`application-metadata-audit.ts`, `workspace-migration-runner.service.ts`)**:
   - Добавить `'timelineActivityType'` в `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES`.
   - В `runAuditedApplicationMetadataMigration` добавить чтение `core."timelineActivityType"` под `ORDER BY id FOR UPDATE`, запрет её мутаций в режимах `objectDelete`/`fieldDelete`, сверку `create`/`update`/`delete`, запись событий аудита и post-flush сверку снимка.
   - В `assertNoRemainingApplicationRoleOrPermissionMetadata` добавить проверку `core."timelineActivityType"` перед удалением `core.application`.

### Вариант B (Отклонён)
- Аудировать только пакетные миграции `timelineActivityType` в `application-metadata-audit.ts`, оставляя `TimelineActivityTypeService.update` и `reset` без аудита.
- **Причина отклонения**: именно через `updateTimelineActivityType` и `resetTimelineActivityType` администраторы и API-ключи переопределяют `isActive` и `overrides` типов событий таймлайна в рабочем пространстве, а `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES` требует активной области аудита на каждой миграции `timelineActivityType`.

## 3. Стратегия тестирования

- Новый PostgreSQL-спецификационный файл `packages/twenty-server/test/fork-migration/crm-audit-timeline-activity-type.postgres-spec.ts`:
  1. Полный жизненный цикл обновления и сброса `timelineActivityType` через `TimelineActivityTypeResolver` и `TimelineActivityTypeService`: переопределение стандартного `timelineActivityType` через `updateTimelineActivityType` (под пользователем с имперсонацией, изменение `label`, `icon`, `isActive: false`, `translations` -> запись в `overrides.workspaceCustom`), идемпотентный повтор `updateTimelineActivityType` без изменений (`0` новых записей аудита), сброс переопределений через `resetTimelineActivityType` (под `apiKey` -> `overrides: null, isActive: true`), и прямое обновление кастомного `timelineActivityType` (`label`, `icon`, `isActive`).
  2. Пакетная синхронизация `timelineActivityType` (`create`, идемпотентный повтор, `update` маршрутизации и `frontComponentUniversalIdentifier`, `delete`) в `runAuditedApplicationMetadataMigration` и при `isSystemBuild: true`, блокировка `assertNoRemainingApplicationRoleOrPermissionMetadata` / `runAuditedApplicationDelete` при наличии оставшихся строк `core."timelineActivityType"` и fail-closed отказ `WorkspaceMigrationRunnerService.executeRun` на неаудируемых миграциях `timelineActivityType`.
  3. Откат транзакции при срабатывании post-flush триггера на `core."timelineActivityType"` и корректный проброс `NativeTransactionOutcomeUnknownError` без `ROLLBACK` при потере подтверждения `COMMIT`.
