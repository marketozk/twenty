# LOG196 - Транзакционный аудит пользовательских индексов метаданных (`indexMetadata` в `core."indexMetadata"`)

## Сводка изменений
- В `crm-audit.types.ts` и `crm-audit-transaction-context.ts`:
  - добавлен вид ресурса `'indexMetadata'` с `ADMINISTRATIVE_ACTIONS.indexMetadata = ['create', 'update', 'delete']`;
  - добавлен `CATALOG.indexMetadata` с `values: ['applicationId', 'objectMetadataId', 'indexType', 'isCustom', 'isUnique', 'isSystemSideEffect']` и `redacted: ['name', 'indexWhereClause']`.
- Добавлен модульный раннер [index-metadata-audit.ts](../../../../packages/twenty-server/src/engine/core-modules/crm-audit/index-metadata-audit.ts):
  - `projectIndexMetadata`, `isAuditedCustomIndexAction`, `captureIndexMetadataAudit`, `withIndexMetadataAudit`, `getIndexMetadataAudit` и `runAuditedIndexMetadataMigration` с регистрацией в `registerMetadataAuditScopeCheck`, блокировками `core.workspace` (`FOR NO KEY UPDATE`) и `core."indexMetadata"` (`ORDER BY id FOR UPDATE`), проверкой `isCustom === true` и целевого `objectMetadataId` / `expectedDeleteId`, резолвом имперсонации и пост-flush сверкой состояния.
- В `IndexMetadataResolver` и `IndexMetadataService`:
  - `createOneIndex` / `createOne` и `deleteOneIndex` / `deleteOne` синхронно захватывают `auditIdentity` до первого `await` и выполняют миграцию внутри `withIndexMetadataAudit`.
- В `WorkspaceMigrationRunnerService.executeRun` и `WorkspaceMigrationValidateBuildAndRunService`:
  - подключён эксклюзивный владелец `indexMetadataAudit` (с сохранением `deferredActions` для `buildIndex`, `dispatchAfterCommit` после `COMMIT`, `hasSchemaMetadataChanged` и `executeActionRollbackHandler` при откате);
  - добавлен fail-closed барьер `isAuditedCustomIndexAction` на неаудируемые миграции пользовательских индексов (`isCustom === true`), не затрагивающий системные side-effect индексы вне audit scope.
- В `application-metadata-audit.ts`:
  - добавлено чтение, аудит (`create`, `update`, `delete`) и пост-flush сверка `core."indexMetadata"` в `runAuditedApplicationMetadataMigration` (при наличии таблицы по `to_regclass`), а также проверка остатков `core."indexMetadata"` в `assertNoRemainingApplicationRoleOrPermissionMetadata`.
- В тестах `fork-migration`:
  - добавлен реальный PostgreSQL-спек [crm-audit-index-metadata.postgres-spec.ts](../../../../packages/twenty-server/test/fork-migration/crm-audit-index-metadata.postgres-spec.ts) (4 сценария).

## Артефакты
- [Дизайн](design.md)
- [Ревью дизайна](design-review.md)
- [Исследование тестов](test-research.md)
- [Ревью кода](review.md)
- [Результаты проверок](results.json)
- [Дифференциальный typecheck](typecheck-differential.json)
- [Снимок исходников](source-snapshot.json)
- [Лог регрессии](regression.log)
- [Следующая граница](next-boundary.md)
