# ROB-764 — реализация, LOG-033

27.10.2026 пользователь ответил «хорошо приступай» на предложение принять
исправленный план за основу и начать ROB-764 с проверками конкретного кода.
Это разрешение перехода к реализации. Критерий ROB-772 изменён с ещё одного
полного прохода исправленной редакции на принятую исходную спецификацию:
все известные замечания закрыты в плане, оставшаяся проверка поведения идёт
через код, PostgreSQL-тесты и адресное ревью. ROB-772 завершается как задача
планирования; ROB-764 начинается и остаётся In Progress до своих критериев.
Исторический результат R16 и его ограничения сохраняются без переименования
в безусловный pass.

## Первая порция: механизм миграций и контроль зависимостей

- Отдельный `ForkMigrationRunner`: явный fork-only тип, последовательный manifest,
  проверка идентификаторов/контрольных сумм, instance-wide ledger в core.
- Advisory transaction lock на одном QueryRunner; DDL и запись об успехе в одной
  транзакции. Повтор после сбоя сверяется с журналом. Неизвестные, изменённые,
  пропущенные или несовместимые записи отклоняются.
- Отдельный `ForkSchemaVerifier` не импортирует исполняемые миграции и работает
  в read-only transaction. В LOG-021 он подключён к image startup до Nest.
- Узкая PostgreSQL-серия без загрузки `.env`, AppModule и общего database reset;
  CI использует отдельный временный PostgreSQL и уникальную БД.
- Baseline зависимостей от Enterprise-marked исходников и проверка отсутствия
  новых зависимостей. Существующая задолженность сохраняется для ROB-766;
  этот контроль не означает готовность независимой production-сборки.

Проверки: 16 PostgreSQL tests и 20 dependency guard tests прошли; focused strict
typecheck и форматирование прошли. Адресное ревью и его исправление отражены
в DEVLOG LOG-019. [Evidence](rob764-foundation-verification.json). Deployment и внешние сообщения не входят в эту порцию.

## Вторая порция: первая группа схемы и настоящий генератор

LOG-020: 9 core entities — WorkspacePolicyState, AccountBinding, Queue,
AutomationPolicy/Version, ExternalIdentity, Conversation, Member и ReadCursor.
Own relations имеют tenant/binding scope; bigint хранится строкой; динамические
Person/Thread/Member ссылки не получили фиктивных FK. Native account ownership
и domain validation остаются будущему writer. Nullable head/defaultQueue позволяют
атомарный disabled-v0 bootstrap; действующий bootstrap service ещё не написан.

Штатный генератор на реально инициализированной upstream core schema сначала
подтвердил пустой diff, затем создал up/down. Все68 SQL-вызовов сохранены при
переносе в fork registry; upstream registration/cursor не менялись. Добавлены
source-checksummed manifest, schema verifier, CLI apply/verify и подготовленный
runtime wrapper. Проверяются также invalid/deferred constraints и invalid indexes;
порядок колонок индексов читается непосредственно из PostgreSQL.

Проверки: **35 PostgreSQL tests, 25 Python guard tests, focused strict typecheck**
прошли. На настоящей upstream core schema apply/verify/replay прошли,
все256 строк upgradeMigration сохранились. Wrapper отказал при schema drift и
неправильной настройке миграций; разрешил test command после проверки готовности.
[Доказательства и ограничения](log020/README.md).

## Третья порция: упаковка и порядок запуска

LOG-021: официальный Docker target `twenty` собран. Новый image entrypoint
вызывает отдельный migrator или read-only gate перед runtime. Координатор держит
session advisory lock на всю последовательность native/fork upgrades. Строгие
cache/health/cron команды прекращают запуск при ошибках; обычные вызовы без
`--strict` сохраняют прежнее поведение. Compose разделяет credentials и не
запускает server/worker при отказе migrator. Для штатного завершения worker
предусмотрено6 минут, native AI drain по умолчанию5 минут.

Проверены38 PostgreSQL tests,15 strict-command tests,7 Linux shell tests,
25 Python guard/checksum tests и focused strict typecheck координатора/lock tests.
В настоящем собранном image присутствуют Nest JSON assets и frontend. На пустой
и заполненной upstream БД прошли миграции, replay, startup и restart; полный
снимок599 компаний,150 сделок и1200 контактов сохранился. Отдельная runtime роль
не владеет таблицами, ledger доступен только для SELECT. В Compose проверены
отказ dependency chain, успешный запуск,26 подписок worker на очереди и exit0
за5,45 секунды. [Evidence и границы этих проверок](log021/README.md).

## Четвёртая порция: минимальный аудит и bootstrap

LOG-022: добавлены CrmAuditEntry в отдельной crm_audit schema и
PolicyMutationReceipt в core. Штатно сгенерированная миграция изолирована в fork
registry; прежние девять таблиц не менялись. Transaction audit context собирает
first-before/last-after, пишет один success на resource/action до COMMIT и
отклоняет конфликт ключа/hash. Безопасные поля ограничены каталогом.

Внутренний bootstrap writer атомарно создаёт inactive binding, disabled policy v0,
policy state/epoch, audit и receipt. Обязательный authorizer вызывается под policy
UPDATE fence до исполнения и replay. Проверяется native account/channel ownership;
привязки Application/ConnectionProvider и EMAIL channel отвергаются. Повтор
возвращает прежний результат. Нет runtime activation, API или готового own ACL.

После подтверждённого rollback отказ/ошибка записываются отдельной audit transaction;
её сбой видим вызывающему коду. Неопределённый COMMIT возвращает typed unknown
для replay с тем же ключом, без ложного failed audit. Runtime gate и writer
проверяют append-only privileges, включая column grants и SET ROLE обходы.

Прошли81 PostgreSQL test,25 Python guards и7 shell tests, focused strict
typecheck40 файлов с импортами. [Доказательства и ограничения](log022/README.md).
Каталог аудита пока охватывает пять служебных сущностей; аудит всей CRM — ROB-765.

## Пятая порция: сообщения и команды

LOG-024 завершил MessageLink, MessageRevision, ConversationTarget, IncomingReceipt,
OutgoingCommand и DomainEvent. Новый composite UNIQUE Conversation проверяется
строго по версии prefix; старые migration checksums сохранены. Прошли113 PG и25
Python tests, focused typecheck49 файлов, native upgrade/replay и generator zero
diff. [Доказательства и ограничения](log024/README.md). Это schema-only порция.

## Шестая порция: события и общие лимиты

LOG-025 добавил RootExecution/RootBudgetCharge/EventDispatchPlan/ReplyBudget/
ReplySlot/RouteActivation/AutomationAdmission/ConsumerReceipt. Budget хранится
отдельно от slots, включая нулевую квоту. Tenant/policy/conversation FK и ключи
дедупликации проверены. DomainEvent получил root FK; старый orphan вызывает
полный rollback новой миграции. Старые исходники/checksums сохранены.
Прошли 135 PostgreSQL и 25 Python tests, focused typecheck 60 файлов, native
up/down/up и зарегистрированные upgrade/replay/readiness; итоговый generator
diff пустой. [Доказательства и ограничения](log025/README.md).

## Седьмая порция: durable ingress

LOG-026: внутренний acceptOmniIncomingEvent валидирует envelope, фиксирует
semantic hash до await, под policy/binding SHARE проверяет текущие полномочия,
active и generation. Receipt и redacted success audit атомарны. Одинаковый
повтор возвращает current state, другой payload конфликтует; unknown COMMIT
не превращается в ACK. Строгий versioned JSON Schema и TG/MAX fixtures готовы.
169 PG + 42 envelope unit + 25 Python tests = 236 PASS; focused typecheck 64 файлов.
Новой миграции нет. [Проверки и границы](log026/README.md).

## Восьмая порция: владение обработкой receipts

LOG-027 добавил receipt-only claim/reclaim/renew/defer: policy/binding SHARE,
обязательная текущая авторизация, SKIP LOCKED, токен владения и время БД после
ожидания locks. Устаревший worker не меняет запись. Transition+audit атомарны,
unknown COMMIT/release не объявляется успехом. 225 PG + 42 unit + 25 Python tests
= 292 PASS; focused typecheck 66 файлов. [Проверки и границы](log027/README.md).
Нет пути applied через произвольный callback; blocked_config не выбирается
без отдельного проверенного wake-up. Scheduler пока не подключён.

## Девятая порция: native transaction и audit executor

LOG-028: структурный audit executor работает на исходном pg scope с проверкой
workspace и active lifecycle. Strict mode сохраняет upstream legacy default,
не подтверждает unknown COMMIT/ROLLBACK/release и закрывает retained scope.
Добавлены suppression wrapper и canonical key references по spec §15.10.
357 тестов прошли; typecheck comparison — 0 новых/0 в изменённых файлах,
122 baseline diagnostics сохранены. Dependency guard PASS после выделения leaf
types; исключения не добавлялись. [Проверки и ограничения](log028/README.md).
Настоящие metadata Message repositories этим шагом ещё не проверены.

## Следующая порция и незавершённая работа

1. Проверить actual metadata/repository integration и ownership/header collision
   guards; qualifier canonical key и immutable capture provenance для истории.
2. Атомарные Message/participants/link/revision/Conversation/identity/target/event,
   initial plans/receipts, event suppression и ownership guards; затем applied.
3. Config wake-up/recovery, inbox/outbox, email regression. Полномочия, lifecycle,
   HTTP/HMAC и qualification реальных коннекторов ещё впереди. Подробности в
   [этапе 1](../plan/phase_1_data.md) и [карте интеграции](integration-map.md).

T33 выполнен для текущей группы схемы; будущие миграции требуют своих повторов.
Полный server typecheck не выполнялся: официальный build использует SWC без
type checking. Работающая клиентская БД не обновлялась; проверен populated fixture.
Полная проверка runtime permissions/provisioning и audit ownership ещё впереди.
Session lock не является DB-side fencing после потери соединения; старый runtime
должен быть остановлен, при неизвестном исходе нужен разбор до ручного повтора.
Новая схема и writer в демо не выкачены. Приём/отправка и весь T01–T33 не завершены.
Bindings не активируются до собственных прав ROB-766. Никакие G01–G20 не выбраны
за пользователя этой командой начала разработки.

## Порядок проверок с LOG-026

По решению пользователя GitHub Actions не является gate. Наши два workflows
переведены в manual-only; проверки выполняются в собственной среде перед
commit/push. Исторические результаты CI не переписываются, но новых запусков
и ожидания Actions для обычной публикации нет. Настройки оплаты не менялись.

## LOG-029 — native Message persistence

LOG-029 / ROB-764 In Progress: штатные Message/Thread/participants сохраняются
с canonical Thread ID; audit скрывает содержимое и требует binding/conversation.
19 native PG сценариев проверяют Person relation, rollback, replay и tombstones.
Всего 379 тестов PASS; новых type diagnostics нет, 141 baseline расширенного
native графа остаётся. Четыре миграции прежние, dependency guard проходит.
[Доказательства и границы](log029/README.md).
Далее — trusted capture context, domain ownership и полный receipt apply с
Message+link+revision+event+audit, затем inbox/outbox/recovery. Full ingress
acceptance, scheduler/HTTP/own ACL/UI/живые каналы ещё не готовы. Демо прежнее.
GitHub Actions не используется.

## LOG-030 — trusted capture persistence

LOG-030 / ROB-764 In Progress: receipt сохраняет trusted capture context/hash,
с обязательной текущей авторизацией при приёме и replay. Изменённый context и
NULL↔qualified дают conflict; старые строки остаются неквалифицированными.
465 тестов PASS; новых ошибок типов нет (141 baseline, 106 roots).
Пятая миграция штатно сгенерирована; старые четыре неизменны. Native up/down/up,
apply/replay/readiness и итоговый zero-diff подтверждены, 256 history rows сохранены.
[Доказательства и границы](log030/README.md).
Далее — ownership guards APP/background и полный Message+link+revision+event+audit
apply, inbox/outbox/recovery. Полный ingress acceptance ещё не выполнен.
HTTP/own ACL/UI/живые коннекторы не подключены; демо прежнее. Actions не используется.

## LOG-031 — APP ownership gate

LOG-031 / ROB-764 In Progress: обычный APP ingestion теперь отказывает для
persisted omni-owned канала до identities/cache/aggregate. Все статусы binding
учитываются, ошибки SQL закрывают путь; обычный APP сохраняет прежнее поведение.
42 адресные проверки PASS (7 PG,10 service unit,25 guards); предыдущий полный
прогон LOG-030 —440 Jest+25 guards. Новых type diagnostics нет,155 baseline
расширенного APP graph сохраняется. Все5 миграций неизменны.
[Доказательства и границы](log031/README.md).
Далее — background rematch/target exclusions и полный domain receipt apply,
inbox/outbox/recovery. TOCTOU binding lifecycle и полный T05 ещё не закрыты.
HTTP/own ACL/UI/живые коннекторы не подключены; демо прежнее. Actions не используется.


## LOG-032 — фоновые participant/target paths

LOG-032 / ROB-764 In Progress: фоновое сопоставление участников и пересчёт
связанных CRM-записей исключают omni-owned Message/Thread до чтения и изменения
участников/targets. Проверяются binding, MessageLink и Conversation; обычные
email/APP и календарь сохранены. Полный набор:525 Jest +25 guards =550 PASS;
после двух исправлений только типов повторены68 затронутых тестов. Typecheck:
115 roots,0 новых/0 в изменённых файлах,136 baseline остаются. Все5 миграций прежние.
[Доказательства и границы](log032/README.md).
Далее — атомарное применение receipt в native Message, затем inbox/outbox/recovery.
Cleaner/delete/merge/generic CRUD и конкурентный lifecycle ещё не закрыты;
полный T05/ROB-764 не завершён. HTTP/own ACL/UI/живые коннекторы не подключены.
Демо прежнее; GitHub Actions не используется.


## LOG-033 — atomic history receipt apply

LOG-033 / ROB-764 In Progress: реальный atomic history receipt apply сохраняет
Message + participant с существующей Person, Link/Revision, DomainEvent,
suppressed root/dispatch, audit и applied receipt одной строгой транзакцией.
Поддержан qualified incoming complete text history_import, существующие
Conversation/Identity/Person, current generation и disabled policy v0; current
authorizer обязателен. Повторы/ошибки/unknown COMMIT проверены, автоэффектов нет.
558 Jest +25 guards =583 PASS; новые33 PG cases. Typecheck119roots:0 новых/
0 в изменённом коде;136 baseline, включая1 в неизменённом старом методе.
[Доказательства и границы](log033/README.md).
Следом — cleanup/lifecycle ownership guards, затем остальные domain apply,
inbox/outbox/recovery. Live/new-conversation/Person/edit/delete/admission и
полный T05/ROB-764 не закрыты. HTTP/own ACL/UI/живые коннекторы не подключены.
Демо прежнее; GitHub Actions не используется.


## LOG-034 — защита native cleanup

LOG-034 / ROB-764 In Progress: штатные cleanup, blocklist и удаление сообщений
папки сохраняют omni-owned Message/Thread/связи. Проверяются binding/link/
conversation, включая пустые диалоги и soft-deleted связи; обычная почта удаляется
со штатными FK-каскадами. Пагинация проходит защищённую страницу без зацикливания.
583 Jest +25 guards =608 PASS; новые25 PG, повторены25 после уточнения fixture.
Typecheck124roots:0 новых/0 changed-code,136 baseline; все5 миграций прежние.
[Доказательства и границы](log034/README.md).
Далее — защита metadata lifecycle аккаунтов/каналов/папок до внешних эффектов,
затем остальные domain apply, inbox/outbox/recovery. Lifecycle races и полный
T05/ROB-764 ещё не закрыты. HTTP/own ACL/UI/живые коннекторы не подключены.
Демо прежнее; GitHub Actions не используется.
