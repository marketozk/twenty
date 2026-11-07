# Независимое ревью кода LOG166

Дата: 08.11.2026
Статус: APPROVED (0 блокеров, 0 дефектов после устранения замечаний ревью дизайна M1-M3, T1-T3 и согласования ленивой проверки в `ApplicationManifestMigrationService.syncMetadataFromManifest`).

## Проверенный объём

1. Производственные файлы (13 файлов):
   - `packages/twenty-server/src/engine/core-modules/crm-audit/application-metadata-audit.ts`
   - `packages/twenty-server/src/engine/core-modules/application/application-manifest/application-manifest-migration.service.ts`
   - `packages/twenty-server/src/engine/metadata-modules/object-metadata/object-metadata.service.ts`
   - `packages/twenty-server/src/engine/metadata-modules/object-metadata/object-metadata.resolver.ts`
   - `packages/twenty-server/src/engine/metadata-modules/object-metadata/controllers/object-metadata.controller.ts`
   - `packages/twenty-server/src/engine/metadata-modules/object-metadata/tools/delete-object-metadata.tool.ts`
   - `packages/twenty-server/src/engine/metadata-modules/field-metadata/services/field-metadata.service.ts`
   - `packages/twenty-server/src/engine/metadata-modules/field-metadata/field-metadata.resolver.ts`
   - `packages/twenty-server/src/engine/metadata-modules/field-metadata/controllers/field-metadata.controller.ts`
   - `packages/twenty-server/src/engine/metadata-modules/field-metadata/tools/delete-field-metadata.tool.ts`
   - `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-builder/validators/services/flat-object-permission-validator.service.ts`
   - `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-builder/validators/services/flat-field-permission-validator.service.ts`
   - `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service.ts`
2. Интеграционный PostgreSQL-тест:
   - `packages/twenty-server/test/fork-migration/crm-audit-object-and-field-delete-permissions.postgres-spec.ts`

## Выводы ревью

1. **Атрибуция аудита, единый `operationId` и fail-closed барьеры**:
   - В `ObjectMetadataService.deleteManyObjectMetadatas` и `FieldMetadataService.deleteOneField` синхронный захват контекста через `captureApplicationMetadataAuditOperation` выполняется до первого `await`.
   - Вызовы без аутентифицированной идентичности (и без `isSystemBuild: true`) отклоняются с `'Role mutation requires authenticated audit identity'` до чтения кэша или обращения к БД. Для `isSystemBuild: true` без явного контекста используется детерминированный системный актор (`'object-metadata:system-delete'` / `'field-metadata:system-delete'`).
   - Все 6 публичных входных точек (`ObjectMetadataResolver`, `ObjectMetadataController`, `DeleteObjectMetadataTool`, `FieldMetadataResolver`, `FieldMetadataController`, `DeleteFieldMetadataTool`) прокидывают `auditIdentity`.
   - Все каскадные записи аудита (`objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`) фиксируются в одной транзакции `runInCoreAuditTransaction` с общим `operationId`, а литерал `rowLevelPermissionPredicate.value` редактируется (хешируется без попадания секрета в `redactedDiff.values`).

2. **Канонический порядок блокировок и сверка снимков**:
   - В `runAuditedApplicationMetadataMigration` выдержан единый порядок блокировок: `core.workspace FOR NO KEY UPDATE` -> `core.application ORDER BY id FOR UPDATE` -> 7 таблиц ролей и прав (`ORDER BY id FOR UPDATE`) -> `core."objectMetadata" ORDER BY id FOR UPDATE` -> `core."fieldMetadata" ORDER BY id FOR UPDATE`.
   - После `audit.flush()` повторно сверяются как снимки 7 таблиц ролей и прав, так и снимки `core."objectMetadata"` и `core."fieldMetadata"`.

3. **Полнота `reconcileApplicationRoleAndPermissionOperations` и инвариантов `objectDelete` / `fieldDelete`**:
   - Цикл неподвижной точки в `reconcileApplicationRoleAndPermissionOperations` расширяет набор удаляемых полей всеми полями удаляемых объектов, парными обратными полями `RELATION`, всеми таргет-полями и обратными полями multi-target `MORPH_RELATION`, а также головными полями морф-связей (`morphId`), когда не остаётся активных таргет-полей.
   - В `runAuditedApplicationMetadataMigration` для `mode === 'fieldDelete'` разрешаются только целевое поле, все поля его морф-группы (`morphId` на том же объекте), их парные обратные поля на целевых объектах и осиротевшие головные поля морф-связей; любые изменения `core."objectMetadata"` отклоняются.
   - Кросс-приложенческие дочерние группы `rowLevelPermissionPredicateGroup` допускаются к удалению только при каскадном удалении родительской роли, объекта или родительской группы (`expectedDeletedGroupIds` инициализируется только группами текущего `applicationId` до цикла каскадного замыкания).
   - Soft-deleted строки `rowLevelPermissionPredicateGroup` и `rowLevelPermissionPredicate` исключаются из `reconcileApplicationRoleAndPermissionOperations` (`!isPresent(entity.deletedAt)`) и жёстко блокируются в `runAuditedApplicationMetadataMigration` (включая каскад `ON DELETE SET NULL` по `workspaceMemberFieldMetadataId`).

4. **Точечное ослабление валидаторов прав и инвалидация кэша**:
   - В `FlatObjectPermissionValidatorService.validateFlatObjectPermissionDeletion` и `FlatFieldPermissionValidatorService.validateFlatFieldPermissionDeletion` проверка `!referencedRole.isEditable` срабатывает только тогда, когда целевой `objectMetadata` (и `fieldMetadata`) присутствует в оптимистичных картах. При отдельном удалении права на живом объекте/поле ошибка `PermissionsExceptionCode.ROLE_NOT_EDITABLE` сохраняется.
   - В `WorkspaceMigrationRunnerService.executeRun` при любом `delete` над `objectMetadata` или `fieldMetadata` в `actionsMetadataAndRelatedMetadataNames` добавляются `'objectPermission'`, `'fieldPermission'`, `'rowLevelPermissionPredicateGroup'`, `'rowLevelPermissionPredicate'`, что гарантирует инвалидацию их карт и `'rolesPermissions'` даже при чистом `ON DELETE SET NULL` на `workspaceMemberFieldMetadataId`.
   - Неаудируемый запуск в `WorkspaceMigrationRunnerService.executeRun` блокирует до создания `QueryRunner` любые действия из `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES` и любые `delete`-действия из `AUDITED_ROLE_AND_PERMISSION_CASCADE_DELETE_METADATA_NAMES` (`'objectMetadata'`, `'fieldMetadata'`, `'permissionFlag'`, `'agent'`).
