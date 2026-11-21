# LOG196 - Дизайн транзакционного аудита пользовательских индексов метаданных (`indexMetadata` в `core."indexMetadata"`)

## Цель и границы
Закрыть транзакционный аудит полного жизненного цикла пользовательских индексов метаданных (`core."indexMetadata"`):
- Прямые мутации через `IndexMetadataResolver` (`createOneIndex`, `deleteOneIndex`) и `IndexMetadataService` (`createOne`, `deleteOne`)
- Новый модульный раннер `packages/twenty-server/src/engine/core-modules/crm-audit/index-metadata-audit.ts` (по паттерну `core-workflow-and-view-audit.ts`), интегрированный в `WorkspaceMigrationRunnerService.executeRun` (включая откат действий при сбое до `COMMIT` и отложенный `dispatchAfterCommit` для `buildIndex` deferred action)
- Fail-closed барьер в `WorkspaceMigrationRunnerService.executeRun` на неаудируемые миграции пользовательских индексов (`isAuditedCustomIndexAction`: `metadataName === 'index'` с `isCustom === true` на create/update/delete), без поломки системных side-effect индексов (`isCustom: false`, `isSystemSideEffect: true`) при неаудируемых путях создания объектов/полей
- Сверка и аудит всех изменений `core."indexMetadata"` (создания, обновления, каскадные удаления при `manifest`, `objectDelete`, `fieldDelete` и удалении приложения) внутри `runAuditedApplicationMetadataMigration`, а также проверка остатков `core."indexMetadata"` в `assertNoRemainingApplicationRoleOrPermissionMetadata`

## Модель аудита и проекция
- Новый `CrmAuditResourceKind`: `'indexMetadata'` в `crm-audit.types.ts`.
- `CATALOG.indexMetadata` в `crm-audit-transaction-context.ts`:
  - `values: ['applicationId', 'objectMetadataId', 'indexType', 'isCustom', 'isUnique', 'isSystemSideEffect']`
  - `redacted: ['name', 'indexWhereClause']` (имя индекса и SQL WHERE-выражение редактируются в `redacted` и не попадают в открытый `values`).
- `ADMINISTRATIVE_ACTIONS.indexMetadata`: `['create', 'update', 'delete']`.
- `securityDescriptor`: `{ resourceKind: 'indexMetadata', resourceId, metadataAccess: 'currentWorkspaceAdministration' }`.
- Проекция `projectIndexMetadata(row)`:
  - `applicationId`: `uuid(row.applicationId)` (или `null` если отсутствует)
  - `objectMetadataId`: `uuid(row.objectMetadataId)`
  - `indexType`: `String(row.indexType)` (`'BTREE' | 'GIN'`)
  - `isCustom`: `Boolean(row.isCustom)`
  - `isUnique`: `Boolean(row.isUnique)`
  - `isSystemSideEffect`: `Boolean(row.isSystemSideEffect)`
  - `name`: `String(row.name)` (в `redacted`)
  - `indexWhereClause`: `row.indexWhereClause === null || row.indexWhereClause === undefined ? null : String(row.indexWhereClause)` (в `redacted`)

## Транзакционные раннеры и инварианты
1. `index-metadata-audit.ts`:
   - `captureIndexMetadataAudit({ workspaceId, auditIdentity, expectedAction: 'create' | 'delete', expectedObjectMetadataId?, expectedDeleteId? })` - синхронный захват `auditIdentity` до первого `await`.
   - `withIndexMetadataAudit(request, work)` - `AsyncLocalStorage` с регистрацией через `registerMetadataAuditScopeCheck` (защита от конфликтующих вложенных audit-scopes).
   - `runAuditedIndexMetadataMigration(dataSource, request, actions, mappings, execute)`:
     - `SET LOCAL lock_timeout = '8s'`.
     - Блокирует `core.workspace` (`FOR NO KEY UPDATE`), проверяет `deletedAt IS NULL`.
     - Валидирует `actions`: все actions должны быть `metadataName === 'index'` с `action.type === request.expectedAction`, для `create` проверяется `isCustom === true` и совпадение `objectMetadataId`, для `delete` проверяется совпадение ID с `expectedDeleteId` и `isCustom === true`.
     - Резолвит актора/имперсонацию (`resolveRoleAuditInitiator`).
     - Блокирует `core."indexMetadata"` по `workspaceId` (`ORDER BY id FOR UPDATE`), снимает `beforeMap`.
     - Выполняет `execute(runner)`.
     - Перечитывает `afterMap` (`ORDER BY id FOR UPDATE`), сверяет ровно ожидаемое создание/удаление (запрещает неожиданные изменения/удаления/вставки), фиксирует `indexMetadata:create` или `indexMetadata:delete`, вызывает `audit.flush()` и перепроверяет снимок `core."indexMetadata"` после `flush()`.
2. `application-metadata-audit.ts`:
   - В `readExistingTables`: добавлена проверка `to_regclass('core."indexMetadata"') IS NOT NULL AS "indexMetadata"`.
   - В `runAuditedApplicationMetadataMigration`: при наличии таблицы `core."indexMetadata"` читает `before`/`after` под `ORDER BY id FOR UPDATE`, фиксирует все `indexMetadata:create`, `indexMetadata:update`, `indexMetadata:delete` (включая каскадные удаления при `objectDelete`, `fieldDelete` и удалении приложения), и включает снимок `core."indexMetadata"` в пост-flush сверку.
   - В `assertNoRemainingApplicationRoleOrPermissionMetadata`: проверяет отсутствие оставшихся строк `core."indexMetadata"` данного `applicationId` перед удалением `core.application`.
3. `WorkspaceMigrationRunnerService.executeRun`:
   - Подключает `indexMetadataAudit = getIndexMetadataAudit(workspaceId)` в блок эксклюзивных audit owners (с `executeActionRollbackHandler` при ошибке до `COMMIT` и `dispatchAfterCommit` для `allDeferredActions` после `COMMIT`).
   - В fail-closed барьере добавляет `isAuditedCustomIndexAction(action, allFlatEntityMaps.flatIndexMaps?.byUniversalIdentifier)`.
