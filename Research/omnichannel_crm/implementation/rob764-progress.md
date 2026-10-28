# ROB-764 — журнал реализации

Актуальная сводка — [STATUS](../STATUS.md); ниже порции перечислены по времени.
Фразы «следующая порция» внутри исторических записей относятся к их дате, а не
отменяют результаты более поздних LOG. Текущее продолжение указано в конце журнала.

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

## План продолжения после LOG-028 — историческая запись

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


## LOG-035 — metadata lifecycle preflight

LOG-035 / ROB-764 In Progress: native metadata lifecycle проверяет владение до
hooks/отзыва токенов/удаления подписок, DB update/delete и событий. Защищены
аккаунты, каналы, reset до cache и folder actions до import/cleanup/удаления папки.
Прямая binding и косвенные связи учитываются; обычные соседние папки сохранены.
667 Jest полного прогона + финальные86 focused (2 новых) +25 guards:
694 distinct PASS. Typecheck133roots:0 новых/0 changed-code,149→146 baseline.
Все5 миграций прежние. [Доказательства и границы](log035/README.md).
Далее — первый Conversation/Thread при receipt apply, затем config recovery и
остальные inbox/outbox пути. Проверки lifecycle point-in-time; гонки владения,
generic/raw CRUD и полный T05/ROB-764 ещё открыты. HTTP/own ACL/UI/живые коннекторы
не подключены. Демо прежнее; GitHub Actions не используется.


## LOG-036 — первое history-сообщение

LOG-036 / ROB-764 In Progress: первое qualified history-сообщение атомарно
создаёт Conversation/Thread по действующим default queue/human mode и существующим
verified Identity/Person. Параллельные receipts сходятся в одном диалоге;
conversation.created и message.received имеют отдельные suppressed roots/events.
Подтверждается фактическое создание native Thread, rollback и replay проверены.
Нет подходящей конфигурации — тот же receipt переводится в blocked_config после
подтверждённого rollback; неизвестный COMMIT не превращается в retry/успех.
701 Jest/29 suites +25 guards =726 PASS. Typecheck136roots:0 новых/0 changed-code,
146 baseline/current; все5 миграций прежние. [Доказательства и границы](log036/README.md).
Далее — bounded восстановление blocked_config, затем config producer/consumer,
остальные inbox/outbox пути. HTTP/own ACL/UI/живые коннекторы не подключены;
полные ROB-764/T05 и lifecycle races ещё открыты. Демо прежнее, Actions не используется.


## LOG-037 — восстановление blocked history

LOG-037 / ROB-764 In Progress: typed bounded resume возвращает qualified history
blocked_config/configuration_missing в retryable_error с прежним receipt и capture.
Текущие права/config/generation проверяются; existing Conversation сохраняет собственную
очередь независимо от defaults. Точный DB cursor, full-page progress и SKIP LOCKED
проверены; новый проход без cursor подбирает пропуски. Аудит атомарен, unknown COMMIT
не объявляется успехом. Реальная цепочка repair→resume→claim→apply проверена.
745 distinct Jest (полный прогон744/745 + исправленный focused44) +25 guards =770 PASS.
Typecheck140roots:0 новых/0 changed-code,
146 baseline/current; все5 миграций прежние. [Доказательства и границы](log037/README.md).
Далее — настоящий config writer и durable binding.config_changed, затем typed
consumer/housekeeping и остальные inbox/outbox пути. Полный recovery pipeline,
ROB-764/T05, own ACL/UI/HTTP и живые коннекторы ещё не готовы. Демо прежнее,
GitHub Actions не используется.


## LOG-038 — config writer и binding event

LOG-038 / ROB-764 In Progress: config writer создаёт/изменяет очереди и human
defaults binding с current authorization, CAS и общим idempotency receipt.
Policy UPDATE с начала; resource revision/epoch, durable binding.config_changed,
audit и receipt атомарны. No-op не выпускает event; replay повторно проверяет права.
Default/retained queue нельзя отключить, existing Conversations не переносятся.
Actual writer→resume→claim→apply проверен; binding activation остаётся test-only.
826 Jest полного прогона + финальные84 focused (3 новых) +25 guards =854 distinct PASS.
Typecheck145roots:0 новых/0 changed-code,146 baseline/current;5 миграций прежние.
[Доказательства и границы](log038/README.md). Далее — typed event consumer и durable recovery/
housekeeping, затем остальные inbox/outbox пути. ROB-764/T05, own ACL/UI/HTTP и живые
коннекторы ещё не готовы. Демо прежнее, GitHub Actions не используется.


## LOG-039 — durable config wakeup

LOG-039 / ROB-764 In Progress: config events получают отдельный durable wakeup.
Typed claim/page/reconciliation/rearm сохраняют checkpoint и текущую авторизацию;
receipt transitions, audit и финальный lease CAS атомарны. Exact DB cursor,
SKIP LOCKED rescan, generation reset, inactive/unknown handler и lost COMMIT ACK
проверены. Producer создаёт event+wakeup в одном commit; replay/no-op без дублей.
Шестая миграция сгенерирована Twenty, native up/down/up проверен; прежние5 неизменны.
890 Jest/35 suites +26 guards =916 PASS; targeted204 PASS. Typecheck152roots:
146 baseline/current,0 новых/0 changed-code. [Доказательства и границы](log039/README.md).
Далее — strict runtime owner и bounded housekeeping, затем остальные inbox/outbox
пути. Scheduler/current production grants, полные ROB-764/T05, own ACL/UI/HTTP и
живые коннекторы ещё не готовы. Демо прежнее, GitHub Actions не используется.


## LOG-040 — strict recovery owner

LOG-040 / ROB-764 In Progress: recovery связан с существующим strict native
transaction owner. Пять закрытых команд, snapshot до await, свежие grants;
failed/denied audit только после подтверждённого rollback, unknown ACK без false failure.
Housekeeping возвращает один последний завершённый проход для поздних blocked
receipts. Реальный accepted→blocked→repair→wakeup→claim/apply→Message+Person проверен,
включая defer после завершения config event. 226 Jest/11 затронутых suites +26 guards
=252 PASS; финальные21 unit повторены после исправления test typing. Typecheck155roots:
146 baseline/current,0 новых/0 changed-code; одна baseline ошибка в неизменённом
старом методе. Все6 миграций и прежние методы aggregate неизменны.
[Доказательства и границы](log040/README.md). Далее — human command admission и исходящая очередь.
Scheduler/current production grants, полные ROB-764/T05, own ACL/UI/HTTP и живые
коннекторы ещё не готовы. Демо прежнее, GitHub Actions не используется.

## LOG-041 — human text command admission

LOG-041 / ROB-764 In Progress: приём human text command атомарно сохраняет
pending Command, три счётчика Conversation, suppressed event/root/dispatch и аудит.
Текущие native member/user/workspace и grants проверяются также при replay; key
общий для actor/workspace, UI CAS применяется к новому намерению. Проверены
конкурентные ключи, реальный revoke lock, rollback каждого write и lost COMMIT ACK.
Полный fork suite: 1025 Jest /41 suites +26 guards =1051 PASS; 97 новых cases.
Typecheck162roots:146 baseline/current,0 новых/0 changed-code. Все6 миграций и
прежние методы aggregate неизменны. [Доказательства и границы](log041/README.md).
Далее — outbox claim/FIFO и восстановление попыток. Writer пока text-only/v0,
с injected current grants; HTTP/UI, transport, scheduler и own ACL ещё впереди.
Полные ROB-764/T05 не закрыты. Демо прежнее, GitHub Actions не используется.

## LOG-042 — human outbox lease

LOG-042 / ROB-764 In Progress: human outbox claim/FIFO/recovery реализован.
First attempt проверяет автора и текущий маршрут; исторический reconcile использует
отдельные worker grants и не разрешает повторную отправку. UUID lease, DB expiry,
statusRevision и audit атомарны; final CAS после аудита, unknown ACK без false failure.
194 Jest /10 затронутых suites +26 guards =220 PASS, включая32 новых PG cases.
Typecheck170roots:146 baseline/current,0 новых/0 changed-code; все6 миграций и старые
методы aggregate неизменны. Полный1025 suite прошёл в LOG041.
[Доказательства и границы](log042/README.md). FIFO пока bounded100 с явным отказом сверх лимита;
qualification/verifier injected, без production implementation. Далее — verified
connector acceptance reducer. HTTP/UI, transport, scheduler/own ACL и полный
ROB-764 ещё не готовы. Демо прежнее, GitHub Actions не используется.


## LOG-043 — verified connector acceptance

LOG-043 / ROB-764 In Progress: внутренний verified connector acceptance реализован.
Current worker grant и qualified evidence обязательны также при replay. Новый
факт атомарно сохраняет proof/job/journal, меняет state/revision, снимает lease
и пишет audit; duplicate сохраняет новый reconcile lease. Historical ACK разрешён
без нового send; outcome_unknown не превращается в доставленное сообщение.
FIFO пропускает только строго сопоставленные proofs; неизвестные остаются bounded100.
285 Jest /14 затронутых suites +26 guards =311 PASS;91 новый case, включая53 PG.
Typecheck177roots:146 baseline/current,0 новых/0 changed-code; все6 миграций и
старые методы aggregate неизменны. Полный1025 suite прошёл в LOG041.
[Доказательства и границы](log043/README.md). Проверены151 подтверждённый predecessor,
23 malformed JS/SQL parity cases, rollback/lost ACK. Это внутренний server-owned
proof, не готовый протокол userbot. Далее — confirmed sent и штатный Message.
HTTP/UI, live transport, scheduler/own ACL и полный ROB-764 ещё не готовы.
Демо прежнее, GitHub Actions не используется.


## LOG-044 — durable sent receipt

LOG-044 / ROB-764 In Progress: durable command.sent receipt accept/claim реализованы.
Закрытые envelope/capture сохраняются в существующем IncomingReceipt; current
worker grant и qualified historical verifier обязательны при capture/replay/claim.
Command/native graph пока не меняются. DB lease/token/expiry и audit атомарны,
postcondition после audit защищает от подмены; lost COMMIT ACK без false failure.
Обычный incoming claim/renew/defer исключает command.sent, сохраняя три message kinds.
487 Jest /18 затронутых suites +26 guards =513 PASS. Typecheck184roots:
146 baseline/current,0 новых/0 changed-code; все6 миграций и старые методы aggregate
неизменны. Полный1025 suite прошёл в LOG041.
[Доказательства и границы](log044/README.md). Исторический ACK не даёт нового send;
partial прежний acceptance не исправляется при capture. Далее — LOG045:
атомарный confirmed sent → штатные Message/Participant/Link/revision/event.
HTTP/UI, transport, scheduler/own ACL и полный ROB-764 ещё не готовы.
Демо прежнее, GitHub Actions не используется.

## LOG-045 — 27.10.2026: исходящее сообщение по подтверждённой отправке

LOG-045 / ROB-764 In Progress: подтверждённая отправка атомарно становится штатным
исходящим Message. Сохраняются Participant, channel association, MessageLink/revision,
один suppressed message.sent event/root/dispatch, Command sent, receipt applied и audit.
Повторы проверяют весь граф; несколько receipts одной отправки не создают дубль.
Удаление автора сохраняет историю; имя/email не выдумываются. Current worker grant
и qualified historical verifier обязательны. Собственный send не увеличивает
replyRevision повторно и не запускает AI/workflow/customer admission.
Полный fork suite: 1368 Jest /57 suites +26 guards =1394 PASS.
Typecheck191roots:146 baseline/current,0 новых/0 changed-code;
все6 миграций и старые методы aggregate неизменны.
[Доказательства и границы](log045/README.md). Проверены55 новых PG-сценариев, в том числе
fault injection, expiry после audit, concurrent replay и lost COMMIT ACK.
Далее — сохранение неопределённого исхода, backoff и поиск due Commands в PostgreSQL.
HTTP/UI, transport, scheduler/own ACL и полный ROB-764 ещё не готовы.
Демо прежнее, GitHub Actions не используется.

Ревью исправило лишнее поле при проверке channel association и запрещает скрытое
создание графа у Command, уже отмеченной sent. Проверки после audit/final CAS
находят подмену native/core данных. Typecheck выявил unknown SQL rows; добавлена
runtime-проверка структуры без any/casts. Финальные проверки повторены после правки.
Общий participant helper допускает NULL только на persistence boundary; email input
контракт сохранён и проверен. Применены ai-dev-workflow, behavioral-guardrails,
server-schrodinger; scoped independent review без блокеров, полный Claude pass
не повторялся. Продолжаем LOG046, ROB-764 остаётся In Progress.

## LOG-046 — 27.10.2026: неизвестный исход и PostgreSQL recovery

LOG-046 / ROB-764 In Progress: recovery human text/v0 сохраняет outcome_unknown,
DB backoff, revision и audit атомарно. Только текущие worker grants/qualification,
точный действующий lease и captured restore incarnation допускают изменение.
Acceptance/job/journal/cancellation/payload сохраняются; sent не понижается.
Terminal/pending/superseded/expired/restore-changed дают no-op после current auth.
Discovery читает due candidates из PostgreSQL с точным курсором, не выдаёт send
permission; каждый завершённый scan начинается заново.
392 Jest /14 затронутых suites +26 guards =418 PASS;
67 новых случаев, включая33 PG. Typecheck197roots:
146 baseline/current,0 новых/0 changed-code. Все6 миграций и прежние методы
aggregate неизменны; полный1368 fork suite прошёл в LOG045.
[Доказательства и границы](log046/README.md). Проверены ACK/sent races, lost COMMIT ACK,
audit/backoff/lease expiry, AFTER UPDATE tamper, другое существующее подключение.
Далее — оставшиеся критерии outbox/state machine по этапу1; текущий slice не
закрывает ROB-764 целиком. HTTP/UI, live transport, scheduler/own ACL ещё впереди.
Демо прежнее, GitHub Actions не используется.

Независимое review выявило истёкший во время audit backoff и недостаточность одного
UPDATE RETURNING при AFTER UPDATE triggers. Оба случая исправлены и воспроизведены
на PostgreSQL. Первый общий прогон нашёл ошибочный индекс аргумента в двух новых
owner-тестах; исправлено, финальные affected tests/typecheck повторены. Существующий
чужой binding проверен отдельно; mutation входа/callbacks проверена до context await.
Применены ai-dev-workflow, behavioral-guardrails, server-schrodinger. Scoped review
без runtime-блокеров; полный Claude pass не повторялся. Текущая queue discovery
не включает cron и не обещает ограниченной стоимости SQL при любом размере workspace.

## LOG-047 — 27.10.2026: версия восстановления при создании Command

LOG-047 / ROB-764 In Progress: Command хранит immutable createdRestoreIncarnation.
Admission берёт её из policy под lock; первый claim требует совпадения с текущей.
NULL/старая incarnation запрещают новую отправку, replay не переписывает provenance.
Историческая сверка dispatching/accepted/outcome_unknown сохраняется, включая NULL.
Седьмая миграция additive, без default/backfill; первые6 источников неизменны.
Полный fork suite: 1460 Jest /61 suites +26 guards =
1486 PASS. Typecheck 200 roots:
146 baseline/current,0 новых/0 changed-code.
[Доказательства и границы](log047/README.md). PostgreSQL проверяет upgrade populated prefix6,
schema drift, auth/replay, policy locks и audit/AFTER UPDATE tamper.
Независимое scoped review без блокеров; полный Claude pass не повторялся.
Далее — локальная отмена ещё не переданной команды и общий native mutation guard.
ROB-764 не закрыт; restore coordinator/provider fence, HTTP/UI/ACL/transport ещё впереди.
Демо прежнее, GitHub Actions не используется.

Начальный негативный тест выявил, что TypeORM не показывает UUID generator как
column.default. Новый verifier дополнен прямой pg_attrdef проверкой отсутствия
default; старые migrations/snapshots не переписаны. Review предложил historical
NULL cases; добавлены, как и policy lock вокруг claim и tamper при audit.
Матрица приёмки отделяет собственные writers/guards от ROB-765/766/768/769/770.
Краткие пункты5–6 этапа1 приведены к нормативным владельцам T14/T16, требования
автоматизации не удалены. Применены ai-dev-workflow, behavioral-guardrails,
server-schrodinger; независимый scoped reviewer работал read-only.

## LOG-048 — 27.10.2026: локальная отмена до enqueue

LOG-048 / ROB-764 In Progress: локальная отмена human text/v0 атомарно сохраняет
cancelled/revision2, DB timestamp, закрытое доказательство и один audit. Допускается
только virgin pending с текущей creation incarnation. Текущие membership/read и
отдельный delegated grant для неавтора обязательны также на replay. Автор Command
сохраняется; отменивший сотрудник записывается отдельно. FIFO пропускает только
нормализованный local proof; remote/unknown outcome локально не отменяется.
370 Jest /14 suites +26 guards =396 PASS;
44 новых случая (34 PostgreSQL,10 owner), typecheck 205 roots:
146 baseline/current,0 новых/0 changed-code. Все7 миграций и прежние методы aggregate
неизменны; полный1460 fork suite прошёл в LOG047.
[Доказательства и границы](log048/README.md). Проверены claim/cancel race, lost COMMIT ACK,
current/delegated revoke, отсутствие audit, malformed proof/FIFO, >100 отменённых
предшественников, audit/AFTER UPDATE tamper и JS/SQL parity.
Далее — общий native mutation guard по T05/T22. ROB-764 не закрыт; публичный API,
UI, transport cancellation, собственный ACL и автоматизация ещё впереди.
Демо прежнее, GitHub Actions не используется.

Scoped independent review не нашёл blockers; его рекомендации о delegated revoke,
проверке сохранённого audit и malformed proof/FIFO добавлены в реальный PG набор.
Первый прогон обнаружил некорректный fixture lease без leaseUntil; fixture исправлен.
Typecheck выявил вызов optional delegated callback без narrowing в owner test;
исправлено и затронутые проверки повторены. Полный Claude pass не повторялся.
Применены ai-dev-workflow, behavioral-guardrails, server-schrodinger. Транспорт,
HTTP и UI не менялись. Следующий шаг: common native write boundary; фазовая
принадлежность ROB-764 подтверждена spec §15.1, а не перенесена в будущий ACL.

## LOG-049 — 27.10.2026: общий native mutation boundary

LOG-049 / ROB-764 In Progress: общий native ORM запрещает CRUD/merge/batch
для omni-owned Message, Thread, Participant, Association, FolderAssociation и Target.
Проверяются сохранённые и новые родители; bypass/skipEvents не дают разрешения.
Доменный writer получает capability только на выданный активный strict scope,
тот же executor/workspace/repository и exclusive ownership fence. Все workspace
transactions берут shared fence до row locks; bootstrap/history/sent — exclusive.
Полный прогон: 1578 Jest /64 suites, 1567 PASS и 11 ошибок старого reconciliation
fixture. После исправления только подготовки данных весь затронутый suite:
18/18 PASS. Production source между прогонами неизменен, хеши сверены.
74 новых PostgreSQL случая; 20 dependency +6 checksum tests PASS.
Typecheck 208 roots: 146 baseline/current,0 новых/0 changed-code diagnostics.
[Доказательства и границы](log049/README.md). Миграции не менялись.
Далее — защита удаления CRM-родителей и проверка каскадных действий БД (T05/T22).
ROB-764 не закрыт; публичный API, UI, собственный ACL и автоматизация ещё впереди.
Демо прежнее, GitHub Actions не используется.

Два независимых scoped read-only review выявили необходимость раннего shared
fence, группировки OR с captured IDs и проверки обоих родителей folder junction.
Исправления включены, конкурентные и пять folder regression cases проходят.
Начальные fixture ошибки (enum/target field/owner DB role) исправлены; старые
cleanup/reconciliation fixtures создают protected graph через выданный typed
scope, сами проверяемые cleaner/rematch продолжают работать без capability.
Новый QueryExecutor type import нарушал dependency boundary; заменён opaque
object identity. Отдельная baseline ошибка TypeScript в прежнем aggregate method
не изменилась; в aggregate изменены только две опции ownership lock.
Полный Claude review не повторялся. Применены ai-dev-workflow,
behavioral-guardrails, server-schrodinger. Следующий шаг — parent hard-delete
guard, core retained references и trash cleanup без starvation; own ACL/audit
расширение не объявляется завершённым по этому guard.

## LOG-050 — 27.10.2026: защита родителей и очистка корзины

LOG-050 / ROB-764 In Progress: generic hard-delete защищает retained core targets,
ExternalIdentity и native references Person/Company/Opportunity/MessageCampaign.
Проверка выполняется под ownership fence и parent row locks, независимо от bypass,
skipEvents и native capability. Обычные email FK и WorkspaceMember SET NULL сохранены.
Корзина пропускает protected records, двигает точный PostgreSQL (deletedAt,id) cursor
и повторно проверяет retention после lock; concurrent restore не удаляется.
Полный набор: 1604 Jest /65 suites +26 guards =
1630 PASS; 26 новых PostgreSQL случаев. Typecheck 211 roots:
146 baseline/current,0 новых/0 changed-code. Все7 migrations неизменны.
[Доказательства и границы](log050/README.md). Scoped independent review: замечание о
микросекундах исправлено и проверено. Полный Claude pass не повторялся.
Далее — запрет workspace deletion до первого side effect и гонки metadata/first bootstrap.
ROB-764 не закрыт; разрешённый domain destroy, публичный API, ACL и UI ещё впереди.
Демо прежнее, GitHub Actions не используется.

Первый targeted прогон дал 211 PASS и одну ошибку подготовки WorkspaceMember:
не задан обязательный userId. Typecheck выявил sync callback fixture.withContext.
Оба test fixture исправлены. Independent review нашёл потерю микросекунд pg Date
в trash cursor; теперь берём deletedAt::text из той же выборки. Полная страница1000
protected records с ...000123Z, следующий ordinary record, одинаковые даты и
concurrent restore проверены. Native ownership finder общий для assert и partition;
нет отдельной ослабленной копии правил для очистки.
Dependency guard отклонил новый import getWorkspaceContext в TrashCleanup;
metadataId теперь берётся из уже загруженного flat metadata, baseline не меняли.
Финальный full suite и focused typecheck на неизменном source успешны.
Применены ai-dev-workflow, behavioral-guardrails, server-schrodinger. Review
следующего T22 inventory подтвердил workspace DROP SCHEMA перед поздним core FK
RESTRICT и гонку metadata check/write с первым bootstrap; эти пути ещё не закрыты.
Нельзя считать ни ROB-764, ни полный аудит/ACL готовыми. Исправлена неточность
матрицы приёмки: identity/Person relation уже есть, explicit target projector ещё нет.

## LOG-051 — 28.10.2026: защита удаления рабочей области

LOG-051 / ROB-764 In Progress: WorkspaceService отказывает при retained omni данных
до membership/uninstall/schema/file effects. Короткая транзакция сохраняет deletedAt
под ownership fence; bootstrap проверяет эту отметку до первого INSERT. Direct DROP
SCHEMA требует ту же проверку и ранее сохранённую отметку удаления. Повтор сохраняет
дату, ошибки очистки не возвращают область в активное состояние.
Полный набор: 1635 Jest /67 suites +26 guards =
1661 PASS; 18 новых PostgreSQL и 13 owner-level случаев. Typecheck
216 roots: 162 baseline/current, 0 новых/0 changed-code. Все7 migrations неизменны.
[Доказательства и границы](log051/README.md). Scoped independent review: blockers не найдены;
полный Claude pass не повторялся. Далее — metadata check/write против first bootstrap
и итоговый T22 inventory. ROB-764 не закрыт; controlled purge, публичный API, ACL и UI
ещё впереди. Демо прежнее, GitHub Actions не используется.

Первый targeted запуск: 113 PASS, 7 FAIL. Причина подтверждена в текущем
PostgresQueryRunner: UPDATE RETURNING возвращает [rows, affected], а не rows.
Исправлена обработка результата с проверкой affected=1; финальные проверки успешны.
Для owner tests изолированы unrelated DI/AI ESM imports, реальные методы
WorkspaceService/WorkspaceSchemaService/DestroySoftDeletedWorkspaceJob исполнены.
Scoped review предложил сохранить исходный unknown outcome при ошибке cache:
теперь AggregateError сохраняет обе причины, дальнейшая очистка не начинается.
Проверены оба порядка bootstrap/delete на PostgreSQL, immutable deletedAt retry,
недоступность retained catalog, потеря COMMIT ACK, уничтожение соединения после
неподтверждённого rollback, direct schema DROP, billing/hook/cache failures.
Применены ai-dev-workflow, behavioral-guardrails, server-schrodinger. Живой экземпляр
и коннекторы не менялись; отдельный стенд — только уже существующая isolated CI-среда.
Оставшийся риск metadata check/write подтверждён по коду. archivedAt не подходит как
самостоятельная необратимая резервация: штатный reconnect его снимает. Следующая
порция закроет чистые DB mutations, затем network lifecycle без длинной transaction.

## LOG-052 — 28.10.2026: атомарные изменения metadata

LOG-052 / ROB-764 In Progress: чистые DB mutations ConnectedAccount.update,
MessageChannel.create/update/delete и APP channel create/update/delete выполняют
ownership check и запись в одной READ COMMITTED transaction под shared native fence.
Account locks предшествуют channel lock; parent и APP permissions читаются заново.
Create relation objects запрещены, delete event публикуется только после commit.
Проверено 244 targeted Jest /9 suites +26 guards =270 PASS, 29 новых PostgreSQL
случаев; typecheck219 roots:162 baseline/current,0 новых/changed-code. Все7 migrations
неизменны. Полный1635-test прогон LOG051 относится к предыдущему снимку; здесь не повторялся.
[Доказательства и границы](log052/README.md). Independent review выявил различимые APP ошибки:
исправлено и проверено. Полный Claude pass не повторялся.
Далее network lifecycle/reconnect, resolver side effects и итоговый T22 inventory.
ROB-764 остаётся In Progress; публичные API, ACL, UI и транспорт ещё впереди.
Демо прежнее, GitHub Actions не используется.

Первый новый PG run:66 PASS/2 FAIL из-за отсутствующего UUID DEFAULT в test core table.
Fixture приведён к native id generation. Первичная typecheck нашла только union
Promise в test capture; helper теперь принимает Promise<unknown>. Review обнаружил
разные APP create ошибки для missing и чужого account: typed missing-parent error
нормализуется в прежний ownershipViolation; paired PG test проверяет missing,
foreign-workspace и foreign-app одинаково. Postcommit observation, lost ACK и SQL
permission failure проверены. 44 старых owner tests адаптированы к transaction
manager; ownership assertions сохранены. Baseline dependencies не ослаблены.
Оставшиеся подтверждённые границы: network hooks/revoke нельзя завернуть в длинную
transaction; archivedAt снимается reconnect и не является irreversible reservation.
Generic resolver до update отдельно меняет pendingGroupEmailsAction. APP-only
bootstrap + immutable provider identity рассматривается для следующего contract
уточнения вместе со stale reconnect guards; пока не реализовано/не объявлено готовым.
Применены ai-dev-workflow, behavioral-guardrails, server-schrodinger. Affected tests
выбраны по metadata/bootstrap/native guard зависимостям; полный предыдущий suite
не выдаётся за полный прогон текущего снимка. Демо/коннекторы не менялись.


Дополнительная проверка до публикации: фактический TypeORM0.3.31 EntityManager.transaction
глотает rollback error и возвращает connection через release. Для новых locks это
могло оставить открытый transaction в pool. Проверенный LOG051 owner вынесен в общий
omni-core-transaction; metadata использует свежий QueryRunner и runner.manager,
workspace wrapper сохраняет прежний UnknownError. READ COMMITTED явный, commit/release
unknown типизирован, rollback failure агрегирует причины и уничтожает connection.
Новый PG case подтверждает освобождение account lock запросом второго connection;
lost ACK не вызывает success event. Extraction отдельно просмотрена, blockers не найдены.
Финальный affected run244/9 +26 guards=270 PASS; typecheck219 roots162/162,0new/changed.


## LOG-053 — provider identity, reconnect и старые привязки (28.10.2026)

Пути записи провайдеров разделяют создание и повторную авторизацию: Google/
Microsoft и IMAP используют INSERT для нового id, conditional UPDATE для прежнего.
SSO/token refresh/aliases сравнивают полный identity/custodian. APP OAuth сохраняет
shared reconnect и external account pinning; SQL одновременно проверяет текущую
доступность caller и принадлежность приложению/provider. Incomplete identity,
affected!=1 и unreadable binding storage дают ошибку без fallback/upsert.
Native APP не попадает в ordinary refresh/alias drivers. Immutable generic identity
и APP-only bootstrap дополняются retained-binding исключением для старых данных.

279 Jest /9 suites +26 guards=305 PASS;39 новых PG owner cases,
10 identity/bootstrap cases. Один прежний APP applicationId mutation-race case
заменён проверками запрета такого изменения; scope/custodian race cases сохранены.
Typecheck230 roots:198/197,0new/changed; migration hashes неизменны.
Начальные проверки нашли неверный регистр provider и старую fixture без поля,
review/typecheck — лишние account поля в channel UPDATE; исправлено. Review выявил
legacy provider binding, добавлены NOT EXISTS и реальные PG cases. Новый импорт
shared types barrel отвергнут dependency guard; структурный helper сохраняет тип
provider вызывающего кода, не импортируя Enterprise-reaching barrel. Pre-existing
IMAP catch error?.message заменён корректным narrowing; новая диагностическая
ошибка не скрыта исключением из typecheck. Финальный scoped review без blockers.

[Evidence](log053/README.md). Полный ROB-764 и full server typecheck не завершены.
Далее disconnect/transfer/deleteMany под актуальной ownership проверкой, resolver
pendingGroupEmailsAction и T22 inventory. ACL/UI/transport остаются в своих этапах.
Демо, SaleBot, Telegram/MAX не менялись; GitHub Actions не использовался.
Skills: ранее применённые ai-dev-workflow (bounded independent read-only review),
behavioral-guardrails и server-schrodinger; новые skills не заявляются.


## LOG-054 — account lifecycle final DB ownership (28.10.2026)

Disconnect/transfer/deleteMany используют strict fresh transaction owner LOG052:
shared native fence → ordered account FOR UPDATE → persisted ownership → final DB
mutation. Native APP/null-ID не вызывает обычных provider adapters. Ordinary hooks
остаются вне transaction, проверена reentry в metadata без deadlock. Transfer
сверяет from custodian и affected count; ошибка откатывает весь DB batch. Delete
собирает актуальные child IDs после hooks; channel/calendar rows FOR UPDATE
удерживаются до cascade DELETE. Events только после подтверждённого commit.

224 tests/7 suites +26 guards=250 PASS.25 новых PG cases:
оба порядка bootstrap/lifecycle, native/ordinary/legacy/mixed behavior, rollback,
custodian race, hook reentry, reparent/create child во время hooks, actual calendar
concurrent reparent, second-connection postcommit visibility, lost ACK no success.
Typecheck230 roots:197/197,0new/changed-code;7 migration sources unchanged.
Initial6 failures были test interception: first QueryRunner принадлежал чтению до
transaction. Test barriers теперь ловят реальную active transaction; fault injection
действительно достигает final DB writer. Review нашёл calendar reparent после
SELECT — добавлены child locks и оба порядка actual-owner PG regression.

[Evidence](log054/README.md). Whole ROB-764 не закрыт. Остались
[background metadata writers](rob764-metadata-writer-inventory.md) и resolver side
effects; существующие ordinary remote actions не становятся транзакционными.
Network effect уже мог выполниться до локального отказа: не повторять автоматически.
Полный Claude pass/full server typecheck не заявляются. Демо/SaleBot/transports без
изменений, GitHub Actions не использовался. Применены прежние ai-dev-workflow,
behavioral-guardrails/server-schrodinger; scoped independent review read-only.


## LOG-055 — webhook final write ownership (28.10.2026)

Claim/settle/clear/markActive/Failed/Expired/reset для message/calendar используют
strict fresh transaction: shared fence → account/share + channel/update lock →
полная ownership проверка → same-manager update. Native APP/null IDs отклоняется
даже без binding. Retained legacy provider и derived account ownership защищены.
Workspace передаётся из всех callers; прежние claim/clientState/subscription CAS
сохранены. Из snapshot передаётся expectedConnectedAccountId: reparent до claim
не вызывает HTTP, reparent во время HTTP не записывает результат прежнего account.

Provider HTTP остаётся вне SQL transaction. Renew/delete сохраняют локальный
результат вне provider catch: потерянный commit ACK не запускает FAILED/recovery
и не выдаёт ложных success/failure metrics. Existing create orphan-watch cleanup
сохранён; автоматического повторного provider запроса не добавлено.

278 tests/6 suites +26 guards=304 PASS.
85 новых PostgreSQL cases: ordinary/native/legacy, missing/wrong workspace, claim
concurrency/CAS, denied ownership read, lock acquisition reparent, actual create/
renew/delete late callbacks, preclaim reparent и real commit-ACK loss. Driver HTTP
подменён; локальные services/repositories/locks/PostgreSQL реальные.
Typecheck236 roots:197/197,0 new/changed-code.7 migration sources unchanged.
Первый запуск нового набора упал на загрузке unrelated AI ESM через driver factory;
fixture теперь подменяет factory, сами проверяемые services остаются реальными.
Scoped review нашёл unknown-commit recovery и ordinary reparent; оба исправлены,
повторный scoped review без блокеров. Full Claude/full server typecheck не заявлены.

[Evidence](log055/README.md). Остались [sync/cursor/folder owners](rob764-metadata-writer-inventory.md),
resolver atomicity и итоговый T22/ROB764 acceptance. External effect может уже
состояться до локального отказа; SQL rollback его не отменяет. Демо не менялось.
GitHub Actions не использовался. Прежние skills ai-dev-workflow,
behavioral-guardrails/server-schrodinger; independent scoped review read-only.


## LOG-056 — atomic ordinary sync-status batches (28.10.2026)

Новый batch owner фиксирует input IDs до await, берёт shared ownership fence,
все account locks по sorted IDs, затем все channel locks; повторно читает parents
и полную ownership. Native APP/null IDs, retained/derived owned accounts и
reparented rows исключаются. AuthFailed сразу берёт account FOR UPDATE, без
SHARE→UPDATE upgrade. Реально изменённые rows определяют postcommit effects.

Message reset объединяет channel stage/cursor/throttle и ordinary folder reset
через withManager; folders дополнительно блокируются и проверяются по ownership.
Message/calendar authentication failure обновляет account и channel атомарно.
Cache, metrics, broadcast и reconnect используют только committed accepted IDs;
recipient/account берутся из locked snapshot, не из позднего чтения нового parent.
Microsoft reconnect reset вынесен за persistence transaction и получает channel IDs.

Ревью обнаружило local unknown COMMIT → import recovery и stale account authFailure.
Оба исправлены: ранний rethrow в handlers и messaging catch до setAdd; captured
account ID в credential/certificate failure. Новые66 PG cases включают actual import
owners lost ACK, actual handlers stale parent, mixed/native/legacy/derived owners,
parallel reversed batches, SQL rollback, folder reset, conditional scheduling,
input snapshot, tenant mismatch и unreadable ownership.7 старых mock reset cases
заменены PostgreSQL проверками. Microsoft existing caller regression проверяет
committed account/channel state во время reset и настоящий channel ID.

Affected 332 tests/7 suites; full fork 1881/71 +26 guards=1907 PASS.
Typecheck242 roots:197/191,0 new/changed-code;7 migration sources unchanged.
Initial fixture failures: unrelated AI import, missing folder table/archivedAt;
исправлены fixture boundary/schema. Type pass потребовал нормализовать unknown
exception и убрать union-repository enum ambiguity в тесте. Полный server typecheck
и полный Claude review не заявляются. Scoped re-review без новых блокеров.

[Evidence](log056/README.md). [Inventory](rob764-metadata-writer-inventory.md) сохраняет
оставшиеся group/resolver/cursor/throttle/folder writers. Это не атомарность всех
старых внешних side effects, не закрытие ROB764 и не транспорт. Демо/SaleBot прежние.
GitHub Actions не использовался; skills ai-dev-workflow, behavioral-guardrails,
server-schrodinger, независимое scoped review read-only.


## LOG-057 — cursor final writes and atomic channel settings (28.10.2026)

MessagingCursorService фиксирует channel/parent/cursor/folder до await. Existing
single-channel owner блокирует account/channel и исключает fresh native ownership.
Numeric cursor сравнивается с текущей DB строкой, поэтому stale input не откатывает
его назад. Folder write проверяет exact parent, блокирует folder и проверяет полную
ownership; channel throttle/stage reset использует тот же manager и rollback.

Resolver сохраняет раннюю авторизацию, затем передаёт settingsCaller в metadata
update. Под блокировкой повторяются current parent/type/busy проверки и существующая
isAdministrableByCaller по актуальным scope/custodian/provider. Настройка и derived
pendingGroupEmailsAction пишутся одним UPDATE. EMAIL_GROUP/PENDING_CONFIGURATION/
unchanged-value semantics сохранены. Неиспользуемый standalone marker удалён.

Review нашёл same-account custodian/scope race; исправлен final authorization по
locked account, реальные отрицательные PG кейсы добавлены. Scoped re-review без
новых блокеров. Это не собственный ACL и не глобальная блокировка изменений ролей
(ROB766). Worker cleanup/finalizers ещё остаются в inventory.

Проверки: 203 targeted Jest/6 suites +26 guards = 229 PASS;
22 новых PostgreSQL cases. Typecheck 247 roots: 191 baseline/191 current,
0 new/changed-code. Одна baseline diagnostic в неизменённом worker method сохранена.
Guard отклонил лишний type import с транзитивным Enterprise path; удалён, тип берётся
из аргумента уже используемого метода. Guard повторно PASS, 7 migrations неизменны.
Full suite не повторялся: последний LOG056 1881/71. Локальные и тестовые LF hashes
сверены. Полный server typecheck, Claude pass и ROB764 acceptance не заявляются.

[Evidence](log057/README.md). [Remaining writers](rob764-metadata-writer-inventory.md).
Демо/SaleBot не менялись; GitHub Actions не использовался. Применён ai-dev-workflow,
behavioral-guardrails, server-schrodinger и read-only scoped review.


## LOG-058 — atomic temporary failure, import completion, relaunch and CLI (28.10.2026)

Message/calendar temporary failures передают captured account в ordinary owner.
Fresh throttle count, threshold, retryAfter и retry/failed stage вычисляются под
account/channel locks и записываются одним UPDATE. Поведение порога5 сохранено:
count4→5 retry, следующая ошибка→FAILED. Stage start сохраняется. Cache, broadcasts
и metrics следуют только за известным commit; stale/native callback ничего не пишет.
Handlers больше не выполняют собственные раздельные increment/status transactions.

Промежуточный message import объединяет pending и throttle/stage reset. Last/empty
completion возвращает admission result и закрепляет parent; отклонённый completion
не объявляется успешным. Ревью нашло zero-message list-fetch callsite без parent:
исправлен и проверен через actual service с reparent во время getMessageLists.
Предшествующий legacy list-fetch cache clear этим не стал транзакционным: тест
явно сохраняет1 intermediate clear и запрещает чужой final completion/metrics.

Message/calendar relaunch выполняет актуальный FAILED/FAILED_UNKNOWN CAS под
ordinary owner. CLI и status service используют одну выделенную scheduling
операцию; очередь получает только committed returned IDs. Native/protected и
отключённые каналы исключаются. Unknown commit не вызывает enqueue.

Проверки: 279 targeted Jest/6 suites +26 guards = 305 PASS;
24 новых PG cases: parallel threshold, stale snapshot/parent, bound/unbound native,
SQL rollback, lost ACK, actual handlers/relaunch/CLI/list-fetch completion.
Первый прогон276/278 выявил реальный неверный разбор raw UPDATE результата TypeORM:
[rows,count] вместо rows. Исправлено CTE с SELECT id, затем финальный прогон PASS.
Dependency guard отклонил2 лишних импорта; удалены без ослабления guard/baseline.
CLI переиспользует scheduling helper без новой зависимости от полного status service;
calendar handler передаёт isListFetch, enum выбирается в существующем status owner.
Typecheck 252 roots:191/191,0 new/changed-code;7 migrations неизменны.
Full fork последний в LOG056 (1881/71), здесь не повторялся. LF hashes совпали.
Scoped re-review без новых блокеров. Полный server typecheck/Claude pass/ROB764
acceptance не заявляются.

[Evidence](log058/README.md). [Remaining writers](rob764-metadata-writer-inventory.md).
Следующий coherent slice: group/folder metadata и destructive batches. Нельзя
держать новый core owner вокруг cleaner, открывающего собственную native transaction.
Демо/SaleBot не менялись; GitHub Actions не использовался. Применены ai-dev-workflow,
behavioral-guardrails, server-schrodinger и read-only scoped review.


## LOG-059 — folder metadata transaction owner (28.10.2026)

MessageFolderMetadataService create/update/setSyncStatus/delete теперь используют
fresh ordinary account/channel ownership и folder lock в одном manager. Первичное
discovery родителей выполняется до owner, затем точная цепочка проверяется после
блокировок. Все родители захватываются в стабильном порядке до папок. Destination
при reparent входит в тот же lock set; native/retained/derived ownership запрещает
обычную мутацию. Mixed batch отклоняется полностью. Create проверяет также явный
folder ID после INSERT в той же транзакции; это не upsert.

Resolver сохраняет предварительную проверку и передаёт userWorkspaceId для повторной
проверки текущего владельца подключения после блокировки. Google-only backfill,
поведение pending IMPORT при disable и сохранение pending DELETION не изменены.
Relation/scope replacement запрещён. Unknown commit возвращается ошибкой, без
ложного подтверждения успеха. Возвращаемая запись прочитана тем же manager до commit.

Проверки: 226 targeted Jest/5 suites +26 guards = 252 PASS.
30 новых PG tests: CRUD, bound/unbound native, retained junction, mixed batch,
parent/custodian changes, bootstrap after discovery, reversed concurrent batches,
SQL rollback, unknown commit, unreadable ownership, scope mutation, Google/Microsoft.
Typecheck 256 roots:191/191,0 new/changed-code.
7 migrations неизменны, LF hashes совпали. Read-only scoped review без blockers.
Полный server typecheck и новый full fork/Claude pass не заявляются. Последний full
fork остаётся LOG056 (1881/71). ROB764 acceptance ещё не выполнен.

[Evidence](log059/README.md). [Remaining writers](rob764-metadata-writer-inventory.md).
Следующий шаг: group/folder destructive batches внутри существующей native transaction,
с captured parent/action и условным атомарным finalizer. Внешняя nested core transaction
вокруг cleaner не используется. Демо/SaleBot не менялись; GitHub Actions не использован.
Применены ai-dev-workflow, behavioral-guardrails, server-schrodinger и scoped review.


## LOG-060 — guarded group-email cleanup and finalization (28.10.2026)

Group worker принимает текущий snapshot в коротком ordinary-channel owner:
parent, pending action, exclude setting и PostgreSQL updatedAt с6 микросекундными
знаками. Date из загруженной entity не используется. Snapshot является консервативной
проверкой принятой работы, а не отдельным монотонным revision counter.

Каждая порция cleaner в собственной native strict transaction после shared ownership
fence блокирует expected account → channel, проверяет snapshot и полный ownership.
Stale возвращает явный отказ; последующие порции и list-fetch прекращаются. Не открывается
внешняя core transaction вокруг native cleanup. Finalizer повторно проверяет snapshot,
блокирует папки и одним manager сбрасывает разрешённые folder cursors, channel cursor
и pending NONE. Protected junction folder исключается из reset. IMPORT не удаляет данные.

Атомарны отдельная destructive порция и отдельно finalizer. Уже committed порции
не откатываются при stale/error в следующей; pending/new action не стирается. Native
unknown outcome пробрасывается через import handler без ложного failure-state/cache.
Остальные cleaner call sites сохраняют прежний контракт без snapshot; этим не закрыта
вся folder/list-fetch cleanup lifecycle.

Проверено 189 targeted Jest/5 suites +26 guards=215 PASS.
22 новых PG cases: actual worker/cleaner, IMPORT, stale parent/action/settings/time,
ABA1µs, native/retained ownership, protected folder, read failure, SQL rollback,
native lost COMMIT ACK, exclusive enrollment fence,201-message chunks interrupted
by settings change, and actual list-fetch/exception-handler propagation.
Первый lost-ACK test incorrectly intercepted an earlier pool read and timed out;
injection moved immediately before cleaner transaction. Multi-chunk fixture initially
violated native unique(message,channel); corrected to distinct native messages.
Typecheck caught4 implicit-any callbacks in tests, corrected with explicit types.
Typecheck 259 roots:191/190,0 new/changed-code.
7 migrations unchanged; LF source hashes verified. Scoped read-only review clear.
Last full fork LOG0561881/71; no new full server typecheck/Claude pass or ROB764 acceptance.

[Evidence](log060/README.md). [Remaining writers](rob764-metadata-writer-inventory.md).
Next: folder destructive batch and finalizer sharing actual native scope; then sync
folder discovery and provider predicate. Demo/SaleBot unchanged, GitHub Actions unused.
Applied ai-dev-workflow, behavioral-guardrails, server-schrodinger and scoped review.


## LOG-061 — folder action ownership, cleanup and Gmail selection (28.10.2026)

Folder worker captures current parent, pending action, synced state, external ID,
exact6 PostgreSQL folder/channel timestamps and complete folder hierarchy. It no
longer trusts the loaded folder name/hierarchy. Each deletion page holds ownership
fence and account/channel/folder locks, checks current action and performs native
association/message/thread/target cleanup plus folder-junction removal in the same
strict native transaction. A stale page returns explicit refusal and stops the action.

Deletion finalizer uses exclusive native ownership fence, rechecks token and all
remaining junctions (including deleted/unrelated channel rows), then deletes metadata.
Import finalizer compares the full hierarchy and resets pending action before returning
provider IDs. Unknown core/native commit propagates. Ordinary failures remain logged
with pending action preserved. Each page and finalizer is atomic separately; previously
committed pages survive later stale/error. Legacy three-argument low-level deletion
remains unchanged; production folder worker supplies the guarded action token.

Scoped review found two Gmail regressions: singleton folder input could enable a
whole-mailbox shortcut, and incomplete parent names could produce a partial label.
Worker now passes captured complete hierarchy; strict selected-folder mode bypasses
all-folder shortcuts and rejects missing/null/empty/whitespace parent names. Existing
non-strict Gmail callers retain their behavior. Re-review found no confirmed blockers.

226 targeted Jest/6 suites +13 Gmail/2 suites +26 guards=265 PASS.
37 new PostgreSQL cases cover actual worker/importer/cleaner, stale parent/action/
settings/time,1µs ABA, hierarchy drift, protected ownership, mixed requests,201-junction
interruption, rollback and unknown commit. Retired14 mock cases that asserted the old
metadata repository orchestration; real PG workflow coverage replaces them. A test
injection initially assumed a SQL string rather than pg QueryConfig; corrected and
re-run. Typecheck caught implicit parentId inference; explicit type fixed it.
Typecheck 265 roots:190/190,0 new/changed-code.
7 migrations unchanged; local/remote LF source hashes matched, deleted test absent.
Last full fork LOG0561881/71; no new full fork/full server typecheck/full Claude pass
or ROB764 acceptance claimed. Deployment and client acceptance remain separate.

[Evidence](log061/README.md). [Remaining writers](rob764-metadata-writer-inventory.md).
Next: sync-folder discovery, derived provider ownership and final T22/acceptance.
Demo/SaleBot unchanged; GitHub Actions unused. Applied ai-dev-workflow,
behavioral-guardrails, server-schrodinger and scoped read-only review.


## LOG-062 — guarded folder discovery reconciliation (28.10.2026)

Research confirmed SyncMessageFoldersService applied provider responses using the
caller's stale folder list through separate repository writes. Its synthetic return
projection also replaced retained pending IMPORT/DELETION with NONE. Four callers
were checked: list-fetch consumes results; Google/Microsoft/IMAP initial sync ignores
them and runs after account transaction. The selected minimal boundary reuses the
existing ordinary-channel owner and scoped repository.withManager; no new schema.

Before network: fresh ownership, account/channel/folder locks and exact6 versions,
current account identity/import policy/folder rows. During network: no open transaction.
After response: repeat the same owner and reject changed snapshot, then compute delta,
write every folder through the same manager and return actual rows after known commit.
Folder-set changes reject stale discovery rather than deleting newly created folders.
Pending actions remain as stored. Null stops list-fetch before subsequent provider,
cache and completion effects. Existing markAsMessagesListFetchOngoing precedes
discovery and is not rolled back by a later null result.

Scoped review identified same-account IMAP endpoint replacement while old discovery
was running. Snapshot now conservatively includes full connectionParameters and
externalAccountId, while OAuth token refresh remains excluded. Regression verifies
old endpoint response refusal; re-review found no confirmed blockers. IMAP initial
sync explicitly rethrows core unknown commit; ordinary provider failure warning remains.

236 targeted Jest/5 suites +26 guards=262 PASS.
35 new discovery PG cases plus3 actual caller regressions cover current readback,
pending actions,3 provider dispatches, parent/policy/identity/endpoint changes,
folder-set changes, ownership introduction, protected junction, permission failure,
SQL rollback, lost commit ACK and concurrent duplicate prevention. Initial2 failures
were missing UUID-default in the minimal test table; fixture corrected to match the
real generated-ID schema. No production migration was necessary.
Typecheck 267 roots:190/190,0 new/changed-code.
7 migrations unchanged; source LF hashes matched. Last full fork LOG0561881/71;
no new full fork/full server typecheck/full Claude pass or ROB764 acceptance claimed.

[Evidence](log062/README.md). [Remaining writers](rob764-metadata-writer-inventory.md).
Next: derived provider ownership with actual writer serialization, then remaining
list-fetch cache/cleanup boundaries and final T22 acceptance. Demo/SaleBot unchanged,
GitHub Actions unused. Applied ai-dev-workflow, behavioral-guardrails,
server-schrodinger and scoped read-only review.


## LOG-063 — provider writes under complete metadata ownership (28.10.2026)

Research confirmed direct retained-binding Raw predicate did not cover MessageLink,
Conversation or another bound association. Merely duplicating that SQL would not
serialize first ownership introduction. Reused findOmniOwnedConnectedAccountIds with
the existing shared native fence and account FOR UPDATE, preserving identity WHERE
and affected===1. The direct Raw predicate remains an additional check, not the owner.

Seven actual writers: create-existing, reconnect update, IMAP, SSO, refresh, aliases,
app OAuth. Google/MS/IMAP use one strict outer owner; create/reconnect helpers use its
manager, no nesting. New-account paths retain INSERT/PK collision refusal. SSO merges
fresh scopes under lock. Refresh and alias network work stays outside transaction;
caller identity is captured before awaits. App OAuth retains authorized shared-account
reconnect by another custodian and external-account pinning; UPDATE/readback share
the same manager. Google reconnect-list cleanup moved after known commit.

Unknown commit propagates without new returned tokens/aliases. Application connection
mapping no longer turns an unknown refresh commit into successful null fallback.
Scoped review found IMAP archived re-enable by old channel ID could affect a reparented
message/calendar channel; both UPDATEs now pin captured parent. Regression and re-review
confirm the fix. Missing-account error contract remains CONNECTED_ACCOUNT_CHANGED.

342 targeted Jest/6 suites +26 guards=368 PASS.
45 new cases:28 seven-writer×derived-marker checks,7 lost-ACK writers, mutable caller,
both shared/exclusive fence directions, fresh SSO scopes, application-mapping error,
IMAP child reparent, and4 actual Google/MS outer rollback/unknown-commit checks.
44 use real PostgreSQL;1 checks the application mapping boundary. Initial2 regressions
were missing-account error wording and were fixed without weakening the guard.
Typecheck found SSO JSON insert typing and test enum literal; corrected and rerun.
Typecheck 269 roots:190/190,0 new/changed-code.
7 migration sources unchanged; local/remote LF hashes matched. Last full fork LOG056
1881/71; no new full fork/full server typecheck/full Claude pass or ROB764 acceptance.

Postcommit reconnect reset/enqueue still needs captured-parent/accepted-ID handling;
it is not covered by the preceding account transaction. Later list-fetch cache/cleanup
also remains separate. No claim of atomic Redis/SQL effects or arbitrary raw SQL safety.
[Evidence](log063/README.md). [Remaining writers](rob764-metadata-writer-inventory.md).
Next: those callbacks, then T22 inventory and fresh stage acceptance. Demo/SaleBot
unchanged, GitHub Actions unused. Applied ai-dev-workflow, behavioral-guardrails,
server-schrodinger and scoped read-only review.


## LOG-064 — reconnect scheduling and queued parent admission (28.10.2026)

Reconnect formerly reset to PENDING then enqueued jobs requiring SCHEDULED. New
resetAndSchedule methods atomically reset cursors/folders and set SCHEDULED/ONGOING
under the existing ordinary owner, with captured parent and fresh enabled/non-
PENDING_CONFIGURATION predicates. Existing reset-to-pending callers retain their
default behavior; optional expected-parent and returned accepted IDs are additive.
Google/MS/IMAP enqueue only accepted IDs with expectedConnectedAccountId. MS no
longer unconditionally resets old snapshots, including channels awaiting setup.
Both list-fetch jobs reread channel/account under full ordinary ownership with
expected parent and enabled predicate. Legacy payloads remain accepted but receive
the same current ownership check. Provider network stays outside DB transactions.
Unknown reset/admission commit prevents success IDs, cache/broadcast/provider calls.

372 targeted Jest/6 suites +26 guards=398 PASS;
30 new PG cases:24 reset/job admission (parent/disabled/configuration/owned, mixed
IDs, ordinary flow, unknown ACK) and6 actual Google/MS/IMAP caller routing checks.
Typecheck 269 roots:190/190,0 new/changed-code.7 migration sources unchanged.
Scoped read-only review found no substantive blockers; reviewer did not run tests.
Initial test harness issues fixed: CalDAV ESM loading excluded at provider boundary,
existing list-job class mock removed, native bootstrap fixture given APP provider,
uniform it.each tuple arity prevents done-callback timeouts, enum union fixed.

The current parent read is an admission snapshot, not a lock across provider/cache
work. Current channel-only Redis keys still need account provenance to protect a
reparent after SQL commit. Source inventory also found direct import-cron scheduling;
it joins downstream list-fetch/import/cache work next. Webhook/onboarding callbacks
keep their own lifecycle contracts; no claim of whole reconnect cross-store atomicity.
Last full fork LOG0561881/71; no full fork/full server typecheck/full Claude pass or
ROB764 acceptance claimed. [Evidence](log064/README.md).
Demo/transport unchanged; GitHub Actions unused. Applied ai-dev-workflow,
behavioral-guardrails, server-schrodinger and scoped read-only research/review.
