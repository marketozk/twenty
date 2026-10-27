# LOG-031 — запрет обычного APP ingestion для omni-owned каналов

Штатный ApplicationMessageIngestionService после findOwnedOrThrow проверяет
persisted core binding по workspaceId/messageChannelId независимо от status.
При ownership отказывает до identity reads, cache lock и aggregate persistence.
SQL error, отсутствие схемы или неожиданный результат не превращаются в доступ.
Обычный APP path и его вход/выход остаются прежними. Leaf helper не импортирует
широкие native/Enterprise типы. Default core DataSource предоставляется через
существующий Nest/TypeOrm DI pattern; module/call sites проверены.

## Проверки

7 PostgreSQL +10 actual-service unit +20 dependency guard +5 checksum =42 PASS.
[Сводка](verification.json), [тесты](tests.txt), [guard](dependency-guard.json),
[TypeScript](typecheck-differential.json), [исходники](source-snapshot.json).
Все5 migration checksums прежние. Полный Jest suite в этой узкой порции не
повторялся: предыдущий LOG-030 выполнил440 Jest +25 guards. Здесь изменён только
один APP вход и новый read-only helper; выполнены адресные проверки его границ.

PG использует полную fork registry, настоящую таблицу binding и отдельную роль
только для чтения: active/inactive/другие допустимые статусы, другой tenant/channel,
отсутствие записи и ошибка SQL. Service tests запускают настоящий ingestion
метод с подменёнными collaborators и проверяют отсутствие identity/cache/aggregate
вызовов при отказе; обычный APP возвращает прежние maps/normalized input.
Это не полный Nest/AppModule startup и не end-to-end GraphQL test.

Typecheck сравнивает одинаковый расширенный native APP graph:110 roots,
0 новых/0 ошибок в изменённых файлах,155 baseline остаётся (141 в предыдущей
порции; дополнительные14 найдены за счёт включения APP dependency graph в обе
стороны сравнения). Полный server typecheck и новая production-сборка не заявляются.
Независимое адресное ревью PASS, Claude/fullarchitecture round не запускался.

## Границы и продолжение

Это проверка persisted ownership на момент APP вызова. Она не заменяет будущие
transaction/lifecycle fences при конкурентном присвоении binding. Штатное
проектируемое omni подключение уже не имеет applicationId; дополнительный guard
защищает ownership независимо от ошибочной APP-конфигурации. Background rematch,
target reconciliation, cleaner/delete/merge и generic mutations ещё требуют
своих проверок. Полный T05/ROB-764 этим шагом не закрывается.

Следующая порция исключает omni Message/Thread из фонового сопоставления контактов
и автоматического расширения targets, сохраняя обычные email/APP batches.
Далее domain apply и inbox/outbox. Демо/живые каналы не менялись; ограниченные
изолированные тестовые ресурсы переиспользуются. GitHub Actions не используется.
