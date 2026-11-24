# LOG-209 Design: Расширение FK-покрытия `prepareNativeCrmDeleteEffects` и `MERGE_MANY` на 10 стандартных дочерних таблиц (Revised after Design Review)

## 1. Цель и границы
Снять практический блокер `DESTROY_ONE`/`DESTROY_MANY`, `TrashCleanupService` и `MERGE_MANY` для покрытых CRM-объектов (`company`, `person`, `opportunity` и всех кастомных объектов), когда на удаляемую/сливаемую запись ссылаются 10 стандартных системных дочерних таблиц Twenty CRM - без новых миграций БД и без новых Enterprise-зависимостей:

1. `noteTarget` (`ON DELETE CASCADE`)
2. `taskTarget` (`ON DELETE CASCADE`)
3. `attachment` (`ON DELETE CASCADE`, содержит `FILES`-поле `file`)
4. `timelineActivity` (`ON DELETE CASCADE` от `person`/`company`/custom, `ON DELETE SET NULL` от `opportunity`)
5. `agentChatThreadTarget` (`ON DELETE CASCADE`)
6. `calendarEventTarget` (`ON DELETE CASCADE`)
7. `calendarEventParticipant` (`ON DELETE SET NULL` от `person`)
8. `messageThreadTarget` (`ON DELETE CASCADE`, входит в `OMNI_NATIVE_REPOSITORIES`)
9. `messageParticipant` (`ON DELETE SET NULL` от `person`, входит в `OMNI_NATIVE_REPOSITORIES`)
10. `messageListMember` (`ON DELETE CASCADE` от `person`)

## 2. Архитектура решения

### 2.1. Предикат и валидация (`native-crm-audit-record.ts`)
- `AUDITED_FK_CHILD_OBJECTS`: точная карта 10 `nameSingular -> STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS[name]`.
- `isNativeCrmAuditFkChildObject(name, universalIdentifier)` и `isNativeCrmAuditFkChildMetadata(metadata, workspaceId)` (требует `workspaceId`, `isSystem === true`, `isRemote === false`, валидные UUID, `TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER`, совпадение `AUDITED_FK_CHILD_OBJECTS`).
- В `assertNativeCrmAuditWriteSupported(..., options?: { allowFkChildDeleteEffect?: boolean })`:
  - Всегда сохраняются строгие проверки `metadata.id === shape.objectMetadataId`, `metadata.nameSingular === shape.nameSingular`, `shape.tableName === computeTableName(...)`.
  - Для `isNativeCrmAuditFkChildMetadata(metadata, workspaceId)` (когда `!isNativeCrmAuditMetadata`):
    1. **FK-эффект удаления (`options?.allowFkChildDeleteEffect === true`)**: допускается только `kind === 'delete'` с пустым `data` (0 определённых ключей) либо `kind === 'update'` с ровно 1 определённым ключом (колонка типа `RELATION`/`MORPH_RELATION`, `!compositeParentFieldName`) со значением `null`.
    2. **Scoped-миграция/soft-delete при `MERGE_MANY` (`getNativeCrmMergeChildScope(executor)`)**: при `grant.objectMetadataId === metadata.id`:
       - `kind === 'soft-delete'`: 0 определённых ключей в `data` и `shape.columnShapeByColumnName.deletedAt?.fieldMetadataType === 'DATE_TIME'`;
       - `kind === 'update'`: ровно 1 определённый ключ `=== grant.allowedJoinColumnName`, колонка типа `RELATION`/`MORPH_RELATION` с `!compositeParentFieldName` и значением-валидным UUID.
    3. В остальных случаях - немедленный fail-closed `throw new Error('Native audit coverage excludes this object or mutation')`.

### 2.2. `prepareNativeCrmDeleteEffects` и omni-защита (`native-crm-audit-delete-effects.ts`, `workspace-repository.ts`)
- В `workspace-repository.ts` (`resolveChild`): принимать `isNativeCrmAuditMetadata || isNativeCrmAuditFkChildMetadata`.
- В `prepareNativeCrmDeleteEffects`:
  - передавать `{ allowFkChildDeleteEffect: true }` в `assertNativeCrmAuditWriteSupported`;
  - проверять `assertChildMutationAllowed(shape, rows, kind: 'cascade' | 'set-null')` на **обеих** ветках:
    - для `cascadeBefore`: `findOmniProtectedParentIds` + `assertOmniNativeWriteUnowned` (для `OMNI_NATIVE_REPOSITORIES`);
    - для `setNullBefore`: `assertOmniNativeWriteUnowned` (для `OMNI_NATIVE_REPOSITORIES`);
  - при декодировании `before`-строк для `assertOmniNativeWriteUnowned`: `id: row.id` берётся напрямую (не JSON-строка), а JSON-колонки ссылок (`messageId`, `messageThreadId`) декодируются через `JSON.parse` (`'null'` -> `null`).
- Для `attachment`: `cascadeTargets` передаются в `prepareNativeCrmDeleteFiles`, который отсоединяет `core.file`, пишет `crmFile:update` и сохраняет долговечное намерение `delete_filesFieldFiles`; `FilesFieldDeletionListener.handleDestroyedEvent` уже проверяет `PENDING` намерения при `isCoveredObject === true` даже если у родителя нет собственных `FILES`-полей.

### 2.3. Scoped-поддержка `MERGE_MANY` (`native-crm-audit-transaction.ts`, `common-merge-many-query-runner.service.ts`)
- В `native-crm-audit-transaction.ts`: `runInNativeCrmMergeChildScope(scope, { objectMetadataId, allowedJoinColumnName }, work)` (валидирует UUID `objectMetadataId` и непустой `allowedJoinColumnName`, запрещает вложенность, чистит `WeakMap` в `finally`) и `getNativeCrmMergeChildScope(executor)`.
- В `CommonMergeManyQueryRunnerService.mergeRelatedRecordsIntoPriorityRecord`: выдавать `runInNativeCrmMergeChildScope` только при `isCoveredTargetObject && isNativeCrmAuditFkChildMetadata(relationField.objectMetadata, workspaceId) && isRegisteredNativeCrmAuditScope(transactionScope)`, оборачивая только циклы `soft-delete` дубликатов и `update` миграции.

## 3. Затрагиваемые файлы
1. `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-transaction.ts`
2. `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-record.ts`
3. `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-delete-effects.ts`
4. `packages/twenty-server/src/engine/twenty-orm/repository/workspace-repository.ts`
5. `packages/twenty-server/src/engine/api/common/common-query-runners/common-merge-many-query-runner.service.ts`
6. Обновление 2 существующих PG-тестов (`crm-audit-public-merge.postgres-spec.ts`, `crm-audit-trash-and-file-remove.postgres-spec.ts`)
7. Новый PG 17 тест `packages/twenty-server/test/fork-migration/crm-audit-fk-delete-effects-coverage.postgres-spec.ts`
