# Сквозные права: карта исходников и план интеграции

Дата: 26.10.2026. Источник: `729f6236126eddaa68d176fb766bc349b19de11d` — принятый снимок Twenty 2.52. Проверенные каталоги ORM/API/files/export/subscriptions не отличаются от этого SHA. Номера строк относятся к нему. Это статическое исследование: собственная политика ещё не реализована; тесты и runtime-проверки в этой работе не запускались. Отдельный стенд и предварительные выбрасываемые прототипы не требуются: проверки ниже входят в реализацию механизмов.

Префикс путей в таблицах: `packages/twenty-server/src/`. Требования и лицензионная граница: [этап 3](../plan/phase_3_access.md), [собственная реализация](../design/07-license-boundary.md). Это карта критических путей, не утверждение об отсутствии всех обходов во всём монорепозитории.

## Подтверждённый общий путь

`REST / generated GraphQL → CommonBaseQueryRunner.execute → WorkspaceOrmManager → WorkspaceRepository → WorkspaceSelectQueryBuilder → SQL`.

Наиболее общий технический стык для чтения — `WorkspaceRepository.onBeforeExecute`, который уже передаётся query builder. Он охватывает обычное выполнение select/count и явный вызов `applyRowLevelPermissions()` перед включением подзапроса в raw SQL. Он не охватывает произвольный raw SQL, запись, публикацию события или загрузку файла. Поэтому одного hook в CommonBase либо GraphQL guard недостаточно.

| Путь | Фактический entry point / доказательство | Что необходимо добавить |
|---|---|---|
| Generic REST | `engine/api/rest/core/handlers/rest-api-find-many.handler.ts:52`, `rest-api-update-one.handler.ts:46`, `rest-api-group-by.handler.ts:46` вызывают соответствующий common runner | Наследовать общую политику; негативные API-тесты, без отдельной расходящейся реализации REST ACL |
| Generated GraphQL | `engine/api/graphql/workspace-resolver-builder/factories/find-many-resolver.factory.ts:50`, `update-one-resolver.factory.ts:40`, `group-by-resolver.factory.ts:51` вызывают common runner | Те же правила, включая filter/order/relations/aggregate и bulk mutations |
| Common runner | `engine/api/common/common-query-runners/common-base-query-runner.service.ts`: `execute:121`, вход в workspace context `:172`, pre-query hooks `:259`, `runFilteredMutation:418`. Post hooks запускаются через `transactionScope.afterCommit:337` | Передать собственный actor/scope при необходимости; не использовать post hook для обязательного транзакционного аудита. Проверку этапов выполнять в общей mutation transaction |
| Контекст и транзакции | `engine/twenty-orm/workspace-orm.manager.ts`: `getRepositoryWithContextPermissions:81` вычисляет пересечение ролей и отказывает при отсутствующем контексте; `runInWorkspaceTransaction:115`, `executeInWorkspaceContext:123`, lite context `:204` | Собственный контекст должен сохраняться в обычном/lite/transactional пути. Отсутствие собственного контекста у protected объекта означает отказ, не admin |
| Передача контекста дочерним repository | `engine/twenty-orm/datasource/workspace-data-source.ts`: `transaction:74`, raw executor `:122`, построение repository `:223`, `getRepositoryForObjectMetadataId:229`, новая transaction `:244` | Передать один контракт actor/purpose/policy version в дочерние repository и в новую transaction; не терять scope при relation traversal |
| Select/count/aggregate | `engine/twenty-orm/repository/workspace-repository.ts`: `createQueryBuilder:197`, callback `:204`, `onBeforeExecute:2101`. `engine/twenty-orm/query-builder/workspace-select-query-builder.ts`: `applyRowLevelPermissions:676`, `getCount:682`, выполнение select `:1232` | Независимый собственный SQL predicate до чтения, сортировки, лимита, count и aggregate; существующие object/field checks сохраняются |
| Записи | `workspace-repository.ts`: `performInsert:1021`, `performBatchUpdate:1131`, `runMutation:1613`, `performMutation:1637`; отдельные public insert/update/upsert/delete/restore пути сходятся в этих механизмах | Проверка целевых строк и будущего состояния, перехода этапа, назначения и системных полей внутри той же transaction; audit + mutation атомарны. Не ограничиваться select hook |
| Relations | `engine/api/common/common-nested-relations-processor/process-nested-relations.helper.ts`: child repository `:203`, `findRelations:396`, `findRelationRecordIdsLimitedPerParent:498`, явный `applyRowLevelPermissions:522` | Scope распространяется на child и оконные подзапросы. В join ограничивать видимость связанной строки без раскрытия её labels/ids и без непреднамеренного исчезновения видимого родителя |
| GroupBy | `engine/api/common/common-query-runners/common-group-by-query-runner.service.ts`: `run:81`, QB `:97`, with-records `:158`, обычный `getRawMany:373`. `engine/api/graphql/graphql-query-runner/group-by/services/group-by-with-records.service.ts`: groups `:71`, raw ranked records `:105`, перед построением raw SQL явно `applyRowLevelPermissions:218` | Проверять оба SQL-пути: суммы/число групп и записи внутри группы. Raw здесь не автоматически уязвим: он получает уже подготовленный подзапрос; новый hook должен применяться и при явном вызове |
| Search | `engine/core-modules/search/services/search.service.ts`: `getAllRecordsWithObjectMetadataItems:83`, context `:114`, repository `:125`, `buildSearchQueryAndGetRecords:267`, `buildIlikeFallbackQuery:383`, transaction `:405`, QB `:417` | Search проходит мимо CommonBase, но использует ORM. Защитить основной и ILIKE fallback, связанные поля и выдаваемые file URLs. Проверить актуальность прав при чтении через replica |
| Export | `engine/core-modules/record-export/services/record-export-query.service.ts`: `countRecords:123`, common execute `:133`, `readPage:151`, execute `:165`. `services/record-export.workspace-service.ts`: `resolveRequester:521`, `capturePermissionsHash:638`, `assertPermissionsUnchanged:664`, `openDownload:352` | Добавить собственную версию политики в permission hash; восстановить актуальный actor при job/download. Имеющийся hash не знает будущих CRM team/grant/assignment таблиц |
| Export job | `engine/core-modules/record-export/jobs/generate-record-export.job.ts`: проверка hash `:65,:97,:218,:240`, повторное разрешение requester `:74,:226`, чтение страницы `:235` | Сохранить существующую проверку до/после страниц и на download; revoke собственной политики должен делать уже созданный export недоступным |
| SSE / record events | `engine/subscriptions/event-stream.resolver.ts`: `onEventSubscription:89`, проверка владения stream `:109`, подписка `:146`. `engine/subscriptions/object-record-event/object-record-event-publisher.ts`: `publish:86`, `processObjectRecordStreamEvents:152`, существующий record gate `:216`, field masking `:243`, nested enrichment `:285`, publish `:307` | Отдельный собственный admission до формирования payload, включая before-images/deleted records; фильтрация связанных данных; revoke/invalidation ранее открытого клиента. Владение stream не равно праву видеть каждую запись |
| Файлы | `engine/core-modules/file/guards/file-by-id.guard.ts`: `canActivate:38`, `isFileFolderServable:83`. `engine/core-modules/file/controllers/file.controller.ts`: generic file route `:240`, `FileByIdGuard + NoPermissionGuard:241`, `getFileById:242`, presigned redirect `:283` | Для protected вложений проверять текущего principal и ресурс на каждом запросе, включая range/preview. Закрыть старый capability route для этой категории; один новый защищённый URL при работающем старом пути недостаточен |

## Обходы и границы, которые нельзя пропустить

1. **Raw SQL.** `WorkspaceRepository.executeRaw:186` компилирует параметры и напрямую вызывает executor. `WorkspaceDataSource.transaction` предоставляет `executeRawQuery:122`. Эти методы не вставляют политику автоматически. Для каждого нового raw call нужен конкретный владелец scope и SQL. Текущие groupBy/relations с явным подготовленным QB сохраняются; бездумно запрещать все raw calls нельзя — через них работают и внутренние операции записи.
2. **Upstream bypass.** `workspace-repository.ts:2109,:2146` пропускает existing permissions при `shouldBypassPermissionChecks`. `findRecordSnapshotsBypassingPermissions:1428` создаёт QB с `onBeforeExecute: () => undefined` на `:1471`; `performMutation:1668` при bypass + skip events может не читать before-image. Собственные проверки и обязательный audit нельзя привязать к наличию этих событий/снимков. Bypass — отдельный явный purpose и сервисный actor, не наследование «разрешить всё» из этого флага.
3. **Реальные privileged writers существуют.** Например, `modules/messaging/message-import-manager/services/messaging-message.service.ts:67,:72,:78`, `modules/messaging/message-outbound-manager/services/messaging-draft-send.service.ts:72,:141`, `modules/messaging/message-cleaner/services/messaging-message-cleaner.service.ts:43`. Для переиспользуемых writers требуется классификация назначения (ingest/cleanup/send) и own policy/audit; нельзя считать их пользовательским CRUD с обычным guard.
4. **Workspace scope — не record ACL.** `engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository.ts:21` предназначен для core entities; `findOne/find/count` добавляют workspaceId, но не наши team/record/stage grants. Новые core policy/audit/connector repositories должны вызываться через проверенные domain services. Прямой TypeORM/raw путь не получает WorkspaceRepository hook.
5. **Файловый token не проверяет текущую роль.** `FileByIdGuard` проверяет JWT, workspace/fileId и отсутствие suspension. В нём нет проверки текущего пользователя и ACL записи. `file/file-upload/guards/create-file-upload-permission.guard.ts:36` проверяет workspace upload permission; это не разрешение прикрепить файл к любому диалогу. Нужны отдельные проверки attachment association/ownership, выдачи URL и скачивания. Presigned URL/кэш/уже скачанные данные нельзя отозвать одной сменой роли; protected путь должен исключать дальнейшее чтение по старой capability. Скачанную ранее копию отозвать невозможно.
6. **Аудит не равен post-query event.** Generic post hooks могут выполняться после commit. Для принятого изменения обязателен transactional audit в write transaction, для отклонённой операции — отдельное ограниченное событие отказа, поскольку rollback основной transaction удалит запись аудита в ней. Ответ и отказ не раскрывают существование/содержание чужого объекта.

## Лицензионная граница по исходникам

`workspace-repository.ts`, `workspace-select-query-builder.ts`, `workspace-data-source.ts`, `workspace-orm.manager.ts` и `common-base-query-runner.service.ts` не имеют заголовка `@license Enterprise`. Это технические места интеграции в обычный upstream-код; применяются корневая/пакетная лицензии. Отсутствие заголовка само по себе не доказывает отсутствие коммерческих зависимостей: repository уже импортирует такие helpers.

Подтверждённый `/* @license Enterprise */` на первой строке:

- `engine/twenty-orm/utils/resolve-row-level-permission-record-filter.util.ts`;
- `engine/twenty-orm/utils/render-row-level-permission-filter-to-sql.util.ts`;
- `engine/twenty-orm/utils/is-record-matching-rls-row-level-permission-predicate.util.ts`;
- `engine/core-modules/record-share/services/record-access-policy.service.ts` — именно его `buildEventRecordAccessGate:56` вызывается publisher на `:110`.

Собственный policy compiler, event admission и validators пишутся от наших требований. Эти Enterprise helpers не копируются и не становятся runtime-зависимостью нового модуля; `EnterprisePlanService`, entitlement и feature gates не подменяются. Наличие существующих импортов в неизменённой базе не является активацией коммерческой функции. При реализации нужен отдельный проверенный dependency/license inventory, включая тестовые helpers: существующий Enterprise gate нельзя просто объявить бесплатной extension API.

## Конкретные изменения при реализации

Общая политика защищает и сделку без conversation, поэтому один движок разместить в `engine/core-modules/crm-access/`; `modules/omnichannel/access/conversation-access.service.ts` — адаптер к нему, не второй policy engine. Имена ниже — предлагаемые новые файлы, сейчас их наличие не утверждается.

| Новый файл под `packages/twenty-server/src/` | Ответственность |
|---|---|
| `engine/core-modules/crm-access/crm-access.module.ts` | Регистрация зависимостей без Enterprise RLS |
| `engine/core-modules/crm-access/types/crm-access-context.type.ts` | Workspace, actor и действующие ограничения user/app/agent; explicit system purpose; policy version. Поля не берутся из клиентского payload как доверенные |
| `engine/core-modules/crm-access/services/crm-access-policy.service.ts` | Разрешение текущих team/member/grant/assignment/stage правил; deny при отсутствующем actor/правиле для protected ресурсов |
| `engine/core-modules/crm-access/query/crm-scope-predicate.ts` | Собственный параметризованный SQL predicate, root/joins/EXISTS, защита от OR-обхода и повторного применения после clone |
| `engine/core-modules/crm-access/services/crm-mutation-policy.service.ts` | Проверка before/after, перехода этапа и системных полей в transaction; согласование с revoke/takeover fence и transactional audit |
| `engine/core-modules/crm-access/services/crm-event-access.service.ts` | Admission SSE событий и отзыв видимости без зависимости от Enterprise record-share gate |
| `modules/omnichannel/access/conversation-access.service.ts` | Перевод conversation membership/channel capabilities в общий contract |
| `modules/omnichannel/attachments/guards/conversation-attachment-access.guard.ts` | Проверка актуального права на attachment/preview/range; привязка к выбранному в этапе 6 controller |

**Существующие файлы для изменения:**

1. `workspace-orm.manager.ts`, `interfaces/workspace-internal-context.interface.ts`, `datasource/workspace-data-source.ts`, `workspace-repository.ts` — передача own context и enforcement. Options репозитория определены прямо в `workspace-repository.ts:139`. В `onBeforeExecute` добавить independent hook, который не выключается upstream bypass без отдельного разрешённого purpose. В трёх mutation kernels добавить admission/validation/audit в существующем transaction owner. Metadata/storage/migration policy tables согласуются с этапом 1, их схему этот аудит не выдумывает.
2. `workspace-select-query-builder.ts` — уже имеются `addRowAccessCondition:206` и `addJoinCondition:694`; использовать эти SQL-механизмы. Root condition должна находиться вне пользовательского OR, join condition — в соответствующем ON/EXISTS. Если нужен marker для собственного idempotent hook/clone, добавить отдельно от Enterprise marker; необходимость подтвердить тестами. `workspace-repository.ts:addConditionForAlias:2568` показывает разницу механизмов, но не является готовым независимым policy API.
3. `common-base-query-runner.service.ts` — менять только для недостающей передачи actor/transaction context и защищённых command fields. Главную row policy здесь не дублировать. `process-nested-relations.helper.ts`, оба groupBy файла и `search.service.ts` — точки проверки scope propagation; править только найденные разрывы, не добавлять второй engine.
4. `record-export/services/record-export.workspace-service.ts` — включить собственную policy version в capture/check hash; `record-export/jobs/generate-record-export.job.ts` сохраняет актуальный requester на каждой странице. Одной неизменившейся upstream role map недостаточно после переназначения клиента.
5. `subscriptions/object-record-event/object-record-event-publisher.ts` и lifecycle `event-stream.service.ts`/`event-stream.resolver.ts` — independent admission и отзыв подписки/клиентского record cache при изменении своих прав. ORM hook не фильтрует уже сформированный payload.
6. `file/guards/file-by-id.guard.ts`, `file/controllers/file.controller.ts` и URL issuance/attachment adapter — классифицировать protected файлы, не разрешать generic capability обход; использовать authenticated current-ACL download. Public assets и отдельный record-export download сохраняют собственные контракты. File upload permission дополняется проверкой привязки к ресурсу.
7. Auth/API/app/agent/job entry points должны заполнять один actor contract. Подробный AI/workflow call graph вынесен в соответствующее исследование; этот документ не объявляет их транзитивно безопасными только из-за наличия ORM hook. Новые core repositories, privileged messaging writers и все новые raw calls входят в отдельный bypass inventory.

## Что уже доказано и что доказывают тесты реализации

Статически подтверждены call sites, места передачи context, существующие callback/mutation kernels, raw/bypass и разные пути файлов/export/SSE. Не доказаны работоспособность будущего predicate, отсутствие пропущенного call site, атомарность нового аудита, конкурентный revoke, отсутствие утечки через replica/cache или полнота лицензионного dependency graph.

Существующие тесты можно расширить, но их наличие не означает, что новая политика проверена:

- `engine/twenty-orm/__tests__/workspace-orm-context-permissions.spec.ts:30` — пересечение user/app ролей, transaction, отсутствие роли;
- `engine/twenty-orm/query-builder/__tests__/workspace-select-query-builder-row-access.spec.ts:21` — OR, count, mutation, clone, замена where;
- `engine/twenty-orm/repository/__tests__/workspace-repository.spec.ts` — repository behavior;
- `engine/core-modules/record-export/utils/__tests__/compute-record-export-permissions-hash.util.spec.ts:17` — изменение upstream permissions hash;
- `engine/subscriptions/object-record-event/__tests__/object-record-event-publisher.spec.ts` — существующая публикация;
- `engine/core-modules/file/controllers/file.controller.spec.ts` — file controller. Лицензии конкретных заимствуемых fixtures/helpers проверить до использования.

Обязательные новые поведенческие проверки в реализации:

| Проверка | Проверяемый результат |
|---|---|
| Два workspace, managers A/B, lead/admin, user+app+agent, missing/revoked actor | Запрет не обходится сменой API, system field или отсутствующей ролью; служебный purpose ограничен |
| REST и GraphQL CRUD/bulk/upsert/delete/restore + прямой domain repository | Одинаковая политика; запрещённый stage/assignment не меняется; audit и принятые изменения коммитятся/откатываются вместе |
| OR/filter/order/count/groupBy ± records, clone, to-one/to-many/EXISTS | Запрет до SQL pagination/aggregate; скрытые labels/ids/суммы не выдаются; видимый родитель обрабатывается по заданному контракту |
| Основной Search и fallback, replica lag | Поиск и связанные поля не раскрывают revoked scope; источник policy имеет достаточную актуальность |
| Export между страницами, после создания и перед download | Собственный revoke инвалидирует hash/выдачу; старый job не продолжает со старым scope |
| SSE revoke/delete/before-image/related payload и переподключение | После отзыва нет новых запрещённых данных; клиент убирает ранее открытые записи по invalidation |
| Protected file URL, старый JWT URL, preview/range, привязка чужого файла | Все варианты проходят актуальный ACL; generic URL не остаётся обходом; public assets не ломаются |
| Конкурентный revoke/takeover vs CRM/AI/workflow mutation | Проверка и изменение разделяют выбранный transaction fence, а не только последовательность check-then-write; test останавливает выполнение между check и write |

Критерий готовности этапа 3 — эти проверки на бесплатной конфигурации без Enterprise key и замкнутый inventory обходов. Статическое чтение исходников не заменяет эту приёмку.
