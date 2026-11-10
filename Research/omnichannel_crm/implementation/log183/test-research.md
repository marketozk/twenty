# LOG183 — Исследование тестового контура (`test-research.md`)

## Целевые тестовые наборы
1. **Новый изолированный PostgreSQL-тест `packages/twenty-server/test/fork-migration/crm-audit-page-layout.postgres-spec.ts`**:
   - Прямой жизненный цикл `PageLayoutService` / `PageLayoutResolver` / `PageLayoutController` (`create`, `update`, `destroy`, `destroyMany`), `PageLayoutTabService` / `PageLayoutTabResolver` / `PageLayoutTabController` (`create`, `update`, `destroy`), `PageLayoutWidgetService` / `PageLayoutWidgetResolver` / `PageLayoutWidgetController` (`create`, `update`, `destroy`) с проверкой `values` и `redacted` (`name`, `title`, `position`, `icon`, `conditionalDisplay`, `conditionalAvailabilityExpression`, `gridPosition`, `configuration`, `overrides`).
   - Составные операции `PageLayoutUpdateService.updatePageLayoutWithTabs` (создание/обновление/переопределение/деактивация/удаление вкладок и виджетов в одном батче), `PageLayoutResetService` (`resetPageLayoutWidgetToDefault`, `resetPageLayoutTabToDefault`, `resetPageLayoutToDefault`), `PageLayoutDuplicationService.duplicate`, `DashboardDuplicationService.duplicateDashboard`, `DashboardToPageLayoutSyncService`, AI-инструменты дашбордов и `seedPageLayouts`.
   - Каскадные мутации:
     - удаление `pageLayoutTab`, на которую ссылается `pageLayout.defaultTabToFocusOnMobileAndSidePanelId` (`ON DELETE SET NULL` -> `pageLayout:update` + `pageLayoutTab:delete` + `pageLayoutWidget:delete`);
     - удаление `pageLayout` (`ON DELETE CASCADE` -> `pageLayout:delete` + `pageLayoutTab:delete` + `pageLayoutWidget:delete` + `navigationMenuItem:delete` + `commandMenuItem:delete`);
     - удаление `objectMetadata` -> каскадное удаление `pageLayout`, `pageLayoutTab`, `pageLayoutWidget`, `navigationMenuItem`, `commandMenuItem`;
     - создание и удаление `fieldMetadata` -> создание/удаление `pageLayoutWidget` (`FORM_FIELD` и `FIELD`).
   - Пакетная синхронизация манифеста `runAuditedApplicationMetadataMigration` (`create`, `update`, `delete` для `pageLayout`, `pageLayoutTab`, `pageLayoutWidget`), `reconcileApplicationRoleAndPermissionOperations`, барьер `assertNoRemainingApplicationRoleOrPermissionMetadata` при удалении `core.application` и fail-closed отказ `WorkspaceMigrationRunnerService.executeRun` без активного контекста аудита.
   - Откат транзакции при post-flush tamper-триггере на `core."pageLayout"`, `core."pageLayoutTab"` или `core."pageLayoutWidget"`, а также инвалидация кэша и проброс `NativeTransactionOutcomeUnknownError` при обрыве `COMMIT`.
2. **Существующие регрессионные PostgreSQL-наборы**:
   - `crm-audit-command-menu-item.postgres-spec.ts`
   - `crm-audit-navigation-menu-item.postgres-spec.ts`
   - `crm-audit-application-metadata.postgres-spec.ts`
   - `crm-audit-object-and-field-delete-permissions.postgres-spec.ts`
   - Полный набор из 128 интеграционных сюитов `test/fork-migration/*.postgres-spec.ts` на Schrodinger.
3. **Гейты**:
   - `migration-source-guard.spec.ts` и `enterprise-dependency-guard.spec.ts` (`33` теста).
   - Дифференциальный `tsc --noEmit` в контейнере `twenty_crm_test_build` (`0` новых диагностик).
