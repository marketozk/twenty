# LOG166 - архитектурное, security и тестовое ревью дизайна (`design.md` и `test-research.md`)

## 1. Общий вердикт

Архитектура `LOG166` (Вариант 1 - расширение `packages/twenty-server/src/engine/core-modules/crm-audit/application-metadata-audit.ts` режимами `'objectDelete'` и `'fieldDelete'`, синхронный захват контекста аудита до первого `await`, согласование каскадно удаляемых прав через `reconcileApplicationRoleAndPermissionOperations`, закрытие неаудируемой ветки `WorkspaceMigrationRunnerService.executeRun` и точечное ослабление `isEditable` в валидаторах прав только для удаляемых в этой же миграции объектов и полей) является технически обоснованной и согласованной с `LOG111`-`LOG113` и `LOG156`-`LOG165`.

В ходе независимой сверки `design.md` и `test-research.md` с фактической кодовой базой выявлены **4 важных уточнения инвариантов реализации** (порядок блокировок, обработка multi-target `MORPH_RELATION` в `mode: 'fieldDelete'`, фильтрация `deletedAt !== null` с учетом `withDeleted: true` в `WorkspaceCacheRowsBatchLoader`, а также проверка кросс-приложенческого удаления `rowLevelPermissionPredicateGroup`) и **4 дополнительных граничных сценария тестирования**, которые необходимо учесть при реализации.

---

## 2. Линза 1: Архитектура и транзакционные границы

### 2.1. Порядок блокировок и устранение расхождения между разделом 2 и разделом 3.1 `design.md`

- **Наблюдение**:
  - В `design.md:28` (краткое резюме Варианта 1) указана цепочка: `workspace FOR NO KEY UPDATE` -> `application ORDER BY id FOR UPDATE` -> `objectMetadata`/`fieldMetadata` -> 7 таблиц ролей и прав `ORDER BY id FOR UPDATE`.
  - В `design.md:53` (детальная спецификация раздела 3.1) указана обратная последовательность между таблицами прав и таблицами модели данных: сначала `core.workspace` (`FOR NO KEY UPDATE`), затем `core.application` (`ORDER BY id FOR UPDATE`), затем 7 таблиц ролей и прав (`readFullMetadataSnapshot(..., true)` с `ORDER BY id FOR UPDATE`), и после них `core."objectMetadata"` и `core."fieldMetadata"` (`WHERE "workspaceId" = $1 ORDER BY id FOR UPDATE`).
- **Сверка с кодовой базой**:
  - В `packages/twenty-server/src/engine/core-modules/crm-audit/role-permission-audit.ts:336-351, 928-963` транзакции изменения прав захватывают блокировки в порядке: `core.workspace` (`FOR NO KEY UPDATE`) -> `core.application` (`FOR SHARE`) -> `core.role` (`FOR UPDATE`) -> таблицы прав (`objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate` с `ORDER BY id FOR UPDATE`) -> `core."objectMetadata"` (`ORDER BY id FOR SHARE`) -> `core."fieldMetadata"` (`ORDER BY id FOR SHARE`).
- **Требование к реализации**:
  - Необходимо строго следовать порядку из раздела 3.1 (`design.md:53`):
    1. `core.workspace` (`FOR NO KEY UPDATE`);
    2. `core.application` (`WHERE "workspaceId" = $1 ORDER BY id FOR UPDATE`);
    3. 7 таблиц ролей и прав (`readFullMetadataSnapshot(runner, existingTables, workspaceId, true)` в фиксированном порядке `role` -> `roleTarget` -> `rolePermissionFlag` -> `objectPermission` -> `fieldPermission` -> `rowLevelPermissionPredicateGroup` -> `rowLevelPermissionPredicate`, каждая `ORDER BY id FOR UPDATE`);
    4. `core."objectMetadata"` (`WHERE "workspaceId" = $1 ORDER BY id FOR UPDATE`);
    5. `core."fieldMetadata"` (`WHERE "workspaceId" = $1 ORDER BY id FOR UPDATE`).
  - Такой порядок полностью совпадает с относительным порядком блокировок в `role-permission-audit.ts` и исключает взаимные блокировки (deadlocks) при конкурентных операциях над правами и удалением объектов/полей.

### 2.2. Побочные удаления полей: обратные поля связей, соседние таргет-поля `MORPH_RELATION` и головные поля морф-связей

- **Сверка с `fromDeleteFieldInputToFlatFieldMetadatasToDelete` и `findFlatFieldMetadatasRelatedToMorphRelationOrThrow`**:
  - В `packages/twenty-server/src/engine/metadata-modules/flat-field-metadata/utils/from-delete-field-input-to-flat-field-metadatas-to-delete.util.ts:92-102` и `packages/twenty-server/src/engine/metadata-modules/flat-field-metadata/utils/find-flat-field-metadatas-related-to-morph-relation-or-throw.util.ts:20-48` при вызове `FieldMetadataService.deleteOneField` для поля типа `MORPH_RELATION` (как таргет-поля, так и головного поля `isMorphRelationHead`, которое разрешено к удалению на строках 70-73) в `flatFieldMetadatasToDelete` включаются:
    1. само `primaryField`;
    2. все остальные `MORPH_RELATION` поля на том же объекте с тем же `morphId` (включая соседние таргет-поля `T2` и головное поле `H`, у которого `H.universalIdentifier === morphId` и `H.morphId === morphId`);
    3. обратные поля типа `RELATION` (`R1`, `R2`, ...) на целевых объектах для **каждого** таргет-поля данной морф-группы (`T1`, `T2`, ...), а не только для `primaryField` (причем если `primaryField` - это головное поле `H`, то `H.relationTargetFieldMetadataId === null`, а обратные поля `R1`, `R2` ссылаются на `T1.id` и `T2.id`).
- **Риск при буквальном чтении `design.md:64`**:
  - В `design.md:64` для `mode === 'fieldDelete'` сказано, что каждое дополнительное поле в `plannedFieldDeletes` обязано быть парным полем связи (`relationTargetFieldMetadataId`), соседним таргет-полем с тем же `morphId` на том же объекте или головным полем морф-связи (`universalIdentifier === primaryField.morphId`).
  - Если проверить парное поле связи только относительно `primaryField` (`fieldId === primaryField.relationTargetFieldMetadataId`), то при удалении `MORPH_RELATION` с несколькими целевыми объектами обратное поле `R2` второго таргет-поля `T2` (у которого `R2.relationTargetFieldMetadataId === T2.id`, а не `primaryField.id`) будет ошибочно отклонено в `runAuditedApplicationMetadataMigration`.
- **Требование к реализации**:
  1. В `runAuditedApplicationMetadataMigration` для `mode === 'fieldDelete'`:
     - сначала определить множество полей морф-группы на том же объекте (`sameObjectMorphGroupIds`): `primaryField.id` плюс все поля из `beforeFields` с `objectMetadataId === primaryField.objectMetadataId`, которые имеют тот же непустой `morphId` (`nullableUuid(field.morphId) === primaryMorphId` или `uuid(field.universalIdentifier) === primaryMorphId`);
     - разрешать в `plannedFieldDeletes` любое поле из `sameObjectMorphGroupIds`, а также любое обратное поле связи, связанное по `relationTargetFieldMetadataId` с любым полем из `sameObjectMorphGroupIds` (`sameObjectMorphGroupIds.has(nullableUuid(field.relationTargetFieldMetadataId))` или ` fieldId === nullableUuid(morphField.relationTargetFieldMetadataId)`).
  2. В `reconcileApplicationRoleAndPermissionOperations` (`application-metadata-audit.ts:1681-1924`):
     - расширение `deletedFieldUniversalIdentifiers` по `flatFieldMetadataMaps` должно выполняться до неподвижной точки (fixed-point loop):
       - добавлять поля, у которых `objectMetadataUniversalIdentifier` или `relationTargetObjectMetadataUniversalIdentifier` входит в `deletedObjectUniversalIdentifiers`;
       - добавлять поля с тем же `morphId` на том же объекте (если удаляется поле морф-связи в режиме удаления поля или удалены все таргет-поля данного `morphId` на объекте при отсутствии создаваемых полей с этим `morphId`);
       - добавлять поля, у которых `relationTargetFieldMetadataUniversalIdentifier` входит в `deletedFieldUniversalIdentifiers` (или на которые ссылается `relationTargetFieldMetadataUniversalIdentifier` уже удаляемого поля).
     - Это гарантирует, что права на `R2` (обратное поле соседнего морф-таргета `T2`) и на головное поле `H` на целевом объекте (когда удаляется последний морф-таргет при удалении объекта) попадут в `deletedFieldUniversalIdentifiers`.

### 2.3. Формат аргументов `reconcileApplicationRoleAndPermissionOperations` в `ObjectMetadataService` и `FieldMetadataService`

- **Наблюдение**:
  - `reconcileApplicationRoleAndPermissionOperations` (`application-metadata-audit.ts:1720-1734`) принимает `allFlatEntityOperationRecordByMetadataName`, где `flatEntityToDelete` в каждом бакете является словарем `Record<universalIdentifier, Entity>` (и извлекает ключи через `Object.keys(record.fieldMetadata?.flatEntityToDelete ?? {})`).
  - В `ObjectMetadataService.deleteManyObjectMetadatas` (`object-metadata.service.ts:458`) и `FieldMetadataService.deleteOneField` (`field-metadata.service.ts:169`) `validateBuildAndRunWorkspaceMigration` принимает `AllFlatEntityOperationByMetadataName`, где `flatEntityToDelete` - это массив `Entity[]`.
- **Требование к реализации**:
  - Перед вызовом `reconcileApplicationRoleAndPermissionOperations` бакеты `objectMetadata.flatEntityToDelete` и `fieldMetadata.flatEntityToDelete` в `reconcileRecord` должны передаваться как `Record<universalIdentifier, Entity>` (а не как массивы, иначе `Object.keys(...)` вернет индексы массива `'0'`, `'1'`), после чего непустые `Object.values(reconcileRecord.<perm>?.flatEntityToDelete ?? {})` передаются в `allFlatEntityOperationByMetadataName`.

### 2.4. Инвалидация кэша при `ON DELETE SET NULL` на `workspaceMemberFieldMetadataId`

- **Сверка с кодовой базой**:
  - В `packages/twenty-server/src/engine/metadata-modules/flat-entity/constant/all-many-to-one-metadata-relations.constant.ts:455-493` у `rowLevelPermissionPredicate` связи `fieldMetadata`, `workspaceMemberFieldMetadata` и `objectMetadata`, а также у `rowLevelPermissionPredicateGroup` связь `objectMetadata` имеют `inverseOneToManyProperty: null`.
  - Из-за этого `getMetadataNamesToLoadForWorkspaceMigration(['fieldMetadata'])` и `getMetadataNamesToLoadForWorkspaceMigration(['objectMetadata'])` в `WorkspaceMigrationRunnerService.executeRun` (`workspace-migration-runner.service.ts:305-313`) не включают `'rowLevelPermissionPredicate'` и `'rowLevelPermissionPredicateGroup'`.
  - Если удаляется пользовательское поле на `workspaceMember`, на которое ссылается только `rowLevelPermissionPredicate.workspaceMemberFieldMetadataId`, в плане миграции нет действий `rowLevelPermissionPredicate.delete`, поэтому без доработки `flatRowLevelPermissionPredicateMaps` не попадал в `allFlatEntityMapsKeys` и не инвалидировался.
  - Решение в `design.md:86` (добавление `'objectPermission'`, `'fieldPermission'`, `'rowLevelPermissionPredicateGroup'`, `'rowLevelPermissionPredicate'` в `actionsMetadataAndRelatedMetadataNames` при наличии в `actions` любого удаления `objectMetadata` или `fieldMetadata`) полностью закрывает эту проблему: все 4 карты загружаются в `allFlatEntityMaps` для `mappings` и гарантированно инвалидируются вместе с `'rolesPermissions'` в `this.invalidateCache(...)`.

### 2.5. Обработка `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError`

- **Сверка с кодовой базой**:
  - В `WorkspaceMigrationRunnerService.executeRun` (`workspace-migration-runner.service.ts:641-687`) ветка `if (applicationMetadataAudit)` уже проверяет `mayHaveCommitted = error instanceof NativeTransactionOutcomeUnknownError || error instanceof CoreAuditPostCommitError`, пропускает `executeActionRollbackHandler`, выполняет `this.invalidateCache(...)` и пробрасывает исходный экземпляр ошибки без оборачивания в `WorkspaceMigrationRunnerException`.
  - В `ObjectMetadataService.deleteManyObjectMetadatas` и `FieldMetadataService.deleteOneField` вызов `validateBuildAndRunWorkspaceMigration` не перехватывает исключения из `workspaceMigrationRunnerService.run`, поэтому перевод этих методов на `withApplicationMetadataAudit` автоматически обеспечивает требуемую семантику `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError`.

### 2.6. Взаимодействие `FlatObjectPermissionValidatorService` и `FlatFieldPermissionValidatorService` с `isEditable: false`

- **Сверка с кодовой базой**:
  - В `WorkspaceMigrationBuildOrchestratorService` (`workspace-migration-build-orchestrator.service.ts:174-243`) билдеры выполняются в строго фиксированном порядке: `objectMetadata` (индекс 0), `fieldMetadata` (индекс 1), а `objectPermission` (индекс 15) и `fieldPermission` (индекс 16) выполняются после них.
  - В `WorkspaceEntityMigrationBuilderService.validateAndBuild` (`workspace-entity-migration-builder.service.ts:170-191`) удаление сущности из `optimisticFlatEntityMapsAndRelatedFlatEntityMaps` (`deleteUniversalFlatEntityFromUniversalFlatEntityAndRelatedEntityMapsThroughMutationOrThrow`) происходит только в том случае, если `validateFlatEntityDeletion` для этого `objectMetadata` или `fieldMetadata` завершилась успешно (`status !== 'fail'`).
  - Следовательно:
    - в `FlatObjectPermissionValidatorService.validateFlatObjectPermissionDeletion` (`flat-object-permission-validator.service.ts:227-272`) достаточно извлечь `flatObjectMetadataMaps` из `optimisticFlatEntityMapsAndRelatedFlatEntityMaps` и проверять `!referencedRole.isEditable` только если `isDefined(referencedObjectMetadata)`;
    - в `FlatFieldPermissionValidatorService.validateFlatFieldPermissionDeletion` (`flat-field-permission-validator.service.ts:265-310`) достаточно извлечь `flatObjectMetadataMaps` и `flatFieldMetadataMaps` из `optimisticFlatEntityMapsAndRelatedFlatEntityMaps` и проверять `!referencedRole.isEditable` только если `isDefined(referencedObjectMetadata) && isDefined(referencedFieldMetadata)` (так как при удалении объекта удаляется и объект, и поле, а при удалении поля или обратного поля связи на другом объекте объект остается в `optimisticFlatObjectMetadataMaps`, но само поле уже удалено из `optimisticFlatFieldMetadataMaps`).
  - Если же `objectPermission` или `fieldPermission` удаляется отдельно (или удаление объекта/поля не прошло валидацию), целевые сущности остаются в `optimisticFlat*Maps`, и запрет `PermissionsExceptionCode.ROLE_NOT_EDITABLE` для не-редактируемых ролей полностью сохраняется.

---

## 3. Линза 2: Безопасность, изоляция привилегий и Enterprise-граница

### 3.1. Соблюдение Enterprise-границы (`@license Enterprise`)

- Все 12 изменяемых файлов в `design.md:94-105` относятся к базовым (non-Enterprise) модулям.
- Валидаторы `FlatRowLevelPermissionPredicateValidatorService` и `FlatRowLevelPermissionPredicateGroupValidatorService` имеют заголовок `/* @license Enterprise */`, однако их методы `validateFlatRowLevelPermissionPredicateDeletion` (`flat-row-level-permission-predicate-validator.service.ts:177-207`) и `validateFlatRowLevelPermissionPredicateGroupDeletion` (`flat-row-level-permission-predicate-group-validator.service.ts:112-145`) уже не содержат проверки `isEditable` и не требуют изменений или импортов.
- Ни один из изменяемых файлов не импортирует код из файлов с `/* @license Enterprise */`; `check_enterprise_dependencies.py --verify-baseline` не нарушается.

### 3.2. Редактирование чувствительного поля `rowLevelPermissionPredicate.value`

- В `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts:144-157` для ресурса `rowLevelPermissionPredicate` поля `value` и `deletedAt` находятся в списке `redacted`, а `workspaceMemberFieldMetadataId` - в списке `values`.
- В `application-metadata-audit.ts:328-350` функция `projectPredicate` передает скалярные поля строки в `audit.record(...)`, где `CrmAuditTransactionContext` сохраняет для `value` только криптографический хэш (`auditPayloadHash(value)`). В `redactedDiff.values` литерал фильтрации `value` никогда не попадает ни при `rowLevelPermissionPredicate:delete`, ни при `rowLevelPermissionPredicate:update` (`ON DELETE SET NULL` на `workspaceMemberFieldMetadataId`).

### 3.3. Критическое замечание по безопасности 1: фильтрация soft-deleted строк RLP при `withDeleted: true` в `WorkspaceCacheRowsBatchLoader`

- **Механизм проблемы**:
  - В `packages/twenty-server/src/engine/workspace-cache/services/workspace-cache-rows-batch-loader.ts:238-244` метод `runFetch` загружает строки для всех провайдеров кэша с опцией `withDeleted: true`.
  - Это означает, что в реальном runtime любые soft-deleted строки (`deletedAt !== null`) в `core."rowLevelPermissionPredicateGroup"` и `core."rowLevelPermissionPredicate"` попадают в `flatRowLevelPermissionPredicateGroupMaps` и `flatRowLevelPermissionPredicateMaps`.
  - В текущей реализации `reconcileApplicationRoleAndPermissionOperations` (`application-metadata-audit.ts:1854-1923`) нет проверки `if (isPresent(existingGroup.deletedAt)) continue;` и `if (isPresent(existingPredicate.deletedAt)) continue;`.
  - Если `reconcileApplicationRoleAndPermissionOperations` добавит soft-deleted строку из кэша в `flatEntityToDelete`, ее `id` попадет в `plannedGroupDeletes` / `plannedPredDeletes`.
  - В `runAuditedApplicationMetadataMigration` (`application-metadata-audit.ts:913-963`) `expectedDeletedGroupIds` инициализируется как `new Set(plannedGroupDeletes)`, после чего цикл на строке 918 делает `if (expectedDeletedGroupIds.has(groupId)) continue;`, а цикл по предикатам на строке 941 проверяет `if (predRow.deletedAt !== null && predRow.deletedAt !== undefined && !plannedPredDeletes.has(predId))`.
  - В результате, если soft-deleted строка присутствовала в flat-кэше, она попадает в `plannedGroupDeletes` / `plannedPredDeletes` и **обходит** проверку `'Application metadata audit cannot cascade-delete soft-deleted row-level permission rows'`!
  - Кроме того, если у soft-deleted строки `rowLevelPermissionPredicate` колонка `workspaceMemberFieldMetadataId` ссылается на удаляемое поле `workspaceMember` (`ON DELETE SET NULL`), предпроверка на строках 940-963 не проверяет `plannedFieldDeletes.has(nullableUuid(predRow.workspaceMemberFieldMetadataId))`.
- **Требование к реализации**:
  1. В `reconcileApplicationRoleAndPermissionOperations` расширить `ReconcilableEntity` полем `deletedAt?: string | Date | null` и пропускать любые записи `rowLevelPermissionPredicateGroup` и `rowLevelPermissionPredicate`, у которых `isPresent(entity.deletedAt)`.
  2. В `runAuditedApplicationMetadataMigration`:
     - для режимов `'objectDelete'` и `'fieldDelete'` (а также для любых каскадно затрагиваемых строк) запрещать наличие `deletedAt !== null && deletedAt !== undefined` даже если `id` присутствует в `plannedGroupDeletes` / `plannedPredDeletes`;
     - в проверке soft-deleted предикатов (строки 940-963) также выбрасывать `'Application metadata audit cannot cascade-delete soft-deleted row-level permission rows'`, если у soft-deleted предиката `nullableUuid(predRow.workspaceMemberFieldMetadataId)` входит в `plannedFieldDeletes`.

### 3.4. Критическое замечание по безопасности 2: проверка кросс-приложенческого удаления `rowLevelPermissionPredicateGroup`

- **Механизм проблемы**:
  - В `design.md:68` заявлено: при удалении строки в `rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`, принадлежащей другому приложению (`beforeRow.applicationId !== applicationId`), удаление допускается только при наличии каскадного удаления родительской сущности (`isPlannedCascade` / `expectedDeletedGroupIds`).
  - Однако в `application-metadata-audit.ts:913` множество `expectedDeletedGroupIds` инициализируется всеми элементами `plannedGroupDeletes` без проверки `beforeRow.applicationId === applicationId`.
  - Поэтому если в `plannedGroupDeletes` передать `id` группы другого приложения (`uuid(beforeRow.applicationId) !== applicationId`), у которой ни `roleId`, ни `objectMetadataId`, ни `parentRowLevelPermissionPredicateGroupId` не удаляются каскадно, она все равно окажется в `expectedDeletedGroupIds`, и проверка `expectedDeletedGroupIds.has(id)` на строке 1374 не обнаружит кросс-приложенческое некаскадное удаление.
- **Требование к реализации**:
  - Инициализировать `expectedDeletedGroupIds` только теми `groupId` из `plannedGroupDeletes`, для которых `beforeRow` существует и `uuid(beforeRow.applicationId) === applicationId`.
  - Затем в цикле неподвижной точки (`while (addedGroupDelete)`) добавлять в `expectedDeletedGroupIds` любые группы из `before.predicateGroups`, для которых выполняется условие каскада: `plannedRoleDeletes.has(roleId) || plannedObjectDeletes.has(objectMetadataId) || (parentGroupId !== null && expectedDeletedGroupIds.has(parentGroupId))`.
  - После цикла проверить, что каждый `id` из `plannedGroupDeletes` входит в `expectedDeletedGroupIds` (иначе выбросить ошибку неразрешенного кросс-приложенческого удаления группы).

### 3.5. Fail-closed барьер в `WorkspaceMigrationRunnerService` и строгие инварианты `'objectDelete'` / `'fieldDelete'`

- Расширение барьера в `WorkspaceMigrationRunnerService.executeRun` (`workspace-migration-runner.service.ts:720-728`) константой `AUDITED_ROLE_AND_PERMISSION_CASCADE_DELETE_METADATA_NAMES` (`'objectMetadata'`, `'fieldMetadata'`, `'permissionFlag'`, `'agent'` при `action.type === 'delete'`) выполняется до `this.coreDataSource.createQueryRunner()` и полностью блокирует обход аудита через прямое выполнение миграций удаления.
- Системная команда `DropFavoriteObjectsCommand` (`packages/twenty-server/src/database/commands/upgrade-version-command/2-7/2-7-workspace-command-1798000030000-drop-favorite-objects.command.ts:95-100`) вызывает `objectMetadataService.deleteOneObject` с `isSystemBuild: true` и `ownerFlatApplication: twentyStandardFlatApplication` без `auditIdentity`. Предусмотренный в `design.md:43, 57` fallback на `defaultSystemActorId: 'object-metadata:system-delete'` при `isSystemBuild === true` и разрешение удаления объектов `twenty-standard` при `request.isSystemBuild === true` обеспечивают полную совместимость без модификации закоммиченной upgrade-команды.
- Рекомендуемое усиление post-flush проверки в `runAuditedApplicationMetadataMigration`: для режимов `'objectDelete'` и `'fieldDelete'` после `await audit.flush()` (наряду с `readFullMetadataSnapshot`) повторно считывать `core."objectMetadata"` и `core."fieldMetadata"` и сверять их с состоянием `afterObjects` / `afterFields`.

---

## 4. Линза 3: Полнота тестового покрытия и граничные случаи

План в `test-research.md` охватывает все основные пути вызова (`ObjectMetadataService`, `FieldMetadataService`, GraphQL-резолверы, REST-контроллеры, AI-инструменты, `WorkspaceMigrationRunnerService`, `runAuditedApplicationMetadataMigration`), реальную роль БД с ограниченными правами (`NOSUPERUSER`), редактирование `value`, конкурентную вставку прав до `FOR UPDATE` и ошибки `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`.

Для 100% закрытия выявленных выше граничных случаев в `packages/twenty-server/test/fork-migration/crm-audit-object-and-field-delete-permissions.postgres-spec.ts` необходимо обязательно включить следующие 4 проверки:

1. **Soft-deleted строки `rowLevelPermissionPredicate` и `rowLevelPermissionPredicateGroup`, присутствующие одновременно и в БД, и в flat-кэше (`withDeleted: true`)**:
   - В отличие от тестового харнеса `crm-audit-application-metadata.postgres-spec.ts`, который фильтровал `"deletedAt" IS NULL` при построении кэша, в новом тесте кэш должен возвращать и строки с `deletedAt IS NOT NULL` (как это делает реальный `WorkspaceCacheRowsBatchLoader`).
   - Проверить, что `deleteOneObject` и `deleteOneField` (включая случай `ON DELETE SET NULL` по `workspaceMemberFieldMetadataId` на soft-deleted предикате) отклоняются с `'Application metadata audit cannot cascade-delete soft-deleted row-level permission rows'` без изменений в `core` и `crm_audit."crmAuditEntry"`.
2. **Удаление `MORPH_RELATION` поля с несколькими целевыми объектами (`T1 -> R1`, `T2 -> R2` и головное поле `H`) через `FieldMetadataService.deleteOneField`**:
   - Создать права `fieldPermission` и `rowLevelPermissionPredicate` не только на `T1` и `R1`, но и на обратном поле `R2` второго таргет-поля `T2`, а также на головном поле `H`.
   - Убедиться, что вызов `deleteOneField({ id: T1.id })` успешно проходит проверку `mode === 'fieldDelete'`, удаляет `T1`, `T2`, `H`, `R1`, `R2` и записывает в `crm_audit."crmAuditEntry"` удаление всех зависимых прав.
3. **Сохранение запрета `ROLE_NOT_EDITABLE` при изолированном удалении `objectPermission` / `fieldPermission` у не-редактируемой роли, когда целевой объект и поле НЕ удаляются**:
   - Проверить через `FlatObjectPermissionValidatorService.validateFlatObjectPermissionDeletion` и `FlatFieldPermissionValidatorService.validateFlatFieldPermissionDeletion` (или `validateBuildAndRunWorkspaceMigration`), что если целевой объект и поле присутствуют в `optimisticFlatObjectMetadataMaps` / `optimisticFlatFieldMetadataMaps`, попытка удалить `objectPermission` или `fieldPermission` у роли с `isEditable: false` по-прежнему возвращает `PermissionsExceptionCode.ROLE_NOT_EDITABLE`.
4. **Защита от кросс-приложенческого некаскадного удаления `rowLevelPermissionPredicateGroup` и прав**:
   - Проверить, что при удалении пользовательского объекта/поля (`workspaceCustomApplication`) каскадно удаляются права и группы предикатов, принадлежащие как `workspaceCustomApplication`, так и другому приложению (например, `twenty-standard`), если они ссылаются на удаляемый объект/поле, но любая попытка включить в план удаление группы предикатов или права другого приложения на **неудаляемом** объекте/поле отвергается с откатом транзакции.
