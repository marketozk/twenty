# План проверок LOG170 (`crm-audit-navigation-menu-item.postgres-spec.ts`)

Дата: 08.11.2026
Задача: ROB-765 (`LOG170`)

## 1. Целевые сценарии PostgreSQL (`crm-audit-navigation-menu-item.postgres-spec.ts`)

1. **Полный жизненный цикл `navigationMenuItem` через `NavigationMenuItemService`, `NavigationMenuItemResolver` и AI-инструменты**:
   - создание пользовательской папки (`FOLDER`) и вложенных элементов (`LINK`, `VIEW`, `RECORD`) и элементов уровня рабочего пространства (`OBJECT`, `PAGE_LAYOUT`, `AGENT_CHAT_CHANNEL`) записывает `navigationMenuItem:create` с точными `values` (`userWorkspaceId`, `folderId`, `type`, `viewId`, `targetObjectMetadataId`, `targetRecordId`, `pageLayoutId`, `agentChatChannelId`) и редактируемыми маркерами `{ redacted: true }` для `name`, `link`, `icon`, `color`, `position`;
   - обновление (`update` / `updateMany` / `UpdateNavigationMenuItemTool`) перемещает элемент между папками и меняет `name`/`position`/`color`/`icon`/`link`, записывая `navigationMenuItem:update` с корректным `changedFields` и без утечки редактируемых значений; идемпотентный вызов без изменений не создаёт шумовую запись;
   - удаление папки (`delete` / `deleteMany` / `DeleteNavigationMenuItemTool`) атомарно удаляет саму папку и вложенные элементы, записывая `navigationMenuItem:delete` для каждого удалённого элемента.
2. **Отказы безопасности и владения (fail-closed)**:
   - попытка пользователя обновить или удалить чужой пользовательский `navigationMenuItem` (`userWorkspaceId !== authUserWorkspaceId`), либо создать/обновить элемент с подменённым `userWorkspaceId` при несовпадающем `workspaceMember` или `coreUser`, отклоняется без изменения БД и без записи аудита;
   - попытка выполнить миграцию `navigationMenuItem` или удалить `view` / `pageLayout` / `agentChatChannel` в `WorkspaceMigrationRunnerService.executeRun` без контекста аудита отклоняется fail-closed.
3. **Фоновая очистка `NavigationMenuItemDeletionService` / `NavigationMenuItemDeletionJob`**:
   - удаление элементов меню для удалённых записей (`targetRecordId`) и представлений (`viewId`) записывает `navigationMenuItem:delete` с системным субъектом `navigation-menu-item:deleted-records-cleanup` (`source: 'job'`).
4. **Сопутствующее создание и родительские каскады (`ObjectMetadataService.createOneObject`, `ViewService.destroyOne`, `PageLayoutService.destroy`, `AgentChatChannelMetadataService.deleteChannel`)**:
   - создание объекта с `navigationMenuItem` записывает `navigationMenuItem:create`;
   - жёсткое удаление представления (`ViewService.destroyOne`), макета страницы (`PageLayoutService.destroy`) и канала чата агента (`AgentChatChannelMetadataService.deleteChannel`) каскадно удаляет связанные строки `core."navigationMenuItem"` (включая вложенные элементы папок) и записывает `navigationMenuItem:delete`.
5. **Пакетные миграции приложений (`withApplicationMetadataAudit`, `ObjectMetadataService.deleteOneObject`, `ApplicationSyncService.uninstallApplication`) и барьер `ApplicationService.delete`**:
   - синхронизация манифеста приложения создаёт, обновляет и удаляет `navigationMenuItem` с записью `create`/`update`/`delete`, а незапланированная мутация `core."navigationMenuItem"` внутри миграции откатывает транзакцию;
   - удаление объекта (`mode: 'objectDelete'`) и удаление приложения (`uninstallApplication`) каскадно удаляют и аудируют зависимые `navigationMenuItem` (по `targetObjectMetadataId`, `viewId`, `pageLayoutId`, `agentChatChannelId` и `folderId`), а прямой вызов `assertNoRemainingApplicationRoleOrPermissionMetadata` при оставшихся `navigationMenuItem` блокирует удаление приложения.
6. **Отказоустойчивость (`NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`)**:
   - при сбое записи аудита до коммита транзакция откатывается и `core."navigationMenuItem"` остаётся неизменным;
   - при `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError` кэш `flatNavigationMenuItemMaps` принудительно инвалидируется, а ошибка пробрасывается вызывающему коду без маскировки.

## 2. Регрессионные и архитектурные проверки

- Все 17 существующих целевых PostgreSQL-наборов ролей/приложений/членства/2FA/workflow-view + новый набор `crm-audit-navigation-menu-item.postgres-spec.ts` (18 наборов).
- Полный прогон всех 115 PostgreSQL-наборов `fork-migration` и 33 архитектурных/лицензионных guard-тестов на Schrodinger.
- Дифференциальный typecheck (`0` новых диагностик) и сверка SHA-256 хешей всех изменённых файлов.
