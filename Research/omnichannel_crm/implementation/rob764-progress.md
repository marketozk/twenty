# ROB-764 — реализация, LOG-022

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

## Следующая порция и незавершённая работа

LOG-024 завершил MessageLink, MessageRevision, ConversationTarget, IncomingReceipt,
OutgoingCommand и DomainEvent. Новый composite UNIQUE Conversation проверяется
строго по версии prefix; старые migration checksums сохранены. Прошли113 PG и25
Python tests, focused typecheck49 файлов, native upgrade/replay и generator zero
diff. [Доказательства и ограничения](log024/README.md). Это schema-only порция.

1. Дополнить ранние roots, consumer receipts, dispatch plans, reply budgets,
   activation/admission из этапа1; применять уже реализованный audit context.
2. Реализовать ingress persistence, атомарное сохранение канонических Message,
   inbox/outbox и recovery согласно [этапу 1](../plan/phase_1_data.md).

T33 выполнен для текущей группы схемы; будущие миграции требуют своих повторов.
Полный server typecheck не выполнялся: официальный build использует SWC без
type checking. Работающая клиентская БД не обновлялась; проверен populated fixture.
Полная проверка runtime permissions/provisioning и audit ownership ещё впереди.
Session lock не является DB-side fencing после потери соединения; старый runtime
должен быть остановлен, при неизвестном исходе нужен разбор до ручного повтора.
Новая схема и writer в демо не выкачены. Приём/отправка и весь T01–T33 не завершены.
Bindings не активируются до собственных прав ROB-766. Никакие G01–G20 не выбраны
за пользователя этой командой начала разработки.

## Ограничение CI после публикации

GitHub Actions не запустил оба job из-за billing block аккаунта (0 steps).
Собственные PostgreSQL/guard/typecheck проверки прошли; облачный CI pass не заявлен.
[Метаданные текущих runs и Linear read-back LOG-022](log022/publication.json).
Описание/комментарий ROB-764 актуализированы; статусы11 задач сохранены.
Настройки оплаты не менялись.
