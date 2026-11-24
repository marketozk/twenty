# LOG-209 Design Review

## Вердикт первичного ревью
`NEEDS_REVISION` (`2` Blocker, `2` Major, `2` Minor). Все находки закрыты до начала реализации и отражены в [design.md](design.md).

## Разбор находок и принятые решения

### Blockers
1. **B1 - Контракт `kind === 'soft-delete'` в `assertNativeCrmAuditWriteSupported` vs `CommonMergeManyQueryRunnerService`**:
   - **Решение**: при `mergeChildScope` + `kind === 'soft-delete'` требовать пустой `data` (0 ключей с `value !== undefined`) и наличие колонки `deletedAt` с типом `DATE_TIME` в `shape.columnShapeByColumnName`. Для `mergeChildScope` + `kind === 'update'` не полагаться на пропуск `id`, а требовать ровно 1 определённый ключ `=== allowedJoinColumnName` с типом `RELATION`/`MORPH_RELATION`, `!compositeParentFieldName` и валидным UUID-значением.
2. **B2 - `row.id` в `readNativeCrmAuditRows` не является JSON-строкой**:
   - **Решение**: при подготовке строк для `assertOmniNativeWriteUnowned` в `workspace-repository.ts` брать `id: row.id` напрямую без `JSON.parse`, а `JSON.parse` применять только к JSON-сериализованным колонкам ссылок (`messageId`, `messageThreadId`), переводя `'null'` в `null`.

### Major
1. **M1 - Влияние на `crm-audit-trash-and-file-remove.postgres-spec.ts:658-707` и замена в `crm-audit-public-merge.postgres-spec.ts:1067`**:
   - **Решение**: в `crm-audit-trash-and-file-remove.postgres-spec.ts` перевести poison-pill кейс на реальный непокрытый FK (или omni-owned `messageParticipant` с `omniAccountBinding`/`omniMessageLink`); в `crm-audit-public-merge.postgres-spec.ts:1067` использовать реально непокрытый объект с метаданными и FK на `company` (например `task` с relation-полем к `company` в фикстуре).
2. **M2 - `runInNativeCrmMergeChildScope` должен выдаваться только для покрытого родителя (`isCoveredTargetObject`)**:
   - **Решение**: в `CommonMergeManyQueryRunnerService.mergeRelatedRecordsIntoPriorityRecord` передавать `isCoveredTargetObject` (`isNativeCrmAuditMetadata(flatObjectMetadata, workspaceId)`) и выдавать `runInNativeCrmMergeChildScope` только при `isCoveredTargetObject && isNativeCrmAuditFkChildMetadata(...) && isRegisteredNativeCrmAuditScope(transactionScope)`, оборачивая только `soft-delete` дубликатов и `update` миграции.

### Minor
1. **m1 - `assertNoSharedFilesAcrossLockedRows` и soft-deleted `attachment`**: зафиксировано, что `core.file` в Twenty привязан 1:1 к конкретному полю и записи; `prepareNativeCrmDeleteFiles` дополнительно проверяет отсутствие пересечения `fileId` между всеми `targets` (`parent` + `cascadeTargets`).
2. **m2 - Инварианты формы таблицы и валидация гранта**: для обоих спецрежимов (`allowFkChildDeleteEffect` и `mergeChildScope`) сохраняются строгие проверки `metadata.id === shape.objectMetadataId`, `metadata.nameSingular === shape.nameSingular`, `shape.tableName === computeTableName(metadata.nameSingular, false)`; в `runInNativeCrmMergeChildScope` добавляется валидация UUID `objectMetadataId` и непустого `allowedJoinColumnName` с очисткой в `finally`.
