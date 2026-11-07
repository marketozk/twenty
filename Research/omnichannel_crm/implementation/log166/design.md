# LOG166 - дизайн аудита каскадных изменений прав при удалении объектов и полей через `ObjectMetadataService` и `FieldMetadataService`

## 1. Контекст и постановка задачи

После `LOG111`-`LOG113` и `LOG156`-`LOG165` все прямые сервисные операции над `core.role`, `core."roleTarget"`, пятью таблицами прав ролей (`core."rolePermissionFlag"`, `core."objectPermission"`, `core."fieldPermission"`, `core."rowLevelPermissionPredicateGroup"`, `core."rowLevelPermissionPredicate"`), `core."apiKey"`, `core.workspace."defaultRoleId"`, `core.application."defaultRoleId"`, а также пакетные миграции при установке, синхронизации и удалении приложений (`ApplicationManifestMigrationService.syncMetadataFromManifest`, `ApplicationSyncService.uninstallApplication`, `ApplicationService.delete`, `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`) закрыты транзакционным CRM-аудитом.

Оставались два автономных сервиса изменения модели данных, которые при удалении пользовательского объекта или поля вызывают `WorkspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration` и `WorkspaceMigrationRunnerService.run` вне `withApplicationMetadataAudit`:

1. **`ObjectMetadataService.deleteOneObject` / `deleteManyObjectMetadatas`** (`object-metadata.service.ts:297-499`, вызывается из `ObjectMetadataResolver.deleteOneObject`, `ObjectMetadataController.deleteOne`, `DeleteObjectMetadataTool.execute` и системной команды `DropFavoriteObjectsCommand`):
   - формирует матрицу удаления только для `objectMetadata`, `index`, `fieldMetadata` и `view` (плюс системные побочные эффекты из `ObjectSystemSideEffectsOnDeleteSideEffectHandlerService`);
   - если у какой-либо роли в рабочем пространстве (включая системные и не-редактируемые роли с `isEditable: false`) существуют строки в `core."objectPermission"`, `core."fieldPermission"`, `core."rowLevelPermissionPredicateGroup"` или `core."rowLevelPermissionPredicate"`, ссылающиеся на удаляемый объект, его поля или обратные поля связей (`relationTargetObjectMetadataId`), PostgreSQL удалял эти строки через `ON DELETE CASCADE` (или обнулял `workspaceMemberFieldMetadataId` через `ON DELETE SET NULL`) без записей в `crm_audit."crmAuditEntry"` и без гарантированной инвалидации всех кэшей прав (`flatRowLevelPermissionPredicateMaps`, `flatRowLevelPermissionPredicateGroupMaps`, `rolesPermissions`).
2. **`FieldMetadataService.deleteOneField`** (`field-metadata.service.ts:89-207`, вызывается из `FieldMetadataResolver.deleteOneField`, `FieldMetadataController.deleteOne` и `DeleteFieldMetadataTool.execute`):
   - формирует матрицу удаления только для `fieldMetadata`, `index` и `pageLayoutWidget` (плюс парное поле связи из `computeFlatFieldMetadataRelatedFlatFieldMetadata` и головное поле морф-связи из `FieldMorphRelationHeadOnDeleteSideEffectHandlerService`);
   - если у роли есть `core."fieldPermission"` или `core."rowLevelPermissionPredicate"` (`fieldMetadataId` либо `workspaceMemberFieldMetadataId`), ссылающиеся на удаляемое поле, парное поле связи или головное поле морф-связи, PostgreSQL выполнял `ON DELETE CASCADE` / `ON DELETE SET NULL` без записей в `crm_audit."crmAuditEntry"` и без гарантированной инвалидации `flatRowLevelPermissionPredicateMaps` и `rolesPermissions`.
3. **Барьер в `WorkspaceMigrationRunnerService.executeRun` и валидация `FlatObjectPermissionValidatorService` / `FlatFieldPermissionValidatorService`**:
   - в `WorkspaceMigrationRunnerService.executeRun` (`workspace-migration-runner.service.ts:720-728`) неаудируемая ветка блокировала только действия с `metadataName` из `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES`, но пропускала неаудируемые действия `delete` над `objectMetadata`, `fieldMetadata`, `permissionFlag` и `agent`, которые через внешние ключи PostgreSQL (`ON DELETE CASCADE` / `ON DELETE SET NULL`) могут изменить 7 аудируемых таблиц ролей и прав;
   - в `FlatObjectPermissionValidatorService.validateFlatObjectPermissionDeletion` и `FlatFieldPermissionValidatorService.validateFlatFieldPermissionDeletion` проверка `!referencedRole.isEditable` срабатывала даже тогда, когда целевой `objectMetadata` или `fieldMetadata` уже удалён в этой же миграции, что блокировало явное удаление каскадируемых прав у не-редактируемых ролей (`Member`, `Guest`, стандартных и системных ролей).

## 2. Рассмотренные варианты архитектуры

### Вариант 1 (рекомендуемый): расширение `application-metadata-audit.ts` режимами `'objectDelete'` и `'fieldDelete'` с синхронным захватом контекста, полным согласованием зависимых прав и расширением fail-closed барьера в `WorkspaceMigrationRunnerService`

- В `application-metadata-audit.ts` добавить синхронный захват контекста операции до первого `await` (`captureApplicationMetadataAuditOperation` + `bindApplicationMetadataAuditOperation`), специализированные режимы `mode: 'manifest' | 'objectDelete' | 'fieldDelete'` с жёсткими инвариантами по `core."objectMetadata"` и `core."fieldMetadata"` под `FOR UPDATE`, а также расширить `reconcileApplicationRoleAndPermissionOperations` учётом всех удаляемых полей (включая поля удаляемого объекта, обратные поля связей `relationTargetObjectMetadataUniversalIdentifier` / `relationTargetFieldMetadataUniversalIdentifier` и головные поля морф-связей `morphId`).
- В `ObjectMetadataService.deleteOneObject` / `deleteManyObjectMetadatas` и `FieldMetadataService.deleteOneField` синхронно захватывать контекст аудита до первого `await`, согласовывать зависимые строки прав (`objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`) и выполнять миграцию внутри `withApplicationMetadataAudit`.
- В `ObjectMetadataResolver`, `ObjectMetadataController`, `DeleteObjectMetadataTool`, `FieldMetadataResolver`, `FieldMetadataController` и `DeleteFieldMetadataTool` передавать явный `auditIdentity`.
- В `WorkspaceMigrationRunnerService.executeRun` гарантировать загрузку и инвалидацию всех карт прав (`flatObjectPermissionMaps`, `flatFieldPermissionMaps`, `flatRowLevelPermissionPredicateGroupMaps`, `flatRowLevelPermissionPredicateMaps`, `rolesPermissions`) при удалении объектов/полей и блокировать в неаудируемой ветке любые действия `delete` над `objectMetadata`, `fieldMetadata`, `permissionFlag` и `agent`.
- В `FlatObjectPermissionValidatorService` и `FlatFieldPermissionValidatorService` пропускать проверку `!referencedRole.isEditable` при удалении права, если целевой объект или поле уже удалены в рамках текущей миграции.
- **Плюсы**: единый транзакционный исполнитель и порядок блокировок (`workspace FOR NO KEY UPDATE` -> `application ORDER BY id FOR UPDATE` -> 7 таблиц ролей и прав `ORDER BY id FOR UPDATE` -> `objectMetadata`/`fieldMetadata` `ORDER BY id FOR UPDATE`), нулевой риск TOCTOU между чтением кэша и блокировкой БД, полный запрет обхода через `WorkspaceMigrationRunnerService`, 0 новых Enterprise-зависимостей.
- **Минусы**: нет.

### Вариант 2: создание отдельных перехватчиков в `DeleteObjectActionHandlerService` и `DeleteFieldActionHandlerService`

- **Плюсы**: локализация внутри action-хендлеров.
- **Минусы**: в момент работы отдельного action-хендлера транзакция `QueryRunner` уже запущена без `runInCoreAuditTransaction`, а при удалении нескольких полей и объектов в одной миграции нарушается порядок блокировок и атомарная сверка состояния всех 7 таблиц до и после `audit.flush()`. Отклонено.

## 3. Детальная архитектура решения

### 3.1. Расширение `application-metadata-audit.ts`

1. **Синхронный захват контекста до разрешения приложения (`captureApplicationMetadataAuditOperation` и `bindApplicationMetadataAuditOperation`)**:
   - поскольку `ObjectMetadataService.deleteManyObjectMetadatas` и `FieldMetadataService.deleteOneField` при отсутствии `ownerFlatApplication` разрешают `workspaceCustomFlatApplication` асинхронно (`await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow`), `captureApplicationMetadataAuditOperation` вызывается синхронно в самом начале метода до первого `await`:
     - проверяет валидность `workspaceId` и отсутствие конфликтующих/вложенных контекстов аудита;
     - захватывает и валидирует `auditIdentity` (или текущий контекст `withCrmAuditRequest` / `withCrmAuditIdentity`, либо при `isSystemBuild === true` системный актор `defaultSystemActorId`: `'object-metadata:system-delete'` / `'field-metadata:system-delete'`);
     - валидирует `expectedDeletedObjectIds` (для `mode: 'objectDelete'`) или `expectedDeletedFieldId` (для `mode: 'fieldDelete'`);
   - после разрешения `resolvedOwnerFlatApplication` функция `bindApplicationMetadataAuditOperation` связывает захваченную операцию с `applicationId` и `applicationUniversalIdentifier` и возвращает замороженный `ApplicationMetadataAuditRequest`.
2. **Полное согласование удаляемых полей в `reconcileApplicationRoleAndPermissionOperations`**:
   - принимает опциональный `flatFieldMetadataMaps` в `existingAllFlatEntityMaps`;
   - расширяет множество `deletedFieldUniversalIdentifiers`:
     - всеми полями из `flatFieldMetadataMaps`, у которых `objectMetadataUniversalIdentifier` или `relationTargetObjectMetadataUniversalIdentifier` входит в `deletedObjectUniversalIdentifiers`, либо `relationTargetFieldMetadataUniversalIdentifier` входит в `deletedFieldUniversalIdentifiers`;
     - головными полями морф-связей (`head.universalIdentifier === target.morphId`), если все целевые поля данного `morphId` на этом объекте входят в `deletedFieldUniversalIdentifiers` и ни одно не создаётся в `record.fieldMetadata?.flatEntityToCreate`;
   - по расширенному `deletedFieldUniversalIdentifiers` и `deletedObjectUniversalIdentifiers` добавляет зависимые строки `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup` (с транзитивным замыканием по `parentRowLevelPermissionPredicateGroupUniversalIdentifier`) и `rowLevelPermissionPredicate` в `flatEntityToDelete`.
3. **Строгие инварианты режимов `'objectDelete'` и `'fieldDelete'` в `runAuditedApplicationMetadataMigration`**:
   - внутри `runInCoreAuditTransaction` после блокировки `core.workspace` (`FOR NO KEY UPDATE`), `core.application` (`ORDER BY id FOR UPDATE`) и 7 таблиц ролей и прав (`ORDER BY id FOR UPDATE`), для режимов `'objectDelete'` и `'fieldDelete'` также блокируются и считываются `core."objectMetadata"` и `core."fieldMetadata"` (`WHERE "workspaceId" = $1 ORDER BY id FOR UPDATE`);
   - **для `mode === 'objectDelete'`**:
     - запрещены любые действия над `role`, `roleTarget`, `agent`, `permissionFlag`, `rolePermissionFlag`, а также любые действия `create` / `update` над `objectMetadata`, `fieldMetadata`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`;
     - `plannedObjectDeletes` обязан быть непустым и точно совпадать с `request.expectedDeletedObjectIds`;
     - каждый объект в `plannedObjectDeletes` должен существовать в `beforeObjects`, а при `!request.isSystemBuild` не может иметь `isSystem === true` или принадлежать `twenty-standard`;
     - каждое поле в `plannedFieldDeletes` должно существовать в `beforeFields` и принадлежать удаляемому объекту (`objectMetadataId` в `plannedObjectDeletes`), ссылаться на удаляемый объект/поле (`relationTargetObjectMetadataId` в `plannedObjectDeletes` или `relationTargetFieldMetadataId` в `plannedFieldDeletes`) либо быть головным полем морф-связи (`universalIdentifier === target.morphId`) для удаляемого таргет-поля на том же объекте; при этом все поля из `beforeFields`, у которых `objectMetadataId` или `relationTargetObjectMetadataId` входит в `plannedObjectDeletes`, обязаны входить в `plannedFieldDeletes`;
     - после `work(runner)` проверяется, что в `core."objectMetadata"` и `core."fieldMetadata"` удалены ровно `plannedObjectDeletes` и `plannedFieldDeletes` без создания или модификации остальных строк, таблицы `role`, `roleTarget`, `rolePermissionFlag` не изменились, а все изменения в `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate` являются законными каскадами удаления или `ON DELETE SET NULL` на `workspaceMemberFieldMetadataId`;
   - **для `mode === 'fieldDelete'`**:
     - запрещены любые действия над `role`, `roleTarget`, `agent`, `permissionFlag`, `rolePermissionFlag`, `objectMetadata`, `objectPermission`, `rowLevelPermissionPredicateGroup`, а также любые действия `create` / `update` над `fieldMetadata`, `fieldPermission`, `rowLevelPermissionPredicate`;
     - `plannedObjectDeletes.size === 0`, а `plannedFieldDeletes` обязан содержать `request.expectedDeletedFieldId`;
     - основное поле `primaryField` должно существовать в `beforeFields` (и его объект - в `beforeObjects`); при `!request.isSystemBuild` `primaryField` не может принадлежать `twenty-standard`, не может быть `labelIdentifierFieldMetadataId` своего объекта и не может иметь `isSystem === true` (кроме головного поля морф-связи);
     - каждое дополнительное поле в `plannedFieldDeletes` обязано быть парным полем связи (`relationTargetFieldMetadataId`), соседним таргет-полем с тем же `morphId` на том же объекте или головным полем морф-связи (`universalIdentifier === primaryField.morphId`);
     - после `work(runner)` проверяется, что `core."objectMetadata"` не изменилась, в `core."fieldMetadata"` удалены ровно `plannedFieldDeletes` без создания или модификации остальных полей, таблицы `role`, `roleTarget`, `rolePermissionFlag`, `objectPermission`, `rowLevelPermissionPredicateGroup` не изменились, в `fieldPermission` и `rowLevelPermissionPredicate` удалены только строки с `fieldMetadataId` из `plannedFieldDeletes`, а любые обновления в `rowLevelPermissionPredicate` затрагивают исключительно обнуление `workspaceMemberFieldMetadataId` (из `plannedFieldDeletes` в `null`) без изменения других колонок;
   - **усиление проверки `isPlannedMemberFieldSetNull` и кросс-приложенческих удалений во всех режимах**:
     - при обновлении `rowLevelPermissionPredicate` за счёт `ON DELETE SET NULL` на `workspaceMemberFieldMetadataId` (без явного `plannedPredUpdates.has(id)`) проверяется, что все остальные скалярные колонки строки идентичны `beforeRow`;
     - при удалении строки в `rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`, принадлежащей другому приложению (`beforeRow.applicationId !== applicationId`), удаление допускается только при наличии каскадного удаления родительской сущности (`isPlannedCascade` / `expectedDeletedGroupIds`).

### 3.2. Интеграция в `ObjectMetadataService`, `FieldMetadataService`, резолверы, контроллеры и AI-инструменты

1. **`ObjectMetadataService`** (`object-metadata.service.ts`):
   - `deleteOneObject` и `deleteManyObjectMetadatas` принимают `auditIdentity?: ApplicationMetadataAuditIdentity`;
   - в начале `deleteManyObjectMetadatas` до первого `await` вызывается `captureApplicationMetadataAuditOperation`, загружаются карты прав (`flatObjectPermissionMaps`, `flatFieldPermissionMaps`, `flatRowLevelPermissionPredicateGroupMaps`, `flatRowLevelPermissionPredicateMaps`), вызывается `reconcileApplicationRoleAndPermissionOperations`, непустые списки удаляемых прав включаются в `allFlatEntityOperationByMetadataName`, а вызов `validateBuildAndRunWorkspaceMigration` оборачивается в `withApplicationMetadataAudit`.
2. **`FieldMetadataService`** (`field-metadata.service.ts`):
   - `deleteOneField` принимает `auditIdentity?: ApplicationMetadataAuditIdentity`;
   - в начале `deleteOneField` до первого `await` вызывается `captureApplicationMetadataAuditOperation`, загружаются `flatFieldPermissionMaps` и `flatRowLevelPermissionPredicateMaps`, вызывается `reconcileApplicationRoleAndPermissionOperations`, непустые списки удаляемых `fieldPermission` и `rowLevelPermissionPredicate` включаются в `allFlatEntityOperationByMetadataName`, а вызов `validateBuildAndRunWorkspaceMigration` оборачивается в `withApplicationMetadataAudit`.
3. **Входные точки**:
   - `ObjectMetadataResolver.deleteOneObject` и `FieldMetadataResolver.deleteOneField` передают `auditIdentity: context?.req ? roleAuditIdentityFromRequest(context.req) : undefined`;
   - `ObjectMetadataController.deleteOne` и `FieldMetadataController.deleteOne` передают `auditIdentity: request ? roleAuditIdentityFromRequest(request) : undefined`;
   - `DeleteObjectMetadataTool.execute` и `DeleteFieldMetadataTool.execute` передают `auditIdentity: context.authContext ? { auth: context.authContext, agentId: context.agentId } : undefined`.

### 3.3. Защита `WorkspaceMigrationRunnerService` и валидаторов прав

1. **`WorkspaceMigrationRunnerService.executeRun`** (`workspace-migration-runner.service.ts`):
   - при наличии в `actions` удаления `objectMetadata` или `fieldMetadata` (`action.type === 'delete'`) включает `'objectPermission'`, `'fieldPermission'`, `'rowLevelPermissionPredicateGroup'`, `'rowLevelPermissionPredicate'` в `actionsMetadataAndRelatedMetadataNames`, обеспечивая загрузку их карт для `ApplicationMetadataAuditMappings` и обязательную инвалидацию этих карт и `'rolesPermissions'` в `this.invalidateCache(...)` (в том числе когда сработал только `ON DELETE SET NULL` на `workspaceMemberFieldMetadataId`);
   - в неаудируемой ветке `executeRun` блокирует до создания `QueryRunner` не только действия из `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES`, но и любые действия `type === 'delete'` для `AUDITED_ROLE_AND_PERMISSION_CASCADE_DELETE_METADATA_NAMES` (`'objectMetadata'`, `'fieldMetadata'`, `'permissionFlag'`, `'agent'`).
2. **`FlatObjectPermissionValidatorService` и `FlatFieldPermissionValidatorService`**:
   - в `validateFlatObjectPermissionDeletion` проверка `!referencedRole.isEditable` выполняется только если `referencedObjectMetadata` все ещё присутствует в `optimisticFlatObjectMetadataMaps`;
   - в `validateFlatFieldPermissionDeletion` проверка `!referencedRole.isEditable` выполняется только если и `referencedObjectMetadata`, и `referencedFieldMetadata` присутствуют в `optimisticFlatObjectMetadataMaps` / `optimisticFlatFieldMetadataMaps`.

## 4. Затронутые файлы

1. `packages/twenty-server/src/engine/core-modules/crm-audit/application-metadata-audit.ts`
2. `packages/twenty-server/src/engine/metadata-modules/object-metadata/object-metadata.service.ts`
3. `packages/twenty-server/src/engine/metadata-modules/object-metadata/object-metadata.resolver.ts`
4. `packages/twenty-server/src/engine/metadata-modules/object-metadata/controllers/object-metadata.controller.ts`
5. `packages/twenty-server/src/engine/metadata-modules/object-metadata/tools/delete-object-metadata.tool.ts`
6. `packages/twenty-server/src/engine/metadata-modules/field-metadata/services/field-metadata.service.ts`
7. `packages/twenty-server/src/engine/metadata-modules/field-metadata/field-metadata.resolver.ts`
8. `packages/twenty-server/src/engine/metadata-modules/field-metadata/controllers/field-metadata.controller.ts`
9. `packages/twenty-server/src/engine/metadata-modules/field-metadata/tools/delete-field-metadata.tool.ts`
10. `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-builder/validators/services/flat-object-permission-validator.service.ts`
11. `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-builder/validators/services/flat-field-permission-validator.service.ts`
12. `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service.ts`
13. `packages/twenty-server/test/fork-migration/crm-audit-object-and-field-delete-permissions.postgres-spec.ts` (новый)
