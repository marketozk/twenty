# Дизайн LOG170 - транзакционный аудит жизненного цикла и каскадного удаления `navigationMenuItem`

Дата: 08.11.2026
Задача: ROB-765 (Этап 2a - сбор аудита действий)

## 1. Контекст и постановка задачи

В каталоге аудита `CATALOG` (`crm-audit-transaction-context.ts`) ресурс `navigationMenuItem` содержит:
- `values`: `['userWorkspaceId', 'folderId', 'type', 'viewId', 'targetObjectMetadataId', 'targetRecordId', 'pageLayoutId', 'agentChatChannelId']`
- `redacted`: `['name', 'link', 'icon', 'color', 'position']`

До `LOG170` в `ADMINISTRATIVE_ACTIONS.navigationMenuItem` было разрешено только действие `['delete']` (использовалось при удалении `core."userWorkspace"` в `membership-cleanup-audit.ts`, `LOG115`). При этом прямые мутации элементов меню навигации и избранного (`NavigationMenuItemService`, `NavigationMenuItemResolver`, AI-инструменты `create_navigation_menu_item`, `update_navigation_menu_item`, `delete_navigation_menu_item`), фоновая очистка осиротевших ссылок на удалённые записи и представления (`NavigationMenuItemDeletionService` / `NavigationMenuItemDeletionJob`), сопутствующее создание элемента меню при создании объекта (`ObjectMetadataService.createOneObject`), синхронизация манифестов и удаление приложений (`ApplicationManifestMigrationService`, `ApplicationSyncService.uninstallApplication`, `TwentyStandardApplicationService`, `ApplicationService.delete`), а также каскадные удаления `ON DELETE CASCADE` при удалении родительских сущностей (`objectMetadata`, `view`, `pageLayout`, `agentChatChannel`, вложенных папок `folderId`) выполнялись без записи в `crm_audit."crmAuditEntry"`.

Цель `LOG170`:
1. Разрешить полный набор административных действий `['create', 'update', 'delete']` для `navigationMenuItem` в `crm-audit-transaction-context.ts` с сохранением обратной совместимости с `membership-cleanup-audit.ts`.
2. Закрыть транзакционным аудитом все точки создания, обновления, прямого и каскадного удаления `core."navigationMenuItem"` с fail-closed барьером в `WorkspaceMigrationRunnerService.executeRun`.

## 2. Рассмотренные варианты архитектуры

### Вариант 1 (рекомендуемый): выделенный модуль `navigation-menu-item-audit.ts` + расширение `application-metadata-audit.ts` и fail-closed барьера в `WorkspaceMigrationRunnerService`

- В `crm-audit-transaction-context.ts` расширяется `ADMINISTRATIVE_ACTIONS.navigationMenuItem = ['create', 'update', 'delete']`.
- Создаётся модуль `packages/twenty-server/src/engine/core-modules/crm-audit/navigation-menu-item-audit.ts`:
  - `captureNavigationMenuItemAudit` синхронно до первого `await` захватывает и нормализует идентичность (`userWorkspaceId` / `coreUser` / `workspaceMember`, `apiKey`, `application`, `agent`, либо `system` для фоновых/системных задач и сидера);
  - `withNavigationMenuItemAudit` передаёт одноразовый `NavigationMenuItemAuditRequest` через `AsyncLocalStorage` в `WorkspaceMigrationRunnerService.executeRun` и регистрируется в `registerMetadataAuditScopeCheck`;
  - `runAuditedNavigationMenuItemMigration` выполняет миграцию внутри `runInCoreAuditTransaction`:
    - захватывает `FOR NO KEY UPDATE` на `core.workspace`, проверяет активность вызывающего `userWorkspace` и привязку субъекта `coreUser` / `workspaceMember` к `userWorkspace.userId` (включая проверку `"workspace_<id>"."workspaceMember"` при `actor.kind === 'workspaceMember'`), либо активность `apiKey` / `application` / `agent`;
    - блокирует и снимает снимок всех строк `core."navigationMenuItem"` рабочего пространства (`FOR UPDATE`) до выполнения действий;
    - для операций над пользовательскими элементами (`userWorkspaceId !== null`) в режимах `'create' | 'update' | 'delete'` проверяет внутри транзакции, что вызывающий субъект является аутентифицированным пользователем и владеет элементом (`row.userWorkspaceId === request.authUserWorkspaceId`), а при удалении папки (`type === 'FOLDER'`) все каскадно удаляемые дочерние элементы принадлежат тому же рабочему пространству и (если задан `userWorkspaceId` у папки) тому же `userWorkspaceId`;
    - выполняет действия миграции на том же `QueryRunner`, снимает повторный снимок `core."navigationMenuItem"`, сверяет фактические изменения с запланированными действиями и родительскими каскадами (`view`, `pageLayout`, `agentChatChannel`, `folderId`), проверяет инварианты типов `CHK_navigation_menu_item_type_fields`, записывает `navigationMenuItem:create`, `navigationMenuItem:update` (только при фактическом изменении отслеживаемых или редактируемых полей) и `navigationMenuItem:delete` (`metadataAccess: 'currentWorkspaceAdministration'`), вызывает `audit.flush()` и повторно сверяет снимок после `flush`.
- Подключаются все точки входа:
  - `NavigationMenuItemService` (`create`, `createMany`, `update`, `updateMany`, `delete`, `deleteMany`), `NavigationMenuItemResolver` и AI-инструменты (`CreateNavigationMenuItemTool`, `UpdateNavigationMenuItemTool`, `DeleteNavigationMenuItemTool`);
  - `NavigationMenuItemDeletionService.deleteNavigationMenuItemsForDeletedRecords` (`NavigationMenuItemDeletionJob`);
  - `ObjectMetadataService.createOneObject` (`ObjectMetadataResolver.createOneObject`, `ObjectMetadataController.createOne`, `CreateObjectMetadataTool`, `CreateManyObjectMetadataTool`, `DevSeederMetadataService`);
  - `ViewService.destroyOne` / `deleteOne` (`ViewResolver.deleteView`, `ViewResolver.destroyView`, `ViewController.delete`, `DeleteViewTool`, `PageLayoutUpdateService.destroyOrphanedFieldsWidgetViews`, `PageLayoutResetService`);
  - `PageLayoutService.destroy` / `destroyMany` (`PageLayoutResolver.destroyPageLayout`, `PageLayoutController.destroy`, `DashboardToPageLayoutSyncService`, `DashboardDuplicationService`);
  - `AgentChatChannelMetadataService.deleteChannel` (`AgentChatChannelService.deleteChannel`, `AgentChatChannelResolver.deleteAgentChatChannel`);
  - `seedPageLayouts` (`dev-seeder.workspace-service.ts`).
- В `application-metadata-audit.ts`:
  - `runAuditedApplicationMetadataMigration` блокирует и снимает снимок `core."navigationMenuItem"` до и после миграции, проверяет запланированные `create`/`update`/`delete` и каскадные удаления `navigationMenuItem` (при удалении `objectMetadata`, `view`, `pageLayout`, `agentChatChannel` и родительских папок `folderId`), отклоняет незапланированные мутации `navigationMenuItem` и записывает соответствующие события `navigationMenuItem` (`create`, `update`, `delete`);
  - `reconcileApplicationRoleAndPermissionOperations` дополняется каскадным включением зависимых `navigationMenuItem` при удалении `objectMetadata`, `view`, `pageLayout`, `agentChatChannel` и папок `navigationMenuItem`;
  - `assertNoRemainingApplicationRoleOrPermissionMetadata` проверяет отсутствие оставшихся строк `core."navigationMenuItem"` приложения или ссылающихся на сущности удаляемого приложения перед `DELETE FROM core.application`.
- В `WorkspaceMigrationRunnerService.executeRun`:
  - `'navigationMenuItem'` добавляется в `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES`, а `'view'`, `'pageLayout'`, `'agentChatChannel'` - в `AUDITED_ROLE_AND_PERMISSION_CASCADE_DELETE_METADATA_NAMES` (fail-closed барьер).

### Вариант 2: переписать `NavigationMenuItemService` на прямой SQL в обход `WorkspaceMigrationValidateBuildAndRunService`

- Отвергнут: ломает валидатор `FlatNavigationMenuItemValidatorService`, оптимистичное обновление `flatNavigationMenuItemMaps`, генерацию `metadataEvents` и единый конвейер миграций метаданных.

## 3. Проверка в соответствии с контрактом

- Редактируемые поля `name`, `link`, `icon`, `color`, `position` никогда не попадают в открытом виде в `crm_audit."crmAuditEntry"` (сохраняются как `{ redacted: true }`, а их хеши участвуют в `changedFields`).
- Любая попытка изменить или удалить чужой пользовательский элемент `navigationMenuItem` (`userWorkspaceId !== authUserWorkspaceId`) или подменить `userWorkspaceId` при чужом `workspaceMemberId` / `coreUser` отклоняется внутри транзакции под блокировкой.
- Любая попытка выполнить миграцию `navigationMenuItem` или удалить `objectMetadata`, `view`, `pageLayout`, `agentChatChannel` в `WorkspaceMigrationRunnerService.executeRun` без активного контекста аудита отклоняется fail-closed.
