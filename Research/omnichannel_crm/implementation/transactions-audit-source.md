# Транзакции и durable audit: проверка исходников

Дата: 26.10.2026. База: `729f6236126eddaa68d176fb766bc349b19de11d` (принятый snapshot разработки 2.52). Корень исходников: `C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/`. Сверка `git diff --name-only 729f6236126eddaa68d176fb766bc349b19de11d --` по исследованным каталогам ORM, common-query-runners, messaging и message-channel не обнаружила отличий runtime-кода.

Это статическое исследование. Runtime, миграции и тесты не запускались; код не изменён. Отдельный стенд и выбрасываемый transaction spike не требуются для завершения плана. Перечисленные ниже проверки входят в тесты будущей реализации. Робот исключён; собственный аудит разрабатывается без подписки Twenty.

## 1. Что уже позволяет общий commit

**Для workspace-записей общий transaction owner существует. Это `pg.PoolClient`, а не TypeORM `EntityManager`.**

| Точка | Подтверждённое поведение |
|---|---|
| [workspace-orm.manager.ts:115](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/twenty-orm/workspace-orm.manager.ts:115>) — `WorkspaceOrmManager.runInWorkspaceTransaction` | Вызывает `getDataSource({useReplica:false}).transaction(work)`. |
| [workspace-data-source.ts:74](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/twenty-orm/datasource/workspace-data-source.ts:74>) — `WorkspaceDataSource.transaction` | Создаёт `WorkspaceTransactionScope`: `getRepository` использует один переданный executor и `isTransactional:true` (105–121); `executeRawQuery` использует тот же executor (122–123). |
| [run-in-rollback-safe-transaction.util.ts:9](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/twenty-orm/datasource/utils/run-in-rollback-safe-transaction.util.ts:9>) — `runInRollbackSafeTransaction` | `pool.connect()` → `BEGIN` → callback → `COMMIT`; при ошибке пытается `ROLLBACK`, затем освобождает/уничтожает соединение (16–46). |
| [workspace-transaction-scope.type.ts:8](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/twenty-orm/types/workspace-transaction-scope.type.ts:8>) | Публичный scope предоставляет repositories, raw SQL и `afterCommit`; TypeORM manager в нём отсутствует. |

Следствие: `Message`, участники, собственные link/receipt/conversation/outbox и запись аудита могут коммититься вместе, **если каждая запись использует этот scope** и находится в той же PostgreSQL БД. Для отдельной таблицы собственного аудита допустим параметризованный `transactionScope.executeRawQuery`; имя схемы/таблицы задаёт сервер, не входящий клиент. Таблица должна создаваться миграцией и иметь ограничения tenant/command/event uniqueness.

**Ambient workspace context не является ambient transaction.** [WorkspaceOrmManager.executeInWorkspaceContext:123](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/twenty-orm/workspace-orm.manager.ts:123>) только загружает контекст и вызывает `withWorkspaceContext`. Обычный [WorkspaceDataSource.getRepository:60](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/twenty-orm/datasource/workspace-data-source.ts:60>) создаёт `PoolQueryExecutor`; его [execute:14](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/twenty-orm/executor/pool-query-executor.ts:14>) делает `pool.query`. Поэтому вызов `workspaceOrmManager.getRepository(...)` внутри callback общей транзакции может записать через другое соединение. Повторный `runInWorkspaceTransaction` также создаёт самостоятельную транзакцию, а не savepoint.

## 2. APP ingestion: точный поток и границы

```text
ApplicationMessageIngestionService.ingest
  → findOwnedOrThrow / isSyncEnabled / validation / identity existence
  → CacheLockService.withLock (workspace + channel)
    → MessagingSaveMessagesAndEnqueueContactCreationService
      .saveMessagesAndEnqueueContactCreation
        → executeInWorkspaceContext(system, lite)
          → runInWorkspaceTransaction(scope)
            → MessagingMessageService.saveMessagesWithinTransaction(scope)
            → MessagingMessageParticipantService.saveMessageParticipants(scope)
            → MessagingMessageFolderAssociationService.saveMessageFolderAssociations(scope)
          → COMMIT + in-memory afterCommit callbacks
        → enqueue contact creation, если включено
        → matchMessageParticipants (APP: targetsOnly)
  → проверить наличие всех returned IDs → ответ API
```

1. [ApplicationMessageIngestionService.ingest:54](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/metadata-modules/message-channel/services/application-message-ingestion.service.ts:54>): ownership/sync проверки в 61–78 выполняются **до** транзакции сохранения. `assertReferencedIdentitiesExist:176` использует обычный repository (231). Они не заменяют финальную проверку разрешения/activation/policy под общим fence в нашей команде.
2. Там же [withLock:88](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/metadata-modules/message-channel/services/application-message-ingestion.service.ts:88>): комментарий явно объясняет отсутствие unique index у `headerMessageId` и read-before-write dedup. Cache lock — текущая сериализация канала, не постоянный журнал приёма и не уникальность нашего provider event в БД.
3. [saveMessagesAndEnqueueContactCreation:45](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service.ts:45>): метод сам открывает транзакцию в 63–64. Вызов этого публичного метода из новой внешней транзакции **не объединит** коммиты.
4. [MessagingMessageService.saveMessagesWithinTransaction:46](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/modules/messaging/message-import-manager/services/messaging-message.service.ts:46>) уже принимает scope. Repositories для association/message/thread берутся из него (65/71/76); чтения dedup — 83–100; вставка threads — 252–253; upsert subject — 257; messages — 269; associations — 275. Это готовое ядро повторного использования.
5. [MessagingMessageParticipantService.saveMessageParticipants:26](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/modules/messaging/message-participant-manager/services/messaging-message-participant.service.ts:26>) использует scope repository (36), обновляет identity/displayName (134), вставляет участников (138). [saveMessageFolderAssociations:16](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/modules/messaging/message-import-manager/services/messaging-message-folder-association.service.ts:16>) также принимает scope и вставляет связи через него (38–55).
6. **После commit:** contact job добавляется в [aggregate:179–193](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service.ts:179>); matching/targets — 209–217. Ошибка здесь может вернуть ошибку API уже после сохранения сообщений. Нельзя трактовать её как доказательство отсутствия записи.
7. Для APP используется `targetsOnly`. [MatchParticipantService.matchParticipants:95](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/modules/match-participant/match-participant.service.ts:95>) уже принимает optional scope и передаёт его в target reconciliation (107–113). [ParticipantTargetReconciliationService.reconcileParticipantTargets:94](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/modules/match-participant/participant-target-reconciliation.service.ts:94>) далее прокидывает scope в чтения и изменения target records (164, 205, 227, 290, 322–361). Но wrapper `MessagingMessageParticipantService.matchMessageParticipants:154` сейчас не принимает/не передаёт scope.

**Необходимое изменение:** выделить из aggregate блок записи messages + participants + folders в внутренний метод с обязательным scope, сохранив текущий внешний метод для email import. Omnichannel owner вызывает внутренний метод в своей транзакции вместе с receipt/link/conversation revision/AutomationAdmission/domain outbox/audit. Для omni нельзя вызывать штатный targetsOnly/reconcile: buildDesiredTargets автоматически добавляет Company/Opportunity и isAutomaticallyAssigned=true. Переиспользуются scope-aware repositories, а projection пишет только domain link/unlink из явного ConversationTarget. Обычный non-omni APP сохраняет прежний контракт. Не переносить email matching целиком под долгую транзакцию: существующий тест специально закрепляет его выполнение после commit.

Внутренний метод должен возвращать стабильные IDs и результат dedup, не посылать внешние сообщения/очереди. Postcommit jobs, которые нельзя потерять, создаются как задания в БД этой транзакции; enqueue в Redis — восстановимая доставка задания, а не единственная его копия. Уникальность receipt и AutomationAdmission в БД обязательна независимо от cache lock. Импорт не запускает автоматику сам; отдельный trusted live/replay admission после activationBoundary может создать один effect даже при import-first сохранении Message.

## 3. Generic CRUD: где действительно выполняется write

Entry points сходятся в common query runners:

- REST: [RestApiUpdateOneHandler:46](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/api/rest/core/handlers/rest-api-update-one.handler.ts:46>), create-one handler:47.
- GraphQL: [UpdateOneResolverFactory:40](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/api/graphql/workspace-resolver-builder/factories/update-one-resolver.factory.ts:40>), create-one factory:40.
- Record tools: [UpdateRecordService.execute:96](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/core-modules/record-crud/services/update-record.service.ts:96>), CreateRecordService:69, DeleteRecordService:64/81; [UpdateRecordWorkflowAction:123](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/modules/workflow/workflow-executor/workflow-actions/record-crud/update-record.workflow-action.ts:123>) вызывает UpdateRecordService.

[CommonBaseQueryRunnerService.execute:121](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/api/common/common-query-runners/common-base-query-runner.service.ts:121>) делает validate → compute/pre-query hooks → workspace context → run → result getters/visibility/post-query hooks. **Сам по себе этот метод не открывает общую write transaction.** В `prepareExtendedQueryRunnerContextWithGlobalDatasource:367` scope repository выбирается только когда scope уже передан; иначе берётся обычный repository.

`CommonCreateOneQueryRunnerService.run` делегирует create-many; `CommonUpdateOneQueryRunnerService.run:43` делегирует update-many. `CommonBaseQueryRunnerService.runFilteredMutation:464` вызывает `writeRepository.runMutation`. Особые границы:

- [CommonCreateManyQueryRunnerService.run:96](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/api/common/common-query-runners/common-create-many-query-runner/common-create-many-query-runner.service.ts:96>) открывает transaction для record shares / nested relation create, если scope отсутствует, и заменяет repository на scope repository (109–119).
- [CommonMergeManyQueryRunnerService:485](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/api/common/common-query-runners/common-merge-many-query-runner.service.ts:485>) имеет отдельного transaction owner. Его необходимо научить присоединяться к переданному scope перед общей обёрткой audited commands; иначе останутся независимые коммиты.
- [WorkspaceRepository.runAtomically:769](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/twenty-orm/repository/workspace-repository.ts:769>) переиспользует уже transactional repository, иначе вызывает `runInNewTransaction`. `save:839` и `upsert:927` используют эту обёртку.
- `runInsert:1005`, `runBatchUpdate:1116`, update через `runMutation:1613` идут через `runWithValidationRules:777`. При отсутствии active validation rules метод сразу делает `write(this)` (793–794). Остальные mutation kinds вызывают `performMutation` напрямую (1620–1621). Следовательно, **не все обычные CRUD mutations сейчас охвачены явной многооперационной транзакцией**.

**Точки необходимых изменений:**

1. Общая команда изменения получает operation/command ID, проверенного actor, origin/causation и optional conversation epoch. Для write execution в common runner при отсутствии scope открыть transaction, при наличии — присоединиться. Передать этот же scope всем nested/shared/merge writes. Под fence проверить актуальную policy/epoch и держать блокировку до commit; snapshot `authContext`, загруженный ранее, не доказывает актуальность прав во время конкурентного revoke.
2. Добавить собственный awaited durable audit writer в write path repository (`performInsert`, `performBatchUpdate`, `performMutation`) на том же executor, **до commit**. Это покрывает и прямых domain writers, минующих API runner. Для audited объектов обернуть самостоятельный repository write в `runAtomically` независимо от наличия validation rules. Composite command при этом пользуется уже открытым scope, а не создаёт вложенную независимую транзакцию.
3. Не использовать `shouldSkipEventEmission` как разрешение пропускать аудит. Не писать audit через собственный же обычный CRUD repository с рекурсивным аудитом: нужен узкий внутренний append-only writer. Он фиксирует успешные реальные строки, а не запрошенный, но не исполненный bulk input; redaction выполняется до INSERT. Две existing emit actions `CREATED`/`UPSERTED` (repository:1406) не должны превращать одну create command в два одинаковых audit-success.
4. `WorkspaceRepository.performMutation:1682` читает before-image до SQL изменения, а затем выполняет mutation в 1755. Отдельного row lock здесь нет. Для достоверного аудита concurrent updates и fence нужны блокировки затрагиваемых строк/версий в общем порядке либо проверяемая revision CAS. Простое копирование нынешних event snapshots не гарантирует точный previous value. SQL helpers следует реализовать в production-коде с ограничениями tenant, набора строк и лимитов; audit hook после commit проблему не решает.
5. `WorkspaceRepository.executeRaw:186` и `WorkspaceTransactionScope.executeRawQuery` допускают SQL вне record hooks. Raw writers должны либо явно append audit в том же scope, либо быть исключены из доступных прикладных путей по конкретной причине. Нельзя объявить один hook покрытием всех core/metadata/raw SQL операций. Core/metadata TypeORM owners требуют собственных adapters; эта записка не утверждает, что они уже покрыты.

## 4. Почему обычные события не заменяют audit outbox

[WorkspaceDataSource.transaction:80–101](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/twenty-orm/datasource/workspace-data-source.ts:80>) заменяет `emitDatabaseBatchEvent` и record-stock side effects на `afterCommit` callbacks. Массив callbacks живёт в памяти (77–79). После commit callbacks вызываются последовательно; ошибка логируется и подавляется (128–136). Между COMMIT и callback возможна потеря процесса; persisted retry row тут нет.

[WorkspaceEventEmitter.emitDatabaseBatchEvent:42](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/workspace-event-emitter/workspace-event-emitter.ts:42>) заканчивается обычным `EventEmitter2.emit` (70). [CommonBaseQueryRunnerService.enrichResultsWithGettersAndHooks:328](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/api/common/common-query-runners/common-base-query-runner.service.ts:328>) также откладывает post-query hooks через `afterCommit` при наличии scope; без scope запускает их после `run`. Это notification hooks, не commit-coupled durable audit.

Существующий [EventLogsService:1](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/core-modules/event-logs/event-logs.service.ts:1>) помечен Enterprise; его не берём за обязательную основу. Даже независимо от лицензии [EventLogEmitterService.emit:108](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/core-modules/event-logs/emit/event-log-emitter.service.ts:108>) ловит ошибку и возвращает `{success:false}` (115–118); это не rollback caller mutation.

Собственный `CrmAuditEntry`/outbox должен вставляться внутри owner transaction. После commit можно будить доставщик существующими событиями, но восстановление идёт по недоставленным строкам PostgreSQL. Ошибка audit INSERT отменяет бизнес-запись; уведомление/индексация после commit не отменяет её. Для denied/failed попытки нужна отдельная запись после rollback, без ложного success и без блокирования критичного revoke/logout.

## 5. Отдельная граница файлов и неизвестный исход commit

[FilesFieldSync.constructor:53](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/twenty-orm/field-operations/files-field-sync/files-field-sync.ts:53>) берёт `coreDataSource.getRepository(FileEntity)` — TypeORM repository другого transaction owner. `updateFileEntityRecords:584` выполняет update/softDelete через него (590/602). Его вызывает workspace insert:1101 и mutation:1775. Поэтому даже внутри `WorkspaceTransactionScope` соответствующая смена file metadata не присоединяется автоматически к общему commit. Физическое содержимое в файловом/S3 storage также не становится частью PostgreSQL transaction.

Необходимая граница для вложений: staged upload → transactional claim/link + audit → восстановимая финализация/очистка. Если нужна атомарная смена core FileEntity и workspace записи, использовать SQL через **тот же** scope для доступной таблицы либо адаптер того же соединения; обычный TypeORM repository не подходит. Требуется проверить file authorization, flags и lifecycle, а не только факт INSERT audit.

`COMMIT` может завершиться на сервере, а ответ потеряться. Текущий rollback-safe helper лишь пытается rollback и преобразует ошибку; он не сверяет command journal. Поэтому при неизвестном commit outcome повтор входящей/исходящей команды обязан прочитать запись по стабильному command/event ID. Нельзя заключать «откатилась» только по исключению клиента и повторять внешний send для ремонта аудита. Внешний provider effect, receipt и local finalization имеют отдельные состояния восстановления.

## 6. Существующие тесты и будущие проверки реализации

Исходники тестов прочитаны, запусков в этом исследовании нет:

- [run-in-rollback-safe-transaction.util.spec.ts:20](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/twenty-orm/datasource/utils/__tests__/run-in-rollback-safe-transaction.util.spec.ts:20>): BEGIN/COMMIT/release (41), rollback (55), rollback failure (72/92), COMMIT error (191). Это unit mocks, не доказательство разрешения неизвестного commit outcome.
- [google/messaging/transient-database-error.integration-spec.ts:64](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/test/integration/google/messaging/transient-database-error.integration-spec.ts:64>): transient error во время participant save; тест 92–140 отдельно проверяет завершение import transaction **до** participant matching через `pg_backend_pid()` и состояние backend.
- [app-message-channels.integration-spec.ts:639](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/test/integration/metadata/suites/message-channel/app-message-channels.integration-spec.ts:639>): общий thread (639), redelivery stable IDs (681), direction (710), чужое приложение (745), sync off (763), sender/identity/batch validation (787/815/835).
- [workspace-repository.spec.ts:144](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/src/engine/twenty-orm/repository/__tests__/workspace-repository.spec.ts:144>): before/after image, обход event emission и files-field exception. Audit semantics здесь пока отсутствуют.
- [nested-relation-queries.integration-spec.ts:381](<C:/Users/regis/OneDrive/Рабочий стол/Twenty CRM/packages/twenty-server/test/integration/graphql/suites/object-generated/nested-relation-queries.integration-spec.ts:381>): rollback nested create при failure parent; 418 — rollback nested targets create-many. Это полезная существующая точка регрессии общей transaction propagation.

Обязательные тесты будущего production-кода, без отдельного прототипа:

1. Ошибка audit INSERT после каждой стадии APP aggregate откатывает Message/Thread/Participant/link/receipt/admission/outbox/revision; нет success ACK и отправки. Проверить повтор с тем же ID и оба порядка import/live, включая конкурентный.
2. REST/GraphQL/record tool/workflow и прямой repository writer: create/update/bulk/upsert/delete/restore/merge дают mutation + audit либо ни одной записи. Аудит не пропадает при `shouldSkipEventEmission`; nested writes не открывают независимый commit и не дублируют command success.
3. Takeover/revoke против текущей AI/workflow mutation: оба порядка commit, общий fence, stale epoch denied; revoke не оставляет частичную mutation. Параллельные updates имеют правдивый before/after и устойчивый lock order.
4. Падение после COMMIT до EventEmitter/Redis enqueue: audit и outbox остаются, восстановитель продолжает; повтор command не создаёт второе действие. Неизвестный COMMIT результат сверяется по журналу.
5. Scope propagation: контроль `pg_backend_pid()` и rollback для всех обязательных записей. Отдельный negative case демонстрирует недопустимость plain `getRepository`/TypeORM repository внутри общей транзакции.
6. Вложения: rollback claim/link, cleanup staged file, повтор финализации, ошибка core metadata write и отсутствие утечки доступа после revoke. Реальный storage effect не объявляется rollback-able SQL записью.
7. Audit row permissions/append-only, actor/causation, redaction, dedup operation ID, текущая видимость удалённого/переданного объекта. Проверить приложение без Enterprise entitlement.

Вывод: исходники подтверждают пригодную общую transaction primitive и переиспользуемое ядро messaging. Не хватает её явной композиции в omnichannel owner, durable audit insert до commit, покрытия самостоятельных CRUD/raw writers и согласованной границы файлов. Это конкретные изменения существующих production-путей, а не основание предварительно строить временный прототип.


## Уточнение omni target writers

`ParticipantTargetPersonListener` → `ReconcilePersonCompanyTargetsJob` → `ParticipantTargetReconciliationService.reconcileTargetsForPeople` выбирает всех messageParticipant по personId (метод :37–92); buildDesiredTargets (:386–462) добавляет Company и Opportunity по связям Person. Это не допустимый projector явных ConversationTarget. Для omni все входы автоматического reconciliation фильтруют persisted ownership до чтения/записи target batch; email/calendar сохраняют поведение. Канонический контракт — spec §7/§15.18 и repository-adapter, T05/T23. Наличие transactionScope само по себе не делает этот helper безопасным для omni.
