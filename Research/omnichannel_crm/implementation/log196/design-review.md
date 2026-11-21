# LOG196 - Независимое ревью дизайна

## Вердикт
`pass` (блокеров не выявлено)

## Проверенные риски и граничные случаи
1. **Системные side-effect индексы при `createOneObject` / `createOneField` / `updateOneField`**:
   - Барьер `isAuditedCustomIndexAction` в `WorkspaceMigrationRunnerService.executeRun` срабатывает на пользовательские индексы (`isCustom === true` на create/update/delete) и не ломает неаудируемые пути создания объектов/полей с системными side-effect индексами (`isCustom: false`, `isSystemSideEffect: true`). При этом внутри `runAuditedApplicationMetadataMigration` (`manifest`, `objectDelete`, `fieldDelete`) аудируются все изменения `core."indexMetadata"`.
2. **Deferred action `buildIndex` и rollback**:
   - `IndexMetadataService.createOne` может создавать отложенное действие `buildIndex` (`deferredActions`). В `WorkspaceMigrationRunnerService.executeRun` для `indexMetadataAudit` сохранён вызов `deferredWorkspaceMigrationActionRunnerService.dispatchAfterCommit` строго после успешного `COMMIT` и `executeActionRollbackHandler` при откате до `COMMIT`.
3. **Совместимость со старыми тестами**:
   - В `application-metadata-audit.ts` чтение `core."indexMetadata"` защищено проверкой `existingTables.has('indexMetadata')` (`to_regclass`), поэтому старые изолированные PG-тесты без таблицы `core."indexMetadata"` продолжают работать без регрессий.
4. **Сокрытие имени индекса и `indexWhereClause`**:
   - Поля `name` и `indexWhereClause` помещены в `CATALOG.indexMetadata.redacted` и не попадают в открытый `values`.
5. **Граница Enterprise**:
   - `index-metadata` и `index-metadata-audit.ts` не имеют зависимостей от Enterprise-модулей.
