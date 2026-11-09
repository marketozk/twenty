# LOG-179 - Дизайн транзакционного аудита полного жизненного цикла фронтенд-компонентов приложений (`frontComponent`, `core."frontComponent"`) и пунктов меню настроек (`settingsMenuItem`, `core."settingsMenuItem"`)

## 1. Контекст и постановка задачи

После закрытия `LOG-178` (`skill`, `core.skill`) в контуре безопасности, расширений интерфейса и метаданных приложений остаются открытыми две взаимосвязанные поверхности:
1. **Фронтенд-компоненты приложений (`core."frontComponent"`, `FrontComponentEntity`)**:
   - Определяют исполняемые в браузере компоненты расширений (`name`, `description`, `sourceComponentPath`, `builtComponentPath`, `componentName`, `builtComponentChecksum`, `isHeadless`, `widgetAvailability`, `usesSdkClient`), которые могут запрашивать пару токенов приложения (`FrontComponentResolver.generateFrontComponentApplicationTokenPair`) и получать публичные переменные приложения.
   - Мутируются через `FrontComponentResolver` (`createFrontComponent`, `updateFrontComponent`, `deleteFrontComponent`, защищены `SettingsPermissionGuard(PermissionFlagType.APPLICATIONS)`), `FrontComponentService` (`createOne`, `updateOne`, `destroyOne`), `PrefillFrontComponentService.ensureSeeded` (в `DevSeederWorkspaceService`), а также через синхронизацию манифеста (`ApplicationManifestMigrationService.syncMetadataFromManifest`), удаление приложения (`ApplicationSyncService.uninstallApplication`) и `WorkspaceMigrationRunnerService.executeRun` (`CreateFrontComponentActionHandlerService`, `UpdateFrontComponentActionHandlerService`, `DeleteFrontComponentActionHandlerService`).
2. **Пункты меню настроек (`core."settingsMenuItem"`, `SettingsMenuItemEntity`)**:
   - Встраивают фронтенд-компоненты приложений в разделы настроек рабочего пространства или пользователя (`frontComponentId` с `ON DELETE CASCADE` на `core."frontComponent"(id)`, `title`, `icon`, `position`, `scope` `'WORKSPACE' | 'USER'`).
   - Мутируются через синхронизацию манифеста (`ApplicationManifestMigrationService.syncMetadataFromManifest`), удаление приложения (`ApplicationSyncService.uninstallApplication`) и `WorkspaceMigrationRunnerService.executeRun` (`CreateSettingsMenuItemActionHandlerService`, `UpdateSettingsMenuItemActionHandlerService`, `DeleteSettingsMenuItemActionHandlerService`), а также каскадно удаляются СУБД (`ON DELETE CASCADE`) при удалении целевого `core."frontComponent"`.
   - Обе таблицы (`core."frontComponent"` и `core."settingsMenuItem"`) наследуют `SyncableEntity` с `ON DELETE CASCADE` на `core.application(id)`, поэтому без проверки в `assertNoRemainingApplicationRoleOrPermissionMetadata` прямое удаление `core.application` (`ApplicationService.delete`) могло бы тихо удалить их без аудита.

## 2. Рассмотренные варианты

### Вариант A (Рекомендуемый)
1. **Каталог ресурсов и административных действий (`crm-audit.types.ts`, `crm-audit-transaction-context.ts`)**:
   - Добавить `'frontComponent'` и `'settingsMenuItem'` в `CrmAuditResourceKind`.
   - В `CATALOG` добавить:
     - `frontComponent`:
       - `values: ['applicationId', 'isHeadless', 'usesSdkClient']`
       - `redacted: ['name', 'description', 'sourceComponentPath', 'builtComponentPath', 'componentName', 'builtComponentChecksum', 'widgetAvailability']`
     - `settingsMenuItem`:
       - `values: ['applicationId', 'frontComponentId', 'scope']`
       - `redacted: ['title', 'icon', 'position']`
   - В `ADMINISTRATIVE_ACTIONS` установить:
     - `frontComponent: ['create', 'update', 'delete']`
     - `settingsMenuItem: ['create', 'update', 'delete']`.
2. **Точечный аудит `FrontComponentService` и `FrontComponentResolver` (`navigation-menu-item-audit.ts`, `front-component.service.ts`, `front-component.resolver.ts`, `prefill-front-component.service.ts`, `workspace-migration-runner.service.ts`)**:
   - Расширить `NavigationMenuItemAuditMode` режимом `'frontComponent'`, добавить `expectedFrontComponentCreateIds`, `expectedFrontComponentUpdateIds`, `expectedFrontComponentDeleteIds` в `NavigationMenuItemAuditRequest` и `captureNavigationMenuItemAudit`, а также `frontComponents` и `settingsMenuItems` в `NavigationMenuItemAuditMappings`.
   - В `runAuditedNavigationMenuItemMigration` (`mode: 'frontComponent'`):
     - Разрешать действия `frontComponent` (`create`, `update`, `delete`) и каскадные/явные удаления `settingsMenuItem` (`delete`) при удалении `frontComponent`.
     - Под блокировкой `ORDER BY id FOR UPDATE` считывать снимки `core."frontComponent"` и (при наличии таблицы и удалении компонента или действиях `settingsMenuItem`) `core."settingsMenuItem"`, проверять инварианты всех строк (`assertFrontComponentRowInvariants`, `assertSettingsMenuItemRowInvariants`).
     - После выполнения миграции сверять созданные, обновлённые и удалённые строки `core."frontComponent"` и каскадно удалённые строки `core."settingsMenuItem"` (`WHERE "frontComponentId" = ANY(deletedFrontComponentIds)`), записывать `frontComponent:create`, `frontComponent:update`, `frontComponent:delete` и `settingsMenuItem:delete`, а после `audit.flush()` повторно сверять сериализованные снимки обеих таблиц.
   - В `FrontComponentService` (`createOne`, `updateOne`, `destroyOne`) захватывать входные параметры и контекст аудита синхронно до первого `await` и оборачивать `validateBuildAndRunWorkspaceMigration` в `withNavigationMenuItemAudit`.
   - В `FrontComponentResolver` (`createFrontComponent`, `updateFrontComponent`, `deleteFrontComponent`) передавать `authUserWorkspaceId`, `authApiKeyId`, `authApplicationId` и `auditIdentity: context?.req` в `FrontComponentService`.
   - В `PrefillFrontComponentService.ensureSeeded` передавать `defaultSystemActorId: 'dev-seeder:prefill-front-component'`.
3. **Пакетные миграции приложений и барьер удаления `core.application` (`application-metadata-audit.ts`, `workspace-migration-runner.service.ts`)**:
   - Добавить `'frontComponent'` и `'settingsMenuItem'` в `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES` (fail-closed барьер на неаудируемые миграции в `WorkspaceMigrationRunnerService.executeRun` и автоматическая системная обёртка при `isSystemBuild: true` в `WorkspaceMigrationValidateBuildAndRunService`).
   - При наличии `delete`-действия на `frontComponent` в `WorkspaceMigrationRunnerService.executeRun` включать `'settingsMenuItem'` в `permissionCascadeMetadataNames` для загрузки и инвалидации `flatSettingsMenuItemMaps`.
   - В `runAuditedApplicationMetadataMigration` добавить чтение `core."frontComponent"` и `core."settingsMenuItem"` под `ORDER BY id FOR UPDATE`, запрет их мутаций в режимах `objectDelete`/`fieldDelete`, сверку `create`/`update`/`delete` (включая разрешение `universalWidgetAvailability` и `frontComponentUniversalIdentifier`, а также каскадное удаление `settingsMenuItem` при удалении `frontComponent`), запись событий аудита и post-flush сверку снимков.
   - В `assertNoRemainingApplicationRoleOrPermissionMetadata` добавить проверку `core."frontComponent"`, `core."settingsMenuItem"` и межприложенческих ссылок `settingsMenuItem.frontComponentId -> frontComponent.id` перед удалением `core.application`.

### Вариант B (Отклонён)
- Аудировать `frontComponent` отдельно от `settingsMenuItem`.
- **Причина отклонения**: `core."settingsMenuItem"` имеет внешний ключ `frontComponentId` с `ON DELETE CASCADE` на `core."frontComponent"`, поэтому удаление фронтенд-компонента без одновременного аудита `settingsMenuItem` приводило бы к неаудируемому каскадному удалению пунктов меню настроек.

## 3. Стратегия тестирования

- Новый PostgreSQL-спецификационный файл `packages/twenty-server/test/fork-migration/crm-audit-front-component-and-settings-menu-item.postgres-spec.ts`:
  1. Полный жизненный цикл `frontComponent` через `FrontComponentResolver` и `FrontComponentService` (`createFrontComponent` под пользователем с имперсонацией, идемпотентный `updateFrontComponent` без изменений, `updateFrontComponent` под `apiKey` с изменением `name`, `description`, `sourceComponentPath`, `builtComponentPath`, `componentName`, `builtComponentChecksum`, `isHeadless`, `PrefillFrontComponentService`-подобный вызов с `defaultSystemActorId`, и `deleteFrontComponent` с каскадным удалением привязанного `core."settingsMenuItem"` в одной транзакции аудита).
  2. Пакетная синхронизация `frontComponent` и `settingsMenuItem` (`create`, идемпотентный повтор, `update` с `universalWidgetAvailability` и `frontComponentUniversalIdentifier`, `delete`) в `runAuditedApplicationMetadataMigration` и при `isSystemBuild: true`, блокировка `assertNoRemainingApplicationRoleOrPermissionMetadata` / `runAuditedApplicationDelete` при наличии оставшихся строк `core."frontComponent"` или `core."settingsMenuItem"` (включая межприложенческую ссылку `settingsMenuItem -> frontComponent`) и fail-closed отказ `WorkspaceMigrationRunnerService.executeRun` на неаудируемых миграциях `frontComponent` и `settingsMenuItem`.
  3. Откат транзакции при срабатывании post-flush триггера на `core."frontComponent"` или `core."settingsMenuItem"` и корректный проброс `NativeTransactionOutcomeUnknownError` без `ROLLBACK` при потере подтверждения `COMMIT`.
