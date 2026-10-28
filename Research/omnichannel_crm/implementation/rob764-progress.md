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


## LOG-065 — account-scoped message import cache (28.10.2026)

All five runtime key owners now use one validated canonical UUID helper:
list-fetch, batch importer, sync-status/progress, recent-message onboarding and
clean-cache job. Pending/total/imported v2 keys include workspace/channel/account.
Producers capture namespace before provider await; importer copies caller identity
before awaits and requeues failures only into its captured namespace. Reset/clear/
broadcast use accepted SQL account descriptors, never a later parent lookup.
Public progress reads a current ordinary channel before selecting its namespace;
missing/protected returns null. Old cleanup payloads only delete legacy keys.
One shared7-day TTL is used by producers, error requeue and counter expiry; Redis
operations remain separate, not an atomic TTL/SQL protocol.

Retained legacy backlog (pending set or either counter) causes guarded cursor reset
to list-fetch pending before import/pop/completed. Pending group/folder actions are
preserved. Only known commit permits old-key deletion. Stale parent/disabled/setup
returns stop without deleting the backlog; unknown commit propagates. No dual-read
or reassignment of unknown-origin IDs. This recovery requires surviving legacy keys;
it cannot discover queues already expired/deleted before upgrade. New keys do not
isolate overlapping requests for the same account; downstream snapshot guards next.

388 targeted Jest/6 suites +26 guards=414 PASS.
16 new cases:13 SQL/caller boundaries plus3 pure-key/cleanup cases. Include delayed
list-fetch/onboarding responses after reparent, captured postcommit reset, current
progress, legacy refetch/pending actions/stale/unknown outcomes, actual importer
early stop and account-pinned requeue TTL. Cache is a controlled test double; these
cases do not claim real Redis atomicity. Initial TTL import referenced a nonexistent
shared export; the regression caught undefined TTL, replaced with the canonical
common constant and reran successfully. Runtime behavior tested against real PG
where stated. Typecheck 269 roots:190/189,0 new/changed-code.
7 migration sources unchanged; source LF hashes matched. Scoped read-only review
found no new blockers, did not execute tests. [Evidence](log065/README.md).

Next: guarded import scheduling/current importer and onboarding admission, then
bounded list-response snapshot/SQL apply cleanup and fresh T22 acceptance. This does
not close response-to-write races or onboarding's existing broad catch. Last full
fork LOG0561881/71; no new full fork/full server typecheck/full Claude review or
ROB764 completion claimed. Demo/SaleBot unchanged; no Actions. Applied ai-dev-workflow,
behavioral-guardrails, server-schrodinger and scoped read-only research/review.


## LOG-066 — scheduler and stale recovery admission (28.10.2026)

Generic ordinary metadata scheduling reuses shared ownership fence/account-channel
locks, rechecks enabled/pending in SQL, and returns accepted ID/account descriptors.
Three cron writers and calendar CLI enqueue only these descriptors after known
commit. The compatibility message scheduler retains its string[] contract.
Both import jobs accept expectedConnectedAccountId and read current ordinary
channel/account under the owner before stage/enabled checks and provider calls.
Legacy job payloads remain compatible through current-owner admission.
Both stale watchdogs re-read stage/start time under the owner before resetting;
message broadcasts happen after known commit and contain actual updated channels.
Network/provider calls do not hold DB locks. SQL commit plus queue is not atomic;
partial enqueue failure leaves scheduled rows for existing stale recovery.

434 targeted Jest/6 suites +26 guards=460 PASS;
46 new PostgreSQL cases:24 scheduler,10 watchdog,12 import-job cases. Includes
mixed protected rows, disabled/stage/enrollment changes after candidate reads,
unknown commit/no enqueue or broadcast, known commit/queue failure, parent changes
and legacy payloads. Initial direct UPDATE returned TypeORM [rows,count], not rows;
regression and independent review caught it. CTE SELECT restores flat descriptors.
Typed repository test doubles fix new test errors. Restored declared lodash.groupby
imports after review caught undeclared lodash imports; isolated type tools now include
the declared @types/lodash.groupby 4.6.9 for both baseline and current sources. Dependency guard initially rejected two new transitive edges
through the shared utils barrel. The pure stale helpers now use explicit null/undefined
checks with unchanged timeout/invalid-date behavior; baseline guard passed unchanged.
Typecheck 278 roots:191/189,0 new/changed-code;
7 migration checksums unchanged and remote LF source hashes matched.
Scoped read-only review final reread found no other blockers, did not run tests.
[Evidence](log066/README.md).

Existing message list-fetch cron/CLI payloads still lack expected account; member
blocklist reset loses selected owner provenance. Direct importer/onboarding and
provider-response-to-write lifecycle remain open. Candidate throttle/webhook checks
are not newly transactional; no full lifecycle or SQL/queue atomicity claim.
Last full fork LOG0561881/71; no full server typecheck/full Claude review/ROB764 Done.
Demo/SaleBot unchanged; no GitHub Actions. Skills: ai-dev-workflow,
behavioral-guardrails, server-schrodinger, scoped read-only research/review.


## LOG-067 — scheduled parent and member reset provenance (28.10.2026)

Internal message scheduler/status API now returns accepted ID/account descriptors;
all production callers updated. Cron/CLI enqueue the captured parent; webhook uses
a status-owned current ordinary enabled/SCHEDULED read after scheduling before
provider. No second unguarded account lookup or string-only identity handoff.
Member blocklist deletion retains account and UserWorkspace from discovery and
passes both into reset. Existing owner filters locked channel descriptors before
channel/folder UPDATE and actual-ID cache/broadcast. Global deletion supersedes
member selection, preserving workspace-wide behavior and avoiding duplicate reset.
Member batches are independent per-account transactions; a later failure does not
roll back previously committed accounts. Existing unscoped resets remain compatible.

2205 full fork Jest/75 suites +26 guards=2231 PASS.
28 new PG cases:6 message list cron,16 actual blocklist jobs,6 actual webhook service.
CLI existing case strengthened for captured parent. Tests cover parent/custodian
change after discovery, native enrollment, missing member, global overlap/transfer,
unknown commit/no effects and disabled/stage change before webhook provider.
Member lookup only uses a controlled WorkspaceMember stub; core account/channel,
reset transaction and persistence are real PostgreSQL. Earlier targeted462/6 passed;
final full suite verifies the final read method placement in status service.
Typecheck 282 roots:189/189,0 new/changed-code;
7 migration sources unchanged; source LF hashes matched. Dependency guard passed
without baseline exceptions. New shared types barrel edge in webhook was avoided
by keeping stage/read ownership inside the existing status service.
Scoped read-only review found no blockers, did not run tests. [Evidence](log067/README.md).

Next code inspection found calendar webhook direct status UPDATE and inline import
from IMPORT_PENDING. Guard/pin that caller before requiring SCHEDULED admission in
direct import services. Onboarding/list-fetch callbacks and native post-provider
save/delete remain open: native guards must run inside existing workspace transaction,
not around provider network or a nested transaction. Fresh full suite is regression
evidence, not full ROB764/CRM acceptance. No full server typecheck/full Claude review.
Demo/SaleBot unchanged; no Actions. Skills ai-dev-workflow, behavioral-guardrails,
server-schrodinger with narrow read-only research/review.


## LOG-068 — notification account dispatch and calendar webhook orchestration (28.10.2026)

All eight Google/Microsoft notification trigger calls carry captured account through
queue payload/job. New dedup keys include account; legacy key/body remain unchanged
and separate from qualified keys. Workspace serviceability check still gates queue.
Optional scheduler expected parent is checked by the existing ordinary owner before
UPDATE, not merely after it. Message wrapper/status/webhook forward this pin.
Calendar direct scheduling replaced by generic ordinary scheduling plus fresh
parent/enabled/SCHEDULED read. The accepted account survives fetch. Inline import
requires same-parent IMPORT_PENDING→SCHEDULED and another current read. A resolved
fetch does not itself prove success: handled errors must not import old cache.
Empty/deferred cache behavior preserved. No transaction spans network/provider work.

568 targeted Jest/7 suites +26 guards=594 PASS.
21 new cases:16 actual calendar orchestration/SQL,1 old-parent message rejection,
4 queue dispatch/dedup contract cases with controlled enqueue. Provider/import are
controlled doubles, so no claim on internal fetch/import writes or real BullMQ
execution. Unknown initial/read/inline commit produces no next fetch/import;
parent/stage/disabled/native changes rejected. Legacy body/key compatibility tested.
Typecheck 290 roots:189/189,0 new/changed-code;
7 migrations unchanged, source LF hashes matched; dependency baseline unchanged.
Scoped review checked all callers and found no blockers, did not execute tests.
[Evidence](log068/README.md). Last full fork LOG0672205/75, no new full suite claim.

Remaining: CalendarFetchEventsService ongoing/pending/completed/cursor and native
cleanup after provider, shared calendar cache namespace, direct import/onboarding
admission, same-account run tokens and native apply. Microsoft renew/recreate
lifecycle calls need event parent/subscription pins independently of trigger pin.
The current change only protects scheduling/dispatch/orchestration. No full server
typecheck/full Claude review/ROB764 Done. Demo/SaleBot unchanged; no Actions.
Skills ai-dev-workflow, behavioral-guardrails, server-schrodinger, scoped read-only review.


## LOG-069 — account-scoped calendar cache and legacy refetch (28.10.2026)

All four calendar cache owners now use one UUID-validated normalized v2 key:
fetch producer, batch consumer, webhook count and status/reset flush. Fetch/import
copy caller identity and capture key before awaits; mismatched channel/account
fails before cache/provider. Postcommit flush uses accepted account descriptors.
Calendar retained legacy set causes guarded cursor reset/list-refetch before either
fetch or import. Recovery skips stale parent/disabled/setup/native/protected channels;
stop even on declined reset, and delete legacy only after known reset + v2 flush.
No legacy contents are adopted as belonging to the current account. Already lost
legacy backlog cannot be discovered. Existing cache TTL behavior is unchanged.
Cursor-error/notfound/unknown failure branches now carry snapshot parent into reset/
flush, completing account pin for these error paths alongside credentials/temporary.
This does not supply stage/run guards for successful provider callbacks/native apply.

587 targeted Jest/7 suites +26 guards=613 PASS.
19 new cases:18 PostgreSQL/caller boundaries and1 pure-key case. Includes retained
backlog/unknown outcomes, actual early-stop services, delayed producer after reparent,
postcommit clear after reparent, mutable caller identity, ordinary/stale-parent error
branches. Provider/cache doubles explicitly isolate their boundaries; no real Redis
atomicity or provider integration claim. Initial2 failures were Jest ESM loading of
CalDAV digest-fetch while loading actual fetch orchestration. Explicit provider-layer
mock matches the intended test boundary; actual fetch method and SQL owners remain
executed. Rerun passed. Typecheck 291 roots:189/188,0 new/changed-code;
7 migration sources unchanged, source LF hashes matched; guard baseline unchanged.
Scoped read-only review no blockers, reviewer did not run tests. [Evidence](log069/README.md).

Next: Microsoft lifecycle notification account/subscription/clientState pins across
renew/recreate/recovery; direct importer/onboarding admission, same-account run tokens,
provider status/cursor and native writes. Calendar list-fetch direct cursor and native
cleanup are still separate unchecked response boundaries. Last full fork LOG0672205/75;
no new full fork/full server typecheck/full Claude review/ROB764 Done. Demo/SaleBot
unchanged; no Actions. Skills ai-dev-workflow, behavioral-guardrails, server-schrodinger,
scoped read-only review/research.

## LOG-070 — Microsoft subscription lifecycle snapshot CAS (28.10.2026)

Authenticated Microsoft notification snapshots now reach renew/recreate. Snapshots
copy account, external subscription ID, clientState, status and expiry. Current
ordinary owner admission precedes renew network calls. Existing locked status owner
compares exact nullable values before claim/update/clear; optional legacy callers
remain supported. Create claim pins the fetched snapshot, then failures pin the new
PENDING clientState. Known reset/clear advances expected null expiry/externalId;
recovery cannot adopt a new account or replacement claim. Renew success/error and
delete completion cannot overwrite replacement or newer successful renewal.
Unknown core commit from token refresh is rethrown before failure reset/metrics
in all provider catches and the exception handler; local unknown commit similarly
prevents follow-on operations. No network is held inside a metadata transaction.

659 targeted Jest/7 suites +26 guards=685 PASS;
72 new PostgreSQL/caller cases. Actual orchestration, SQL ownership and Microsoft
handlers execute with explicit network/notification-repository doubles. Coverage:
stale parent/externalId/clientState/status, late renewal/expiry responses, removed/
NOT_FOUND recovery races, new claim vs old create failure, exact null, unknown
admission/clear/OAuth outcomes and unchanged ordinary paths. Initial existing85
and expanded157 webhook cases passed; expanded seven-suite run passed.
Typecheck 291 roots:188/188,0 new/changed-code;
7 migration sources unchanged; LF hashes matched. New helper initially introduced
an unnecessary transitive entity import; moved the single structural snapshot type
to the pure helper, preserving dependency baseline. All guards passed afterward.
Read-only review found expiry CAS and OAuth unknown-commit gaps; both fixed with
regressions, rereview found no further blockers in scope. Reviewer ran no tests.
[Evidence](log070/README.md).

Limits: local CAS does not fence or serialize external provider operations. No new
full fork run/full server typecheck/whole-project acceptance is claimed. Last full
fork LOG0672205/75. Next: direct import/onboarding admission, DB-precision run token,
provider stage/cursor and native apply. ROB764 remains In Progress, next stages
Backlog; demo/SaleBot unchanged. No Actions. Skills ai-dev-workflow,
behavioral-guardrails, server-schrodinger; scoped read-only review/research.

## LOG-071 — direct import admission and exact run status callbacks (28.10.2026)

Both importers now enter only through a locked ordinary/current-account enabled
SCHEDULED→ONGOING update. Fresh channel/account/folders are read in the same owner
transaction; declined/unknown admission stops before legacy cache, aliases and
provider. DB clock produces a six-digit microsecond token, retained separately from
lossy JS Date. Real tokens are frozen; optional callback proofs are copied before
workspace/cache awaits. Existing ordinary/manual status calls without token remain.

Completion, next-batch pending, retry/failure/account-auth status, reset and legacy
recovery compare workspace/channel/account/stage/exact token while holding existing
account→channel locks. Legacy recovery runs after admission and cannot reset another
run. Accepted update rows still control postcommit cache/metrics/broadcast effects;
message ONGOING broadcast retained after known admission. Both core/native unknown
outcomes stop import fallback; message no longer requeues native unknown outcomes.

717 targeted Jest/7 suites +26 guards=743 PASS;
58 new PostgreSQL/caller cases, including concurrent winner, fresh disabled/owned/
stale parent/stage, same-millisecond different-microsecond tokens, completion and
failure after newer run, actual importer error/empty paths, mutable proofs, legacy
reset and unknown admission/native outcomes. Existing fixtures now seed real SQL
SCHEDULED state and account aliases; caller stage substitution is no authorization.
Typecheck 292 roots:188/188,0 new/changed-code;
seven migrations unchanged; source LF hashes verified. Initial typecheck found one
fixture-only union-repository type error; explicit typed repository branches fixed
it and differential recheck passed. One SSH upload was declined by MaxStartups;
retry succeeded, final source hashes and tests verified the uploaded revision.
Scoped review found optional
legacy recovery token copied only after cache await; entry snapshot fixed and paired
regressions added. Reviewer ran no tests. [Evidence](log071/README.md).

Limits: this is SQL status/run ownership, not a durable Redis batch lease or complete
provider result transaction. Existing failed message run may requeue IDs to its
account cache and emit monitoring even when later status mutation is declined.
Postcommit cache effects are not atomic with next runs. Native Message/Event save,
association deletion, cursor writes and scheduling producers/onboarding remain
separate work. No full server typecheck/full fork/ROB764 Done claim. Last full fork
LOG0672205/75. Next: onboarding/list-fetch scheduling/run proof, then native apply.
Demo/SaleBot unchanged, no Actions. Skills ai-dev-workflow, behavioral-guardrails,
server-schrodinger and scoped read-only review/research.

## LOG-072 — recent onboarding and ordinary message list-fetch admission (28.10.2026)

Recent onboarding now claims enabled, ordinary, expected-account, never-synced
LIST_FETCH_PENDING/SCHEDULED under the existing owner. Full list-fetch claims only
SCHEDULED before group/folder/provider work. Fresh entities replace caller snapshots.
Recent batch handoff consumes the reservation once and rotates its exact DB token
while retaining LIST_FETCH_ONGOING. Success, empty IDs and transient errors return
to full list fetch without setting syncedAt; stale watchdog therefore recovers a
crashed recent import as full fetch. This preserves the recent/full-history distinction
without a new queue or persistent recent-import flag. OAuth callers pin the account
and log rejected background work; existing importer owns error classification.

Normal list-fetch reads current run after group/folder actions, passes proof into
cursor/schedule/completion/errors; cursor keeps startedAt until final transition.
Job no longer performs an unowned second error mutation. Known declined callbacks
stop direct import. Unknown core/native outcomes remain visible without fallback.

739 targeted Jest/7 suites +26 guards=765 PASS;
22 new PostgreSQL/caller cases. Typecheck 292 roots:
188/188,0 new/changed-code diagnostics.
Seven migrations unchanged, uploaded LF source hashes verified. Initial tests found
one fixture bootstrap mismatch, corrected to use an actual protected account.
Initial typecheck also caught a changed ordinary importer return contract and four
fixture union-repository errors; retained Promise<void> and explicit typed repositories.
Dependency guard rejected a new onboarding-to-handler edge; removed it and reused
the existing import owner's error path, baseline unchanged. Scoped independent
read-only review found no defect; reviewer ran no tests. [Evidence](log072/README.md).

Limits: provider/native aggregate save and association cleanup still need run proof
inside their native transaction. Redis publication/requeue/cleanup is account scoped,
not SQL-atomic or same-account-run isolated; stale failure monitoring remains.
Exact-size test supplies an empty provider result to exercise completion; it does not
prove recent/full native deduplication or live provider integration. Full server
check and ROB764 acceptance are not complete. Last full fork LOG067:2205/75.
Next: calendar list-fetch admission/cursor finalization, native apply, final regression.
Demo/SaleBot unchanged; no Actions. Skills: ai-dev-workflow, behavioral-guardrails,
server-schrodinger; scoped read-only review/research.

## LOG-073 — calendar list-fetch and atomic cursor/status result (28.10.2026)

Calendar list-fetch claims ordinary/current-account/enabled/SCHEDULED through the
existing transaction owner and loads fresh channel/account. Declined admission stops
before legacy cache/provider. Legacy recovery and errors carry the exact DB run proof.
Completion now atomically updates cursor and IMPORT_PENDING or completed/full-fetch
pending status. This avoids clearing the run token before a separately committed
cursor write. Success metrics are emitted only after known accepted completion.
Fetch returns accepted/declined; webhook refuses inline import after a declined fetch.

756 targeted Jest/7 suites +26 guards=782 PASS;
17 new PostgreSQL/caller cases. Typecheck 292 roots:
188/188,0 new/changed-code diagnostics.
Seven migrations unchanged, source LF hashes matched uploaded tests. Tests exercise
concurrent actual fetch, current enabled/parent/ownership/stage, empty/nonempty
finalization, stale response after reparent/new run, legacy recovery, microseconds,
rollback and unknown commit, stale temporary failure and webhook declined result.
Provider/network/cache use explicit doubles. [Evidence](log073/README.md).

Limits: native association deletion/orphan cleanup and aggregate save still need run
proof inside their own native transaction. Redis publication is account scoped, not
atomic with SQL or isolated per same-account run. This slice does not claim those
side effects are suppressed. No full fork/full server typecheck/ROB764 Done claim;
last full fork LOG067:2205/75. Scoped read-only review, no reviewer tests.
Next: native result apply and cleanup, then fresh regression/acceptance.
Demo/SaleBot unchanged, no Actions. Skills ai-dev-workflow, behavioral-guardrails,
server-schrodinger; scoped read-only research/review.

## LOG-074 — native provider-result apply in the current run (28.10.2026)

Message and calendar aggregates copy run/account/channel before await and validate
scope. Within the existing native transaction/shared ownership fence, account SHARE
and channel UPDATE locks protect fresh parent, enabled flag, exact stage/microsecond
run and complete ordinary ownership check. A declined proof returns before native
reads/writes and postcommit work; import callers stop before completion. Strict
unknown commit propagates without enqueue/rematch.

Calendar pre-read/build/write, including existing participants and other-channel
metadata, now use the same native scope; no nested native transaction. No-run
ordinary and APP targets-only paths retain their contract. Nullable message
participant address/name remain null in native rows; only addressable contacts enter
the contact queue, where missing display name becomes empty string as required.

Full fork 2443 Jest/76 suites +26 guards=2469 PASS; 29 new PostgreSQL cases. Typecheck 294 roots:188/187,0 new/changed-code. Seven migrations unchanged.
Tests cover stale parent/run/stage, disabled/native/derived ownership, aggregate
rollback, real COMMIT lost ACK, same-channel serialization, two-channel calendar
sharing, run UPDATE waiting for native COMMIT, nullable participant identities.
Initial type gate found an existing nullable mismatch in the changed method; fixed
and rechecked. Local/test-source LF hashes match. Scoped independent review found
no remaining issue; reviewer ran no tests. Queue/matcher/provider use explicit doubles.

Limits: provider association/orphan cleanup and Redis publication/requeue do not yet
carry run proof. Contact creation and matching after accepted COMMIT are outside run
protection. No full server typecheck/ROB764 Done/live transport acceptance claim.
Ordinary email cache retains legacy delivery semantics (phase_1_data step 3; spec §15.18); this does not require a new durable email pipeline. Verify delayed callbacks cannot mutate omni.
Next: guarded native cleanup, Redis and postcommit ownership review, then final
stage acceptance inventory. Demo/SaleBot unchanged; no Actions. Skills ai-dev-workflow,
behavioral-guardrails, server-schrodinger; scoped read-only research/review.

[Evidence](log074/README.md).

## LOG-075 — guarded native cleanup and reference concurrency (28.10.2026)

Provider message cleanup copies expected run before await and checks it inside the
existing strict native transaction. Group-action and no-run legacy callers remain
supported. Calendar fetch/import now use one scoped association+orphan cleanup owner;
legacy orphan wrapper reuses the in-scope implementation. Declined cleanup stops the
caller; unknown outcome propagates without final success/cache publication. Message
cursor now advances only after all cleanup chunks accepted. Prior committed chunks
remain committed; the whole provider page is not one transaction.

Read-only review found races with a concurrent second-channel reference and late
association reassignment. Candidate parent rows are locked before reference reread;
message Threads precede Messages. Child associations are locked after parents and
reread with original channel/external-ID predicates. Changed parent conflicts are
explicit. Fixed table allowlist, validated UUIDs and active lifecycle constrain the
internal lock helper. Legacy multi-page transactions can still encounter PostgreSQL
deadlocks and roll back; no claim of global cross-page ordering or deadlock freedom.

496 targeted Jest/5 suites +26 guards=522 PASS; 41 new PG/caller cases. Typecheck 295 roots:187/187,0 new/changed-code. Seven migrations unchanged.
New cases: stale parent/run/stage/ownership declines, complete cleanup, shared graph,
rollback after association deletion, real COMMIT lost ACK, wrong proof scope, both
orders of concurrent reference INSERT and channel/external-ID reassignment, actual
fetch/import callers stopping on false/unknown and bounded second-chunk refusal.
Initial failures were fixture omissions (workspace accessor/calendar handle) and the
expected ORM translation of injected PostgreSQL errors; corrected before final run.
Local/test-source LF hashes match. Independent source review; reviewer ran no tests.

Scope: ordinary Redis publication/pop/requeue and contact jobs retain legacy behavior.
They are not the new omni durable receipt/outbox. No exactly-once ordinary email or
SQL/Redis atomicity claim. Protected native writes/rematching already have ownership
barriers; delayed boundary acceptance remains to be exercised. No live demo/provider
changes, no Actions. Full server typecheck remains nonclean from prior diagnostics.

Next: exact 20-way T01 and delayed cache/postcommit ownership negatives; §15.10 minimal
metadata-only domain revision operation (initial revision exists, placeholder/edit/
delete native apply does not). Payload/files/retention expand in ROB-770. Preserve
initial receipt replay after legitimate revision; do not mark ROB764 Done until
required writers and fresh final acceptance pass. T04 real transport stays ROB-768.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only
research/review. Full fork last passed LOG074:2443/76; no new full-suite claim here.

[Evidence](log075/README.md).

## LOG-076 — duplicate and delayed ownership acceptance (28.10.2026)

Acceptance-only changes: ingress concurrency increased from 6 to 20; a fresh
history fixture accepts 20 identical events then applies the claimed receipt 20 times.
Exactly one creation, 19 replays, one receipt/message/link/native graph and ten success
audit entries remain. No duplicate generic events or replacement Thread.

Actual message/calendar importer is delayed after admission at cache pop. Real account
bootstrap establishes derived omni ownership; provider label is reset to ordinary to
exercise derived protection. On resume a pass-through spy proves actual native aggregate
was reached; native/core snapshots, raw events, completion/pending/contact/rematch/requeue
remain unchanged. Admission/status/legacy recovery and external providers are test doubles;
this is not an end-to-end scheduler test or proof of SQL/Redis atomicity.

Participant snapshot is captured before Conversation ownership. Actual matcher and target
reconciliation run after ownership; protected participants/targets/messages remain unchanged,
while ordinary email positive control matches and creates its three targets. This is not a
full contact creation job / Person listener pipeline test.

170 targeted Jest/4 suites +26 guards=196 PASS; 4 new PG cases. Typecheck 295 roots:187/187,0 new/changed-code. Seven migrations unchanged.
First importer suite load hit an ESM dependency via injected constructors; narrow constructor
mocks keep real importers/native aggregate/ORM guards. Initial message fixture was filtered
as internal email (same domain); corrected external sender and added aggregate reachability
assertion. Independent source review found no confirmed defect; reviewer ran no tests.

No runtime implementation changes, no live demo/provider changes, no Actions. Previous full
fork LOG074:2443/76, no newer full-suite claim. Baseline server diagnostics remain unresolved.
Next: §15.10 metadata-only domain revisions: placeholder fill/edit/delete, trusted source
ordering, atomic native body/head/revision/receipt/audit, initial receipt replay after edits.
ROB-764 remains In Progress until that required writer and fresh final acceptance pass.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.

[Evidence](log076/README.md).

## LOG-077 — current revision schema and initial persistence (28.10.2026)

Added eighth fork migration: nullable MessageLink.currentRevisionId without default
or backfill, Revision UNIQUE(workspaceId,messageLinkId,id), and validated nondeferrable
FK Link(workspaceId,id,currentRevisionId) to that exact revision. Existing seven sources,
checksums and historical schema snapshots are unchanged. Prefix-aware verifier selects
the new Link/Revision snapshot only after eighth ledger entry. Down takes table lock and
refuses any nonnull head instead of destroying current-revision evidence.

New initial history/sent composition inserts Link(NULL), Revision, then head in one
strict native transaction. Final logical Link create audit includes currentRevisionId;
success counts stay 10/14/11. Runtime fixture gets only UPDATE(currentRevisionId).
Replay permits legacy NULL only with the exact single validated initial revision; it
does not adopt NULL or rewrite retained audit. The legacy fixture clears a new graph's
head and retains its new audit shape, so it does not independently simulate every
historical audit serialization. Later domain revisions must support current-head proof
independently from old initial evidence before editing is enabled.

Read-only review found history head readback occurred before audit/final receipt writes.
Added another final readback and PG AFTER-audit/AFTER-receipt trigger regressions. Sent
already rereads core/native graph after both boundaries. Reviewer ran no tests.

Full fork 2508/77 before final history readback; final targeted 188/6 +26 guards PASS. Typecheck 298 roots:187/187,0 new/changed-code. Eight migration sources verified; first seven unchanged.
Full-suite source hashes are retained separately: only history writer and its test file
changed afterward for final readback plus two regressions; all six relevant suites rerun
on final source. No claim that the full suite ran on those last two file versions.
New cases: populated prefix7→8/replay/null down-up; wrong Link/workspace FK; protected
revision deletion; rollback refusal; schema/default/type/FK drift; new head/audit;
legacy NULL replay; ambiguous revision rejection; head UPDATE fault/null tampering and
late audit/receipt tampering. Two old corrupt-fixture setups needed explicit NULL head;
cross-tenant fixture removed an absent provider column. All corrected before final gate. Differential typecheck also found an unknown query row access; explicit UUID row validation removed the new diagnostic, and the six suites/typecheck passed again.

Next: §15.10 incoming text revisions (placeholder/fill/edit/delete). Durable applied
disposition is also required: current receipt.resultId remains canonical MessageLink,
while duplicate/stale need immutable selected/observed revision evidence after head moves.
Use a nullable typed applicationResult on receipt, not audit diffs as operational state
or fake DomainEvents. New incoming writer will validate this outcome and current native
head; automation remains suppressed v0. Public API/UI/transport are later tasks.
ROB-764 remains In Progress. No live demo/provider changes, no Actions. Baseline server
diagnostics remain unresolved. Skills: ai-dev-workflow, behavioral-guardrails,
server-schrodinger; scoped read-only research/review.

[Evidence](log077/README.md).

## LOG-078 — durable incoming application result contract (28.10.2026)

Added ninth additive migration: IncomingReceipt.applicationResult JSONB, nullable,
without default/backfill. SQL CHECK permits nonnull only for applied state + nonnull
canonical resultId + object/version1/incoming_text_revision/known disposition. IS TRUE
rejects missing/null gate keys instead of accepting SQL UNKNOWN. JSON null is rejected;
SQL NULL remains compatible with all old writers. Down locks receipt table and refuses
retained outcomes. Prior eight migration sources/checksums/snapshots are unchanged.
The new CHECK snapshot was generated from PostgreSQL deparse of an isolated temporary
table, then verified against the actual migrated receipt table. Version-aware capture
and message verifiers select the new snapshot only at prefix9. Older prefix tests undo
later migrations in reverse order rather than leaving an incompatible ledger suffix.

Closed runtime schema copies/freezes the flat result, validates normalized UUIDs, bounded
Unicode source key and SHA256; created has no observed head, advanced selects a different
revision, stale selects observed head, duplicate may select a previously known revision.
No implicit source-order comparison occurs. SQL does not enforce JSON revision references
or the full runtime shape: upcoming writer/replay must verify same Link/workspace and
candidate/selected/observed evidence. No application-result writer or public API is enabled.

Application result is redacted by existing audit capture. PG test proves state transition
and changed field are retained without provider revision key/content hash disclosure.
269 targeted Jest/10 suites +26 guards=295 PASS; 50 new cases. Typecheck 303 roots:187/187,0 new/changed-code. Nine migration sources verified; first eight unchanged.
Independent source review found no confirmed blocker; reviewer ran no tests. Typecheck found a UUID template-literal assignment only in the new test. It was rewritten without changing runtime code, its 26 unit cases rerun, and the final differential typecheck passed. Broad-suite and final-source hashes are separately retained; only that test file differs. No full-suite
rerun in this slice. Prior LOG077 full2508/77 precedes its final history readback, whose
final188/6 targeted verification is retained there. No new full-server typecheck claim.

Next: common incoming storage core plus qualified revision branch, preserving legacy
history entrypoint IDs and audit. Placeholder/delete-before-create use one canonical
Message; fill/edit/delete update exact ID under same transaction with head/revision/
receipt outcome/audit. Duplicate/stale write receipt-only outcome, no fake event/counters.
Replay checks retained outcome after current authorization and separately verifies current
native head; it does not reclassify old input against today's head. Incomparable/conflict
must quarantine safely after confirmed rollback; unknown COMMIT stays unknown. Automation
remains suppressed v0. ROB-764 In Progress, UI/transport/ACL/AI tasks remain pending.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.
No live demo/provider changes; no GitHub Actions.

[Evidence](log078/README.md).

## LOG-079 — qualified incoming text revisions (28.10.2026)

Common incoming persistence preserves the legacy history entrypoint, deterministic IDs
and audit conventions. A new internal apply/process facade requires current authorization
and a captured trusted revision adapter. Adapter identity/version must match retained
capture; source positions are opaque to the domain (no timestamp/lexical/numeric guess).
A versioned namespaced key binds qualification to logical revision identity. Semantic
content hash covers canonical key, text, tombstone and completeness; immutable author
and display timestamp are retained from the initial Link.

Initial received/placeholder/edit/delete may create one canonical Message, including a
new Conversation. Exact native text update uses the existing scoped ORM and capability;
head/revision/receipt outcome/audit share the strict transaction. Tombstone clears text,
not native deletedAt. Complete-to-placeholder regression and newer resurrection after
tombstone are rejected. Duplicate or older observations persist a receipt-only outcome,
without another Message/Revision/event/counter. Replay returns retained disposition after
current authorization and evidence checks; it never reclassifies against a later head.
Legacy NULL heads are read-only on replay and transition only within a real new revision.

Retained proof verifies scoped chain, source receipt/envelope/capture/hash, known legacy
or new revision namespace, selected/observed references, initial identity/display and
current native content. Retained success audit and event/root/dispatch evidence are checked.
Batched receipt evidence explicitly preserves bigint routeGeneration as text, including
values above JavaScript safe integer. Final readback after audit and receipt CAS validates
immutable receipt fields, cleared lease/error, current head and native graph. New/legacy
initial replay after edits/deletes does not restore old body. v0 roots remain suppressed.
The chain currently checks retained metadata linearly; large-history load/retention tuning
remains a measured integration concern, not a claim of bounded history cost.

Issued source conflicts can move a receipt to quarantine only after confirmed rollback
and successful failure-audit handling; denied authorization and unknown COMMIT/ROLLBACK
are propagated without that mutation. Missing initial configuration uses blocked_config.
The actual native Message search configuration indexes subject, not body; unchanged NULL
subject does not need an extra body reindex job. Current text remains in native Message.
Files/protected historical payload and real adapter semantics are not implemented here.

Full fork 2598 tests/80 suites +26 guards=2624 PASS; 38 new PG cases. Differential typecheck 307 roots:187/187,0 new/changed-code. Nine migration sources unchanged.
38 new PG cases cover initial/edit/delete, placeholder fill existing/new Conversation,
delete-before-create, immutable author/time, stable duplicate/stale replay, 20 concurrent
writers, different ordered edits, confirmed rollback, real lost COMMIT ACK, unconfirmed
rollback, slow-audit lease expiry, late head/outcome/native corruption, retained evidence
and event/root/dispatch corruption, caller snapshot, and large generation precision.
Scoped independent source review found no confirmed blocker; reviewers ran no tests.
Full suite ran on final source after correcting test-only type annotations and removing
a new type import which introduced a forbidden dependency edge. Guard rules/baseline
were not relaxed. Differential typecheck retains 187 baseline diagnostics; no claim that
the entire server is type-clean. All nine committed migrations remain unchanged.

No public API, real transport, production route or automation activation. Synthetic
adapter comparison in tests is not Telegram/MAX ordering qualification. Existing ordinary
email/cache/contact behavior stays within LOG076 boundaries. Acceptance reconciliation found remaining ROB-764 gaps: unbound identity apply and
early explicit identity/target mutation/projection rollback checks. Current proof still
requires an existing bound Person. These are not closed by the new revision tests.
Projection belongs solely to explicit domain link/unlink, not opportunistic ingress
repair. Implement internal scoped writers with current authorization first; public
policy/API remains ROB-766. ROB-764 stays In Progress; whole CRM is unfinished.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; read-only scoped review.
No live demo changes and no GitHub Actions.

[Evidence](log079/README.md).

## LOG-080 — incoming messages from unbound identities (28.10.2026)

The incoming apply contract now accepts nullable personId on an existing qualified
ExternalIdentity. Authorizer receives the explicit null. Only a non-null personId
requires a live Person lookup. The actual native participant writer and retained
revision-chain proof preserve null, without calling contact matching/creation or
projecting CRM targets. Distinct external identity/peer IDs remain distinct authors.
A dangling non-null Person reference is rejected, not converted into unbound mode.

116 tests/4 suites +26 guards =142 PASS; 15 new PG cases. Differential typecheck 308 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
Fifteen new PostgreSQL tests cover history/live and existing/new Conversation,
placeholder/fill/edit/delete, legacy replay, current authorization including replay,
dangling Person, unknown identity UUID, native writer substitution, distinct unbound
authors, transaction rollback and generic native message/participant write protection.
The first run exposed two incorrect test expectations for replayed:false; tests now
assert the stable identity and created:false while allowing the actual replay flag.
Final source passed all four relevant suites. Full fork was already run in LOG079;
it was not repeated for this small nullable change. Source hashes match the test host.
Scoped independent source review found no confirmed blocker; reviewer ran no tests.

This does not discover/register identities or implement link/rebind/CreatePerson.
The apply proof still requires an existing ExternalIdentity UUID. Future explicit
link/unlink must preserve historical author snapshots and update current native
relations atomically; replay after a future identity mutation is not yet supported.
The existing generic participant helper does not clear a binding via null: explicit
scoped mutation is required, not redelivery. Target projection remains exclusive to
explicit domain link/unlink, never inferred from incoming participants.
ROB-764 stays In Progress. Whole CRM is unfinished. No migration changes, live demo
changes, real messaging or GitHub Actions. Skills: ai-dev-workflow,
behavioral-guardrails, server-schrodinger; read-only scoped review.

[Evidence](log080/README.md).

## LOG-081 — qualified external identity registration (28.10.2026)

Internal registerOmniExternalIdentity accepts qualified peer/source, expectedRevision0,
route generation and an actor-scoped idempotency key. It reuses the strict core transaction
owner and exclusive native ownership fence. Existing workspace policy is locked UPDATE
before receipt/binding/identity; current authorization is mandatory on initial and replay.
New registration creates only unbound identity revision1 and increments policy epoch;
identity, redacted audit and PolicyMutationReceipt commit together. A different key does
not silently overwrite an existing peer/Person. No automatic contact lookup/creation.

Replay returns the original result/operation after current authorization, verifies the
retained identity-create and policy-update success audits, and never redoes mutation/CAS.
Expired result is visible, actor-key payload/action conflict is rejected. Original
registration result is historical; current identity facts are separately passed to the
authorizer. Generation is fenced on initial creation; authorized replay can acknowledge
an older committed registration after a route generation change. Failure/denial audit is
written only after the transaction owner confirms rollback/release by preserving the
callback error. Unknown COMMIT/ROLLBACK does not create a false failed business entry.
The audit catalog now includes omniExternalIdentity (19 resource kinds); peer/source
are redacted. No new schema or migration.

183 tests/11 suites +26 guards =209 PASS; 27 new PG cases. Differential typecheck 310 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
27 new real PostgreSQL cases cover twenty concurrent retries, actor/action key conflicts,
existing bound identity, current denial/revocation, expiration, route precision beyond
Number.MAX_SAFE_INTEGER, workspace isolation/deletion, identity/audit/receipt rollback,
real COMMIT acknowledgement loss, unknown rollback connection discard, caller mutation,
late row corruption, retained audit corruption, and registration followed by actual
native incoming persistence. Read-only review found the missing replay audit proof;
that finding was fixed and covered by three corruption regressions. The first run also
found an incorrect test event-spy reference; the typecheck found an overly narrow UUID
variable type. Both were fixed before the final 183-test run and differential typecheck.
No new diagnostics; the 187 existing baseline diagnostics remain. Previous full fork
run was LOG079; this bounded change uses relevant suites. Source hashes match the host.

The runtime function is internal only. Real adapter qualification/discovery scheduling
and public endpoints are not wired. Existing ingress still receives an explicitly
registered identity UUID. Link/unlink/rebind/CreatePerson and target writers remain
next; future identity mutation must preserve birth author and support authorized old
message replay. ROB-764 remains In Progress and the whole CRM is unfinished.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.
No live demo, real messaging, route activation or GitHub Actions changes.

[Evidence](log081/README.md).

## LOG-082 — explicit identity Person binding (28.10.2026)

Internal setOmniIdentityPerson implements link/rebind/unlink with nullable Person,
expected identity revision and actor-scoped idempotency key. Its existing native owner
runs strict transaction semantics with exclusive native ownership and policy UPDATE
before binding/conversation/identity locks. Current authorization is mandatory on
initial and replay. Workspace-specific Person metadata is resolved by the existing
ORM manager; the leaf receives only a narrow descriptor and native mutation ports.

Only native FROM participants belonging to the exact immutable externalIdentityId are
updated. Other external authors, even unbound authors in the same thread, remain
separate. Old immutable author snapshots, provider identity and message text are not
rewritten. Retained audited identity transitions explain the difference between birth
Person and current relation; missing/forged transitions fail closed. Initial/history
replay and subsequent edit/delete use current native Person while retaining birth
provenance. This is not automatic contact guessing or merging.

When Person changes, old active canonical Person edges in affected conversations become
inactive with revision+1; their verified exact manual native projections are deleted.
There is no automatic new Person/Company/Opportunity target. Native participant changes,
canonical target invalidation, projection deletion, identity CAS, policy epoch, redacted
audit and PolicyMutationReceipt commit together. Post-write readback verifies state.
A repeated key returns its original result after current authorization and exact
identity transition / corresponding policy epoch audit verification, including after
later identity changes. Unknown COMMIT outcome does not append a false failed audit.
The audit catalog now has21 resource kinds, including canonical and native targets.
No schema or migration change.

2661 tests/83 suites +26 guards =2687 PASS;21 new PG cases. Differential typecheck 313 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
21 new PostgreSQL cases cover rebind/unlink/relink and old replay, independent authors,
twenty identical concurrent commands, conflicting concurrent CAS, current denial and
revocation, missing/deleted Person, foreign workspace, forged/missing transition proof,
corrupted result epoch, rollback at participant/projection/audit/receipt writes, real
COMMIT acknowledgement loss, and advanced edit/delete after rebind/unlink. Ordinary
native/event regressions are included in the full fork run. New paths emit no generic
matching events. Local and tested source LF hashes match.

Read-only review found advanced revisions still comparing the historical Person and
an incomplete retained result epoch proof. Both findings were fixed and covered by
regressions. The first targeted runs additionally exposed a UUID/text audit join and
several test expectation/type issues; all were corrected before the final full run.
The Enterprise dependency guard found broad imports, which were replaced with narrow
ports and metadata resolution in the existing owner. Guard baseline was not changed.
Typecheck is differential:187 pre-existing diagnostics remain; it is not a claim of a
clean full server build. No large-history performance claim: transition verification
currently reads retained identity audit history.

The writer is internal. Full own ACL/public API, CreatePerson/autoCreatePerson,
explicit new target creation, generic merge/destroy lifecycle and real transport
wiring are still pending respective acceptance boundaries. ROB-764 remains In Progress.
Skills: ai-dev-workflow, behavioral-guardrails, server-schrodinger; scoped read-only review.
No live demo, real messaging, route activation or GitHub Actions changes.

[Evidence](log082/README.md).
