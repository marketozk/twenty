# LOG183 — Дизайн транзакционного аудита `pageLayout`, `pageLayoutTab` и `pageLayoutWidget` (`ROB-765`)

## 1. Контекст и цель
В рамках `ROB-765` (Фаза 2a — сбор аудита действий) после закрытия `LOG182` (`commandMenuItem`) неподключённым остаётся стек метаданных макетов страниц в схеме `core`:
- `core."pageLayout"` (`PageLayoutEntity` — макеты страниц типов `RECORD_INDEX`, `RECORD_PAGE`, `DASHBOARD`, `STANDALONE_PAGE`, `RECORD_FORM` с привязкой к `applicationId`, `objectMetadataId`, `defaultTabToFocusOnMobileAndSidePanelId`, флагами `isSystemSideEffect`, `isFirstTabPinned` и именем `name`);
- `core."pageLayoutTab"` (`PageLayoutTabEntity` — вкладки макетов страниц с `applicationId`, `pageLayoutId`, `layoutMode`, `isActive`, `isSystemSideEffect`, `title`, `position`, `icon` и `overrides`);
- `core."pageLayoutWidget"` (`PageLayoutWidgetEntity` — виджеты вкладок макетов с `applicationId`, `pageLayoutTabId`, `type`, `objectMetadataId`, `isActive`, `isSystemSideEffect`, `title`, `conditionalDisplay`, `conditionalAvailabilityExpression`, `gridPosition`, `position`, `configuration` и `overrides`).

Мутации `core."pageLayout"`, `core."pageLayoutTab"` и `core."pageLayoutWidget"` выполняются через:
1. `PageLayoutService` (`create`, `update`, `destroy`, `destroyMany`), `PageLayoutResolver` (`createPageLayout`, `updatePageLayout`, `destroyPageLayout`, `updatePageLayoutWithTabsAndWidgets`, `resetPageLayoutToDefault`, `resetPageLayoutTabToDefault`, `resetPageLayoutWidgetToDefault`) и `PageLayoutController` (`create`, `update`, `destroy`);
2. `PageLayoutTabService` (`create`, `update`, `destroy`), `PageLayoutTabResolver` (`createPageLayoutTab`, `updatePageLayoutTab`, `destroyPageLayoutTab`) и `PageLayoutTabController` (`create`, `update`, `destroy`);
3. `PageLayoutWidgetService` (`create`, `update`, `destroy`), `PageLayoutWidgetResolver` (`createPageLayoutWidget`, `updatePageLayoutWidget`, `destroyPageLayoutWidget`) и `PageLayoutWidgetController` (`create`, `update`, `destroy`);
4. Составные операции `PageLayoutUpdateService.updatePageLayoutWithTabs`, `PageLayoutResetService` (`resetPageLayoutToDefault`, `resetPageLayoutTabToDefault`, `resetPageLayoutWidgetToDefault`), `PageLayoutDuplicationService.duplicate`, `DashboardDuplicationService.duplicateDashboard`, `DashboardToPageLayoutSyncService`, AI-инструменты дашбордов (`DashboardToolProvider` / `DashboardToolWorkspaceService`), `seedPageLayouts`;
5. Каскады и side-effects при создании/обновлении/удалении `objectMetadata` и `fieldMetadata` (`ObjectMetadataService`, `FieldMetadataService`, резолверы, контроллеры и AI-инструменты);
6. Пакетные миграции приложений (`ApplicationManifestMigrationService.syncMetadataFromManifest`, `ApplicationSyncService.uninstallApplication`, `TwentyStandardApplicationService`) и барьер удаления `core.application` (`assertNoRemainingApplicationRoleOrPermissionMetadata`).

Цель `LOG183` — закрыть полный жизненный цикл (`create`, `update`, `delete`) и все каскадные мутации `pageLayout`, `pageLayoutTab` и `pageLayoutWidget` в единой транзакции БД до `COMMIT` с редактированием отображаемых строк и JSONB-конфигураций, верификацией состояния после `audit.flush()` и fail-closed барьером в `WorkspaceMigrationRunnerService.executeRun`.

## 2. Рассмотренные варианты
1. **Вариант A (рекомендуемый)**: расширить `navigation-menu-item-audit.ts` режимом `mode: 'pageLayout'` и поддержкой `pageLayout`, `pageLayoutTab`, `pageLayoutWidget` в `mode: 'cascade'`, расширить `application-metadata-audit.ts` (`runAuditedApplicationMetadataMigration`, `reconcileApplicationRoleAndPermissionOperations`, `assertNoRemainingApplicationRoleOrPermissionMetadata`) и добавить `'pageLayout'`, `'pageLayoutTab'`, `'pageLayoutWidget'` в `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES`.
   - Плюсы: все прямые, составные (`updatePageLayoutWithTabs`, `reset*`, `duplicate`) и каскадные мутации (`ON DELETE CASCADE` от `objectMetadata` -> `pageLayout` -> `pageLayoutTab` -> `pageLayoutWidget`, `ON DELETE SET NULL` на `pageLayout.defaultTabToFocusOnMobileAndSidePanelId`, каскады от `navigationMenuItem` и `commandMenuItem`) проверяются в одной транзакции `QueryRunner` со строгой пост-flush сверкой снимков.
   - Минусы: требует аккуратного разрешения универсальных идентификаторов в `configuration` и `overrides` виджетов.
2. **Вариант B**: создать отдельный `page-layout-audit.ts` с отдельным `AsyncLocalStorage`.
   - Плюсы: отдельный файл.
   - Минусы: конфликтует с `navigation-menu-item-audit.ts` (`Conflicting metadata audit owners`) при удалении `pageLayout` (каскадно удаляющем `navigationMenuItem` и `commandMenuItem`), при `seedPageLayouts` и при создании/обновлении объектов и полей (`ObjectMetadataService`, `FieldMetadataService`).

Выбран **Вариант A**.

## 3. Архитектура и модель данных аудита
### 3.1. Типы и каталог (`crm-audit.types.ts`, `crm-audit-transaction-context.ts`)
- В `CrmAuditResourceKind` добавляются `'pageLayout'`, `'pageLayoutTab'`, `'pageLayoutWidget'`.
- В `CATALOG`:
  - `pageLayout`:
    - `values: ['applicationId', 'type', 'objectMetadataId', 'defaultTabToFocusOnMobileAndSidePanelId', 'isSystemSideEffect', 'isFirstTabPinned']`
    - `redacted: ['name']`
  - `pageLayoutTab`:
    - `values: ['applicationId', 'pageLayoutId', 'layoutMode', 'isActive', 'isSystemSideEffect']`
    - `redacted: ['title', 'position', 'icon', 'overrides']`
  - `pageLayoutWidget`:
    - `values: ['applicationId', 'pageLayoutTabId', 'type', 'objectMetadataId', 'isActive', 'isSystemSideEffect']`
    - `redacted: ['title', 'conditionalDisplay', 'conditionalAvailabilityExpression', 'gridPosition', 'position', 'configuration', 'overrides']`
- В `ADMINISTRATIVE_ACTIONS`:
  - `pageLayout: ['create', 'update', 'delete']`
  - `pageLayoutTab: ['create', 'update', 'delete']`
  - `pageLayoutWidget: ['create', 'update', 'delete']`

### 3.2. Инварианты и проекции (`navigation-menu-item-audit.ts`)
- `assertPageLayoutRowInvariants(row, workspaceId)` и `projectPageLayout(row)`:
  - проверяют UUID `id`, `workspaceId`, `applicationId`, `universalIdentifier`, отсутствие `deletedAt`, непустой `name`, допустимый `type` (`RECORD_INDEX`, `RECORD_PAGE`, `DASHBOARD`, `STANDALONE_PAGE`, `RECORD_FORM`), nullable UUID `objectMetadataId` и `defaultTabToFocusOnMobileAndSidePanelId`, булевы `isSystemSideEffect` и `isFirstTabPinned`.
- `assertPageLayoutTabRowInvariants(row, workspaceId)` и `projectPageLayoutTab(row)`:
  - проверяют UUID `id`, `workspaceId`, `applicationId`, `universalIdentifier`, `pageLayoutId`, отсутствие `deletedAt`, непустой `title`, конечное число `position`, nullable строку `icon`, допустимый `layoutMode` (`GRID`, `VERTICAL_LIST`, `CANVAS`), булевы `isActive` и `isSystemSideEffect`, а также `overrides` (null или plain object).
- `assertPageLayoutWidgetRowInvariants(row, workspaceId)` и `projectPageLayoutWidget(row)`:
  - проверяют UUID `id`, `workspaceId`, `applicationId`, `universalIdentifier`, `pageLayoutTabId`, отсутствие `deletedAt`, строку `title`, допустимый `type` (`WidgetType`), nullable UUID `objectMetadataId`, булевы `isActive` и `isSystemSideEffect`, JSONB-объекты `gridPosition` и `configuration`, nullable JSONB `conditionalDisplay`, `position`, `overrides` и nullable строку `conditionalAvailabilityExpression`.
- Разрешение `universalOverrides` и `universalConfiguration` виджетов:
  - `resolveExpectedPageLayoutWidgetOverrides` отображает `pageLayoutTabUniversalIdentifier` -> `pageLayoutTabId` в каждой записи `overrides`;
  - `resolveExpectedPageLayoutWidgetConfiguration` отображает универсальные ссылки на `fieldMetadata`, `frontComponent`, `view` в соответствующие UUID.
- Каскады:
  - `computeCascadeDeletedPageLayoutIds`: прямые удаления `pageLayout` + каскад от удаляемых `objectMetadata`;
  - `computeCascadeDeletedPageLayoutTabIds`: прямые удаления `pageLayoutTab` + каскад от `effectiveDeletedPageLayoutIds`;
  - `computeCascadeDeletedPageLayoutWidgetIds`: прямые удаления `pageLayoutWidget` + каскад от `effectiveDeletedPageLayoutTabIds` и `plannedObjectDeletes`;
  - `ON DELETE SET NULL` на `pageLayout.defaultTabToFocusOnMobileAndSidePanelId` при удалении `pageLayoutTab`: автоматически фиксируется как `pageLayout:update` (`defaultTabToFocusOnMobileAndSidePanelId: <tabId> -> null`).

### 3.3. Точки входа и fail-closed барьер
- `PageLayoutService`, `PageLayoutResolver`, `PageLayoutController`, `PageLayoutTabService`, `PageLayoutTabResolver`, `PageLayoutTabController`, `PageLayoutWidgetService`, `PageLayoutWidgetResolver`, `PageLayoutWidgetController`, `PageLayoutUpdateService`, `PageLayoutResetService`, `PageLayoutDuplicationService`, `DashboardDuplicationService`, `DashboardToPageLayoutSyncService`, `DashboardToolProvider` / `DashboardToolWorkspaceService` и `seedPageLayouts` захватывают идентичность до первого `await`.
- `FieldMetadataService` (`createOneField`, `createManyFields`, `updateOneField`), `FieldMetadataResolver`, `FieldMetadataController` и AI-инструменты создания/обновления полей передают `auditIdentity` и оборачивают миграцию в `withNavigationMenuItemAudit` (`mode: 'cascade'`), чтобы side-effect виджеты `RECORD_FORM` всегда аудировались.
- `'pageLayout'`, `'pageLayoutTab'` и `'pageLayoutWidget'` включены в `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES` и в `assertNoRemainingApplicationRoleOrPermissionMetadata`.
