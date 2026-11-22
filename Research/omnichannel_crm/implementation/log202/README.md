# LOG-202 - транзакционный аудит публичного физического удаления CRM-записей (`DESTROY_ONE` / `DESTROY_MANY`)

- Задача Linear: `ROB-765` (In Progress)
- Дата: `2026-11-22`
- Артефакты: [design.md](design.md) · [design-review.md](design-review.md) · [test-research.md](test-research.md) · [review.md](review.md) · [results.json](results.json) · [source-snapshot.json](source-snapshot.json) · [typecheck-differential.json](typecheck-differential.json) · [next-boundary.md](next-boundary.md)

## Что изменено
1. `packages/twenty-server/src/engine/api/common/common-query-runners/common-base-query-runner.service.ts`:
   - `CommonQueryNames.DESTROY_ONE` и `CommonQueryNames.DESTROY_MANY` добавлены в `auditedMutation` для покрытых CRM-объектов (`company`, `person`, `opportunity`, custom objects).
   - Для системного актора (`auth.type === 'system'`) задан явный `systemActorId: 'crm-api-destroy'`.
   - Сохранено повторное использование доказанного `transactionScope` через `runInExistingNativeCrmAuditScope` и открытие корневой `withNativeCrmAuditTransaction` с fail-closed отказом на внешних/поддельных/несовпадающих скоупах.
2. `packages/twenty-server/src/engine/api/common/common-query-runners/common-destroy-many-query-runner.service.ts`:
   - В `processNestedRelationsHelper.processNestedRelations(...)` передан `repository: queryRunnerContext.repository`, чтобы чтение вложенных связей выполнялось на том же транзакционном соединении.
3. `packages/twenty-server/src/engine/api/common/common-query-runners/common-destroy-one-query-runner.service.ts`:
   - Усилен `validate(args, queryRunnerContext)`: отказ на `flatObjectMetadata.isRemote`, отсутствующем `args.id` и невалидном UUID через `isValidUuid` из `twenty-shared/utils` (без добавления новых рёбер в Enterprise-достижимые модули; `0` нарушений `check_enterprise_dependencies.py --verify-baseline`).
4. `packages/twenty-server/src/engine/core-modules/record-crud/services/delete-record.service.ts`:
   - В `catch (error)` добавлен явный проброс `NativeTransactionOutcomeUnknownError`, чтобы неизвестный исход после `COMMIT` не маскировался в `{ success: false }`.
5. `packages/twenty-server/test/fork-migration/crm-audit-public-destroy.postgres-spec.ts`:
   - 4 новых интеграционных PostgreSQL 17 теста, покрывающих `destroyOne` и пакетный `destroyMany` (`>= 2` записей под одним `operationId`) на стандартных и кастомных объектах, живых и мягко удалённых строках, всех 5 типах акторов (`user`, `apiKey`, `application`, `agent`, `system`), `selectedFields` без `id`, unmatched deletes, `validate()` обоих раннеров, прямые FK-эффекты (`ON DELETE SET NULL` и `ON DELETE CASCADE`) + чтение `ONE_TO_MANY`, fail-closed отказы по `FILES` (родитель и CASCADE-дочерний), `OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND`, непокрытые FK-таблицы (`CASCADE`/`SET NULL`/`RESTRICT`), `BEFORE DELETE` trigger skips, relation-traversal фильтры, RLS-предикаты, реальное маскирование вложенных записей через `CommonRecordVisibilityService`, отравление внешнего scope (`plain external`, `standaloneShareWithScope`, shallow copy, expired, wrong actor, wrong `workspaceId`, `RECORD_NOT_FOUND`, uncovered `task`), отказ по правам (`PERMISSION_DENIED`), откат при сбое триггера вставки аудита, happy-path и потерянный `COMMIT` ACK через `DeleteRecordService(soft: false)`.

## Проверки
- Целевые PostgreSQL 17 наборы (стенд `twenty-rob764-fa23a3ac4fa244bf`): `5/5` наборов, `210/210` тестов PASS (`45.662s`) - `crm-audit-public-destroy`, `crm-audit-public-update`, `crm-audit-native-delete`, `crm-audit-delete-set-null`, `omni-detached-parent-delete`.
- Полная PostgreSQL-регрессия: `137/138` наборов, `3250/3251` тестов PASS (`745.113s`); единственное падение - известный pre-existing флейк порядка UUID в несвязанном `crm-audit-signing-key.postgres-spec.ts:391` (`LOG-195`, ранее зафиксирован в `LOG-200`, вне diff `LOG-202`).
- Гарды: `check_enterprise_dependencies.py --verify-baseline` PASS (`0` violations), `check_fork_migration_sources.py` PASS (`10` sources), `33/33` Python unit tests PASS (`0.149s`).
- Дифференциальный typecheck: `pass-no-new-diagnostics`, `505/505` корней, baseline `276` / current `275`, `0` new / changed-file / changed-code diagnostics.
- SHA-256 сверка загруженных исходников: `5/5` совпали; стенд полностью очищен.

## Границы и ограничения
- Непокрытые стандартные FK-дочерние таблицы (`timelineActivity`, `noteTarget`, `taskTarget`, `attachment`, `favorite`, `messageParticipant`, `calendarEventParticipant`, `messageThreadTarget`, `calendarEventTarget`, `agentChatThreadTarget`, `messageListMember`) намеренно отклоняют физическое удаление родителя fail-closed (GraphQL `INTERNAL_SERVER_ERROR` / REST HTTP `400` через `RestApiExceptionFilter`) до подключения их аудита.
- Проброс ALS `impersonator`/`viaApplication`/`correlationId` в `CommonBaseQueryRunnerService`, `CommonMergeManyQueryRunnerService` (`LOG-203`), проброс `NativeTransactionOutcomeUnknownError` в остальных сервисах `record-crud`, долговечный owner удаления файлов `FILES`, полная HTTP/JWT приёмка и выкат остаются открытыми критериями `ROB-765`.
