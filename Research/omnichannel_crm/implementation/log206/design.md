# LOG-206 Design: Audited `TrashCleanupService` + Durable `FILES` Hard-Delete on `UPDATE` `toRemove`

## 1. Цель и границы
Закрыть два оставшихся пробела контура удаления записей и файлов в рамках `ROB-765`:

1. **Перевести `TrashCleanupService` на `nativeAudit` для покрытых CRM-объектов** (`company`, `person`, `opportunity` и custom objects, определяемых единым предикатом `isNativeCrmAuditMetadata`):
   - каждый батч физического удаления в корзине для покрытого объекта выполняется в `runInWorkspaceTransaction(..., { commitOutcome: 'strict', nativeAudit: { operationId: randomUUID(), systemActorId: 'trash_cleanup', correlationId } })`, где `correlationId` общий на один запуск `cleanupWorkspaceTrash`;
   - непокрытые объекты (например, `messageParticipant` и прочие системные/messaging/timeline объекты) продолжают удаляться с `{ commitOutcome: 'strict' }` без `nativeAudit`;
   - благодаря единому `WorkspaceRepository.runMutation({ kind: 'delete', ... })`, физическое удаление покрытой записи в корзине автоматически получает `crmRecord:delete`, аудит FK-эффектов (`CASCADE`/`SET NULL`), `crmFile:update` + долговечное намерение `delete_filesFieldFiles` в `core."deferredWorkspaceMigrationAction"` и пост-коммитный запуск `FilesFieldDeletionListener.handleDestroyedEvent` -> `workspaceQueue`;
   - детерминированные fail-closed отказы покрытия на отдельных записях батча изолируются через поштучный аудируемый fallback (без ослабления fail-closed гарантии и без poison pill для остальных записей и объектов воркспейса).
2. **Подключить `UPDATE` `toRemove` в `native-crm-audit-files.ts` к тому же долговечному `delete_filesFieldFiles` owner**:
   - при удалении ссылки на файл через `UPDATE` (`update` / `updateMany` / `runMutation({ kind: 'update' })`) на покрытом CRM-объекте:
     - `core.file` переводится в `deletedAt = CURRENT_TIMESTAMP` и `settings = '{"isTemporaryFile":false,"toDelete":true}'::jsonb`;
     - в той же транзакции проверяется допустимость удаляемого файла (`UPLOADED`, путь `files-field/...`, `isTemporaryFile === false`, `toDelete === false`, UUID `applicationId`), записывается `crmFile:update` с `fileParent` (`changedFields` включает `deletedAt` и `settings`), и атомарно вставляется одно намерение `delete_filesFieldFiles` в `core."deferredWorkspaceMigrationAction"`;
   - `FilesFieldDeletionListener` получает обработчик `@OnDatabaseBatchEvent('*', DatabaseEventAction.UPDATED)` (`handleUpdatedEvent`), который для покрытых CRM-объектов с `FILES`-полями, затронутыми удалением файла, ставит в `workspaceQueue` выполнение `deferredWorkspaceMigrationActions` (а при потере события долговечный `PENDING` intent всё равно докручивается воркером).
   - Непокрытые объекты и `toAdd`/`toUpdate` поведение не меняются.

Вне границ `LOG-206`:
- расширение FK-покрытия `prepareNativeCrmDeleteEffects` на непокрытые таблицы (`timelineActivity`, `noteTarget`, `taskTarget`, `attachment` и т.д.);
- оставшиеся session lifecycle пути (`logout`, `refresh`, `SSO`, `token`, `impersonation`);
- post-rollback denied/failed audit;
- оставшиеся native/core/metadata writers;
- HTTP/JWT приёмка и выкат.

## 2. Анализ вариантов и выбор

### 2.1. Определение покрытого объекта в `TrashCleanupService`
- **Вариант A (выбран)**: в `cleanupWorkspaceTrash` проверять `shouldAudit = isNativeCrmAuditMetadata(object, workspaceId)` напрямую по `FlatObjectMetadata` из `flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps({ workspaceId, flatMapsKeys: ['flatObjectMetadataMaps'] })` (тот же источник метаданных, которым пользуется `FilesFieldDeletionListener`), а в тестовом моке `omni-parent-lifecycle.postgres-spec.ts` отдавать реальный `FlatObjectMetadata` из `getWorkspaceContext().flatObjectMetadataMaps` вместо урезанного `{ nameSingular, id }`.
  - Плюсы: ноль новых импортов в Enterprise-достижимые модули (`orm-workspace-context.storage.ts` и `find-flat-entity-by-id-in-flat-entity-maps.util.ts` находятся в Enterprise-графе и запрещены гвардом `check_enterprise_dependencies.py`); `omni-parent-lifecycle.postgres-spec.ts` заодно реально тестирует `TrashCleanupService` с включённым `nativeAudit` для `person`.
- **Вариант B (отклонён)**: резолвить метаданные в `TrashCleanupService` через `getWorkspaceContext()` и `findFlatEntityByIdInFlatEntityMaps`.
  - Минус: нарушает границу Enterprise (`check_enterprise_dependencies.py --verify-baseline` отклоняет оба ребра).
- **Вариант C (отклонён)**: всегда передавать `nativeAudit` для всех объектов.
  - Минус: нарушает границу покрытия `ROB-765` и ломает удаление непокрытых объектов (например, `messageParticipant`).

### 2.2. Однотранзакционная страница и изоляция poison pill в `TrashCleanupService`
- В `deleteSoftDeletedRecords` для каждой страницы сохраняется **одна транзакция** `runInWorkspaceTransaction(..., { commitOutcome: 'strict', ...(shouldAudit ? { nativeAudit: { operationId: randomUUID(), systemActorId: 'trash_cleanup', correlationId } } : {}) })`:
  - `withNativeCrmAuditTransaction` выполняет `pg_advisory_xact_lock`, проверку повторного `operationId` и `verifyCrmAuditPrivileges`, но при 0 удалённых записях не вставляет ни одной строки в `crm_audit."crmAuditEntry"`. Поскольку `TrashCleanupCronJob` запускается 1 раз в сутки, эти 3 лёгких запроса на пустой покрытый объект приемлемы, а однотранзакционная схема не добавляет лишнего `pool.connect()` (сохраняет инвариант race-теста `omni-parent-lifecycle.postgres-spec.ts:389-424`) и не вводит TOCTOU-фазы.
- **Изоляция детерминированных fail-closed отказов покрытия (закрытие B1)**:
  - В реальном воркспейсе у отдельных мягко-удалённых записей `company`/`person`/`opportunity` могут быть входящие FK из ещё непокрытых таблиц (`timelineActivity`, `noteTarget`, `taskTarget`, `attachment`, email `messageParticipant`), транзитивные FK, omni-защищённые `CASCADE`-потомки или некорректные `core.file`.
  - Без изоляции отказ одной такой записи откатывал бы все до 1000 записей батча и обрывал очистку всех остальных объектов воркспейса навсегда (вечный poison pill на первой записи `ORDER BY "deletedAt" ASC, "id" ASC`).
  - Решение (строго fail-closed: ни одна покрытая запись никогда не удаляется без аудита):
    1. Внутри батчевой транзакции до `repository.runMutation` сохраняется `pageSnapshot = { last, count: records.length, candidateIds: ids }`.
    2. Если батчевая транзакция откатилась с `error`:
       - при `isTransactionUnsafeToRetry(error)` (включая `NativeTransactionOutcomeUnknownError`) или при любой ошибке, **не** входящей в узкий whitelist `isTrashAuditCoverageRejection(error)` (инфраструктурные/БД ошибки, `verifyCrmAuditPrivileges`, отказ вставки в `crm_audit."crmAuditEntry"`, deadlock, timeout и т.д.) -> немедленный `throw error` без повторов и без пропуска;
       - при `isTrashAuditCoverageRejection(error)` (узкий whitelist точных сообщений fail-closed барьеров FK-покрытия, omni-защиты потомков и eligibility `core.file`):
         - если `pageSnapshot.candidateIds.length === 1`: логируется `warn` (`workspaceId`, `objectName`, `recordId`, причина - без клиентских данных), запись остаётся в корзине нетронутой, `deleted = 0`, `cursor` продвигается к `pageSnapshot.last`;
         - если `pageSnapshot.candidateIds.length > 1`: выполняется поштучный аудируемый прогон `deleteAuditedCandidatesOneByOne`: для каждого `candidateId` открывается отдельная транзакция `runInWorkspaceTransaction(..., { commitOutcome: 'strict', nativeAudit: { operationId: randomUUID(), systemActorId: 'trash_cleanup', correlationId } })`, которая заново перепроверяет `deletedAt < cutoffDate`, `findOmniProtectedParentIds` и `findOmniNativeWriteOwnedRecords` и выполняет `repository.runMutation({ kind: 'delete', ... })`:
           - чистые записи батча удаляются с полным аудитом;
           - конкретная запись, давшая `isTrashAuditCoverageRejection`, логируется `warn` и пропускается без удаления;
           - любая `isTransactionUnsafeToRetry` или не-покрытие ошибка в поштучном прогоне немедленно пробрасывается наверх;
           - после обхода страницы `cursor` продвигается к `pageSnapshot.last`.
- Покрытые записи с непокрытыми входящими FK (например `timelineActivity`) честно остаются в корзине с предупреждением в логе до расширения покрытия `prepareNativeCrmDeleteEffects` (фиксируется в `rob765-progress.md`).

### 2.3. Подключение `UPDATE` `toRemove` к `delete_filesFieldFiles`
- Выделяются общие внутренние helpers в `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-files.ts`:
  - `assertEligibleForAuditedFileRemoval(row)` - единая проверка `status === 'UPLOADED'`, `path.startsWith('files-field/') && path.length > 'files-field/'.length`, `settings?.isTemporaryFile === false && settings?.toDelete === false`, UUID `applicationId`;
  - `persistFilesFieldHardDeleteIntent(executor, workspaceId, deletedFiles)` - атомарная вставка одного `PENDING` намерения `delete_filesFieldFiles` (`version: 1`, `nextFileIndex: 0`, `sourceOperationId`, опциональный `correlationId`, отсортированный список `files: [{ fileId, objectMetadataId, recordId, fieldMetadataId }]`) в `core."deferredWorkspaceMigrationAction"`.
- В `createNativeCrmAuditFilesStore`:
  1. Добавить `"applicationId"` в `FileRow` и `columns`.
  2. Явно запретить `mode === 'create' && action === 'toRemove'` (`throw new Error('Native file insert cannot remove files')`).
  3. В `readFiles`: для каждого залоченного `row`, у которого `owners.get(row.id.toLowerCase())?.action === 'toRemove'`, вызвать `assertEligibleForAuditedFileRemoval(row)` до любых мутаций родителя или `core.file`.
  4. В `apply`:
     - для `owner.action === 'toRemove'` обновить `core.file`:
       ```sql
       UPDATE core.file
       SET "deletedAt"=CURRENT_TIMESTAMP,
           settings='{"isTemporaryFile":false,"toDelete":true}'::jsonb,
           "updatedAt"=CURRENT_TIMESTAMP
       WHERE "workspaceId"=$1 AND id=$2 AND "deletedAt" IS NULL
       RETURNING ...
       ```
     - в пост-проверке для `toRemove` требовать:
       `row.deletedAtSnapshot !== null && row.settings?.isTemporaryFile === false && row.settings?.toDelete === true`;
     - после проверки `parentFields` и записи всех `crmFile:update` собрать все `removedFiles` (`owner.action === 'toRemove'`) и при `removedFiles.length > 0` вызвать `persistFilesFieldHardDeleteIntent(executor, workspaceId, removedFiles)`.

### 2.4. Согласованная нормализация UUID в `UPDATE` / `updateMany` / `createNativeCrmAuditFilesStore` (закрытие M1)
- В `packages/twenty-server/src/engine/twenty-orm/repository/workspace-repository.ts`:
  - вынести небольшой helper `normalizeNativeFilesFieldIds(data, fileColumns)` и применить его после `assertNativeCrmAuditWriteSupported` в `runBatchUpdate` и `runMutation` (`kind === 'update'`), точно так же как это уже сделано в `runInsert:1154-1159` (`file.fileId.toLowerCase()`).
  - благодаря этому `FilesFieldSync.computeFilesFieldDiff` и `validateAndEnrichFileDiffs` (`existingFileMap.get(file.fileId)`) всегда работают с каноническим нижним регистром UUID, и переименование `label` с `fileId` в верхнем регистре не превращается в ложное `toAdd + toRemove`.
- В `createNativeCrmAuditFilesStore`:
  - валидировать `UUID_PATTERN` для `file.fileId`, `parentRecordId`, `shape.objectMetadataId`, `field.fieldMetadataId`;
  - нормализовать в нижний регистр `owners`, `plannedRecordIds`, `written`, `readFiles(ids)` и сравнение `parentFields`.

### 2.5. Пост-коммитный запуск воркера в `FilesFieldDeletionListener` для `DatabaseEventAction.UPDATED`
- Добавить `@OnDatabaseBatchEvent('*', DatabaseEventAction.UPDATED)` -> `handleUpdatedEvent(payload: WorkspaceEventBatch<ObjectRecordUpdateEvent>)`.
- Ранние выходы:
  1. Если `!isDefined(this.coreDataSource) || !isDefined(this.workspaceQueueService) || !isDefined(payload.events) || payload.events.length === 0` -> `return` (до чтения кэша метаданных).
  2. Найти `flatObjectMetadata` по `payload.objectMetadata.nameSingular`. Если не найден или `!isNativeCrmAuditMetadata(flatObjectMetadata, workspaceId)` -> `return`.
  3. Собрать `filesFields` (`field.type === FieldMetadataType.FILES`). Если `filesFields.length === 0` -> `return`.
  4. Проверить события батча функцией `hasPotentialFilesFieldRemoval(payload.events, filesFieldNames)`:
     - для каждого `event`:
       - если `Array.isArray(event.properties?.updatedFields)` и ни одно поле не входит в `filesFieldNames` -> пропустить событие;
       - для каждого релевантного `fieldName` (пересечение с `updatedFields`, либо все `filesFieldNames` если `updatedFields` не массив):
         - если `event.properties?.before === null || typeof event.properties?.before !== 'object'` -> вернуть `true` (консервативный fallback);
         - прочитать `beforeValue = before[fieldName]`, `afterValue = after?.[fieldName]`:
           - если `beforeValue === null` -> нет удалённых файлов в этом поле, продолжить;
           - если `!Array.isArray(beforeValue)` (включая `undefined` при наличии `fieldName` в `updatedFields` или не-массив) -> вернуть `true` (консервативный fallback);
           - если `beforeValue.length === 0` -> продолжить;
           - если `!Array.isArray(afterValue)` -> вернуть `true`;
           - собрать `afterIds = new Set(...)` (lowercase валидные `fileId` из `afterValue`); если в `beforeValue` есть элемент без валидного `fileId` или с `fileId`, отсутствующим в `afterIds` -> вернуть `true`.
     - Если ни одно событие не показало потенциальное удаление файла (`toAdd`, переименование `label`, правка других полей) -> `return` без SQL-запросов.
  5. При наличии потенциального удаления файла: выполнить 1 индексный запрос `SELECT 1 FROM core."deferredWorkspaceMigrationAction" WHERE "workspaceId" = $1 AND name = $2 AND status = 'PENDING' LIMIT 1`. Если строка есть -> `enqueueDeferredWorkspaceMigrationActions(this.workspaceQueueService, workspaceId, ...)`.
- В `handleDestroyedEvent` обновить устаревший комментарий в строке 147 (`// Distinguish audited deletes (row already soft-retired with toDelete:true) from un-audited deletes.`), логику не ломать.

## 3. Проверка Enterprise-границ
- `trash-cleanup.service.ts`: новые импорты (`randomUUID`, `isNativeCrmAuditMetadata`, `isTransactionUnsafeToRetry`, `findFlatEntityByIdInFlatEntityMaps`, `getWorkspaceContext`) не создают новых рёбер в Enterprise-достижимые модули; проверяется `check_enterprise_dependencies.py --verify-baseline`.
- `native-crm-audit-files.ts`, `workspace-repository.ts`: новых внешних импортов нет.
- `files-field-deletion.listener.ts`: только type-only импорт `ObjectRecordUpdateEvent` из `twenty-shared/database-events`.

## 4. Изменяемые и новые файлы
1. `packages/twenty-server/src/engine/trash-cleanup/services/trash-cleanup.service.ts`
2. `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-files.ts`
3. `packages/twenty-server/src/engine/twenty-orm/repository/workspace-repository.ts`
4. `packages/twenty-server/src/engine/core-modules/file/files-field/listeners/files-field-deletion.listener.ts`
5. `packages/twenty-server/test/fork-migration/crm-audit-native-files.postgres-spec.ts`
6. `packages/twenty-server/test/fork-migration/crm-audit-trash-and-file-remove.postgres-spec.ts` (новый)
