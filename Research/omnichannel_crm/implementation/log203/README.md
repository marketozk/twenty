# LOG-203 - транзакционный аудит публичного слияния CRM-записей (`MERGE_MANY`)

- Задача Linear: `ROB-765` (In Progress)
- Дата: `2026-11-22`
- Артефакты: [design.md](design.md) · [design-review.md](design-review.md) · [test-research.md](test-research.md) · [review.md](review.md) · [results.json](results.json) · [source-snapshot.json](source-snapshot.json) · [typecheck-differential.json](typecheck-differential.json) · [next-boundary.md](next-boundary.md)

## Что изменено
1. `packages/twenty-server/src/engine/api/common/common-query-runners/common-base-query-runner.service.ts`:
   - Для `CommonQueryNames.MERGE_MANY` значение `dryRun` однократно фиксируется (`isMergeDryRun`) и передаётся копией `effectiveArgs` в `run()` (исключает обход аудита через мутабельный геттер/хук `dryRun`).
   - Не-`dryRun` `MERGE_MANY` на покрытых CRM-объектах (`company`, `person`, `opportunity`, custom objects) включён в `auditedMutation` через `withNativeCrmAuditTransaction` / `runInExistingNativeCrmAuditScope` с явным `systemActorId: 'crm-api-merge'` для системного актора; `dryRun: true` остаётся read-only без write-транзакции и с `0` записями аудита.
   - Непокрытый не-`dryRun` `MERGE_MANY` внутри доказанного внешнего `withNativeCrmAuditTransaction` также проходит через `runInExistingNativeCrmAuditScope` и немедленно отклоняется/отравляет внешний scope до любых дочерних миграций.
2. `packages/twenty-server/src/engine/api/common/common-query-runners/common-merge-many-query-runner.service.ts`:
   - Единая транзакция без вложенного `runInWorkspaceTransaction` при наличии `queryRunnerContext.transactionScope` и defense-in-depth проверкой `isRegisteredNativeCrmAuditScope` для покрытых объектов.
   - Проверка прав (`validateWriteIsPermitted` на `'delete'` и `'update'`) и `select`-RLS видимости всех `ids` выполняется до канонической блокировки `SELECT id ... ORDER BY id FOR UPDATE` (на схеме `transactionScope.workspaceId` с `TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER` из `twenty-shared/application-runtime`, `0` новых Enterprise-рёбер), с повторным чтением `fetchRecordsToMerge` под блокировкой.
   - Нормализация `ids` в нижний регистр в начале `run()` (защита от uppercase UUID).
   - Передача `repository` в `processNestedRelationsHelper.processNestedRelations(...)` как для `dryRun`, так и после слияния.
   - Фильтрация `getRelationFieldsPointingToCurrentObject` от неактивных (`isActive: false`) и удалённых (`isRemote: true`) объектов + детерминированная сортировка `relationFields` и дочерних записей по `id`.
   - Защита от скрытых `select`-RLS живых дочерних записей (`SELECT COUNT(*)::int ...` сверка для `idsToDelete` и `priorityRecordId`), чтобы `DELETE` не мог тихо выполнить `SET NULL` или `CASCADE` по недоступным вызывающему записям.
   - Условия `[joinColumnName]: In(idsToDelete)` и `deletedAt: IsNull()` в миграционных и soft-delete запросах потомков + строгие проверки кардинальности (`softDeleted.length === idsChunk.length`, `migrated.length === idsChunk.length`, `deletedRecords.length === idsToDelete.length`).
   - Санитизация самоссылающихся связей (исключение цикла `priority -> priority` и паразитных мутаций на `idsToDelete`).
   - Усиление `validate()`: проверка `Array.isArray(ids)`, строковых UUID через `isValidUuid`, дедупликация UUID без учёта регистра, целочисленного `conflictPriorityIndex` и булева `dryRun` (закрывает REST `RestApiMergeManyHandler`, где не вызывается `assertMergeManyArgs`).
3. `packages/twenty-server/test/fork-migration/crm-audit-public-merge.postgres-spec.ts`:
   - 4 новых интеграционных PostgreSQL 17 теста, покрывающих все 5 типов акторов, 3-записное слияние, uppercase UUID, пустой `mergedData`, `selectedFields` без `id`, `dryRun: true` (корневой, внутри внешней транзакции и через геттер `preQueryHooks`), прямой вызов `run()` без доказанного scope, все проверки `validate()`, миграцию + дедупликацию потомков по уникальному индексу + `SET NULL` по soft-deleted потомкам + транзакционное чтение `people` под одним `operationId`, `select`-RLS скрытых потомков у дубликата и приоритета, fail-closed отказы (`taskTarget`, `delete_child`, `FILES` на дубликате vs happy-path `FILES` на приоритете, `OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND`), trigger skips (`BEFORE DELETE` и `BEFORE UPDATE` на миграции и soft-delete), права (`canRead`/`canUpdate`/`canDestroy` + parent `select`-RLS), агрегацию `first-before / last-after` с реальным маскированием `CommonRecordVisibilityService`, все кейсы отравления внешнего scope, откат на сбое триггера аудита и потерянный `COMMIT` ACK.

## Проверки
- Целевые PostgreSQL 17 наборы (стенд `twenty-rob764-54871e4da4c04dfd`): `5/5` наборов, `186/186` тестов PASS (`38.812s`) - `crm-audit-public-merge`, `crm-audit-public-destroy`, `crm-audit-public-update`, `crm-audit-native-delete`, `crm-audit-delete-set-null`.
- Полная PostgreSQL-регрессия: `139/139` наборов, `3255/3255` тестов PASS (`748.448s`).
- Гарды: `check_enterprise_dependencies.py --verify-baseline` PASS (`0` violations), `check_fork_migration_sources.py` PASS (`10` sources), `33/33` Python unit tests PASS (`0.159s`).
- Дифференциальный typecheck: `pass-no-new-diagnostics`, `504` корней (`baseline 503 / 275`, `current 504 / 275`), `0` new / changed-file / changed-code diagnostics.
- SHA-256 сверка загруженных исходников: `3/3` совпали; стенд полностью очищен.

## Границы и ограничения
- Непокрытые стандартные FK-дочерние таблицы (`timelineActivity`, `noteTarget`, `taskTarget`, `attachment`, `favorite`, `messageParticipant`, `calendarEventParticipant`, `messageThreadTarget`, `calendarEventTarget`, `agentChatThreadTarget`, `messageListMember`) намеренно отклоняют слияние fail-closed (GraphQL `INTERNAL_SERVER_ERROR` / REST HTTP `400` через `RestApiExceptionFilter`), если у удаляемых дубликатов есть ссылки в этих таблицах; production merge UX для записей с `timelineActivity` не заявляется завершённым до покрытия этих таблиц.
- Самоссылающиеся PostgreSQL FK с оставшимися ссылками на `idsToDelete` остаются fail-closed (`LOG-106`); проброс ALS `impersonator`/`viaApplication`/`correlationId` в `CommonBaseQueryRunnerService` и проброс `NativeTransactionOutcomeUnknownError` в оставшихся 7 сервисах `record-crud` запланированы на `LOG-204`.
