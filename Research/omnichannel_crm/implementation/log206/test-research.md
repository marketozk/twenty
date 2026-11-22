# LOG-206 Test Research

## 1. Целевые сценарии нового PG-теста (`crm-audit-trash-and-file-remove.postgres-spec.ts`)
Тест выполняется против реального PostgreSQL 17 с полными fork-миграциями (`coreSchema: 'fork'`, `useStandardForeignKeyActions: true`), явным пересозданием FK `_customCase.companyId` с `ON DELETE CASCADE` (плюс стандартные `ON DELETE SET NULL` на `person.companyId` / `opportunity.companyId`), реальной ролью `runtimeDatabaseUrl`, реальными `TrashCleanupService`, `WorkspaceOrmManager` / `WorkspaceDataSource` / `WorkspaceRepository`, `FilesFieldDeletionListener` и `DeleteFilesFieldFilesDeferredActionHandlerService`:

1. **`TrashCleanupService` на покрытых CRM-объектах (`company`, `person`, `opportunity`, `customCase`)**:
   - мягко удалённые записи старше retention (`deletedAt < cutoffDate`) с `FILES` на родителе (`company`), с `CASCADE`-потомком (`_customCase`, тоже с `FILES`) и `SET NULL`-связью (`person.companyId`) удаляются через `TrashCleanupService.cleanupWorkspaceTrash`;
   - в `crm_audit."crmAuditEntry"` в рамках одного `operationId` и общего `correlationId` фиксируются:
     - `crmRecord:delete` с `actor: { kind: 'system', id: 'trash_cleanup' }` для родителя и `CASCADE`-потомка;
     - `crmRecord:update` для `SET NULL`-соседа;
     - `crmFile:update` (`deletedAt`, `settings`) с точным `fileParent` для файлов родителя и `CASCADE`-потомка;
   - в `core."deferredWorkspaceMigrationAction"` появляется `PENDING` намерение `delete_filesFieldFiles` с `sourceOperationId` и `correlationId` из прогона корзины;
   - `WorkspaceEventEmitter` получает `DatabaseEventAction.DESTROYED` после коммита; `FilesFieldDeletionListener.handleDestroyedEvent` направляет задачу в `workspaceQueue` (и НЕ ставит `FilesFieldDeletionJob` в `deleteCascadeQueue`);
   - `DeleteFilesFieldFilesDeferredActionHandlerService` физически удаляет файлы в `FileStorageService`, удаляет строки `core.file`, пишет `crmFile:delete` с тем же `correlationId` и `causationId = sourceOperationId`, `fileParent` и `deletedRecord: { access: 'currentWorkspaceAdministration' }`, и освобождает квоту `releaseStorageStock` после коммита.
2. **Изоляция poison pill, непокрытые объекты и `NativeTransactionOutcomeUnknownError` в `TrashCleanupService`**:
   - если в одном батче есть 1 запись `company` с непокрытым входящим FK (например, `messageParticipant` / другая непокрытая ссылка) или невалидным `core.file` и 2 чистых просроченных `company` + последующий объект `person`:
     - поштучный аудируемый fallback удаляет чистые `company` и `person` с полным аудитом;
     - проблемная `company` остаётся в корзине нетронутой (fail-closed, без удаления и без частичного аудита);
   - если отказ НЕ относится к покрытию (например, `BEFORE INSERT` триггер сбоя на `crm_audit."crmAuditEntry"`): ошибка немедленно пробрасывается наверх (не проглатывается);
   - мягко удалённый непокрытый объект (`messageParticipant`) удаляется `TrashCleanupService` без создания записей в `crm_audit."crmAuditEntry"`;
   - при `lost COMMIT ack` (`NativeTransactionOutcomeUnknownError`) в `TrashCleanupService`: ошибка пробрасывается наверх без `ROLLBACK`, без повторного батча, а `PENDING` intent `delete_filesFieldFiles` остаётся в БД и докручивается воркером до `crmFile:delete`.
3. **`UPDATE` `toRemove`, замена файла (`toAdd` + `toRemove`) и смешанный регистр UUID end-to-end**:
   - на покрытом CRM-объекте (`company`, `customCase`) удаление файла через `UPDATE` (`documents: []`), переименование `label` с `fileId` в верхнем регистре (`toUpdate` без `toRemove`) и замена файла `A -> B` (`toAdd` B + `toRemove` A в одном `UPDATE` с верхним регистром `fileId`):
     - `A` получает `deletedAt !== null` и `settings: { isTemporaryFile: false, toDelete: true }`, `B` получает `deletedAt === null` и `settings: { isTemporaryFile: false, toDelete: false }`;
     - пишутся `crmRecord:update`, `crmFile:update` для `A` и `B` под одним `operationId`;
     - в `core."deferredWorkspaceMigrationAction"` создаётся 1 `PENDING` intent `delete_filesFieldFiles`, содержащий ТОЛЬКО `A` (не `B`);
     - `FilesFieldDeletionListener.handleUpdatedEvent` на `UPDATED`:
       - при удалении/замене файла ставит `workspaceQueue` (`RUN_DEFERRED_WORKSPACE_MIGRATION_ACTIONS_JOB_NAME`) и НЕ ставит `FilesFieldDeletionJob`;
       - при простом переименовании `label`, добавлении файла (`toAdd` без `toRemove`) или изменении другого поля (`name`) НЕ делает запрос в `coreDataSource` и НЕ ставит задачи в очереди;
       - при пустом `events: []` или непокрытом объекте НЕ делает запросов в `coreDataSource`;
     - `DeleteFilesFieldFilesDeferredActionHandlerService` докручивает `A` до физического удаления в хранилище, удаления строки `core.file`, записи `crmFile:delete` с `fileParent` и `deletedRecord: { access: 'currentWorkspaceAdministration' }`, `releaseStorageStock`, не трогая `B`;
     - ни в `crmAuditEntry`, ни в `deferredWorkspaceMigrationAction` нет утечки приватных строк (`private`, `label`, `path`).
4. **Отказ и откат на `UPDATE` `toRemove` с невалидным `core.file`**:
   - файл с `status: 'PENDING'`, `path` без префикса `files-field/`, `applicationId: null`, или уже `toDelete: true` -> транзакция откатывается полностью, ни `core.file`, ни родительская запись, ни `crmAuditEntry`, ни `deferredWorkspaceMigrationAction` не меняются.

## 2. Существующие PG-тесты для совместного целевого прогона
1. `test/fork-migration/crm-audit-trash-and-file-remove.postgres-spec.ts` (новый)
2. `test/fork-migration/crm-audit-native-files.postgres-spec.ts` (обновлённый, вкл. тест `BEFORE UPDATE` триггера на `core.file`, сохраняющего `settings.toDelete = false` при `toRemove`)
3. `test/fork-migration/crm-audit-file-hard-delete.postgres-spec.ts`
4. `test/fork-migration/omni-parent-lifecycle.postgres-spec.ts`
5. `test/fork-migration/crm-audit-native-delete.postgres-spec.ts`
6. `test/fork-migration/crm-audit-native-create.postgres-spec.ts`
7. `test/fork-migration/crm-audit-native-update.postgres-spec.ts`

## 3. Гварды, дифференциальный typecheck и полная регрессия
- `check_enterprise_dependencies.py --verify-baseline` (`0` нарушений)
- `verify_fork_migration_sources.py` / `check_fork_migration_sources.py` + Python unit tests
- Дифференциальный `tsgo --noEmit` против `HEAD` (`0` новых/changed-file/changed-code диагностик)
- Полная PG 17 регрессия на Schrodinger
- SHA-256 сверка исходников до/после и очистка стенда
