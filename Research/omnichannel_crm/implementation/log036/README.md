# LOG-036 — первое сообщение и создание диалога

Qualified history_import incoming complete text использует существующие verified
Identity/Person. Новая Conversation получает очередь и human mode из актуального
binding, native Thread получает receipt-derived UUID. INSERT ON CONFLICT и отдельный
SELECT FOR UPDATE после ожидания позволяют параллельным первым receipts использовать
одну Conversation. Повтор applied receipt проверяет creator evidence, events и аудит.
Новая Conversation без связанного корректного Thread не восстанавливается молча.

Native helper возвращает IDs реально вставленных Thread. Facade проверяет фактический
createdThread и createdMessage; чужой Thread между precheck и helper вызывает rollback.
Новая Conversation не получает автоматических Target links: для них потребуется
отдельная авторизованная policy mutation. Existing Thread subject/null contract сохранён.

События conversation.created (sequence1) и message.received (sequence2) имеют отдельные
suppressed roots/empty dispatch plans. Новая операция пишет14 audit rows, существующая10.
Message/revision/link, sequence/replyRevision, события, audit и applied receipt атомарны.
Последний lease CAS выполняется после audit flush. Admission/budget/AI/jobs не создаются.

Additive processOmniHistoryReceipt переводит только доверенную missing-configuration
ошибку в blocked_config после подтверждённого rollback и failure audit. Поддельные
ошибки, отказ authorizer, unknown COMMIT/ROLLBACK/release и ошибка defer не маскируются.
Исходный saveMessagesAndEnqueueContactCreation method+tail сверены с HEAD: без изменений.
DataSource DI подтверждён по module graph, полный Nest bootstrap smoke не заявляется.

## Проверки

[701 Jest/29 suites](tests.txt), [22 focused PG](target-final.txt),
[сводка](verification.json), [TypeScript](typecheck-differential.json),
[harness](typecheck-differential.cjs), [guard](dependency-guard.json),
[9 исходников и совпадение remote hashes](source-snapshot.json).
20 guard +5 checksum tests:726 PASS суммарно. Все5 migration sources неизменны.
136 typecheck roots:146 baseline/current,0 новых/0 changed-code. Единственная диагностика
в изменённом файле относится к неизменённому старому aggregate method (AST/text comparison).
Это не полный server build/typecheck. Runner6GiB/2CPU, Node heap4608MiB.

22 PG проверяют первый apply/replay, конкурирующие receipts, реальную блокировку policy
через pg_blocking_pids, config/identity failures, аудит/откат и unknown COMMIT.
10 unit проверяют process bridge с реальным методом и mocked collaborators.
Первый focused run:82PASS/2FAIL из-за test harness. Spy не учитывал compiled query object;
исправлен и дополнен проверкой реального ожидания PostgreSQL. Предположение о concurrent
Message insert в заблокированный Thread не подтвердилось: FK KEY SHARE ждёт FOR UPDATE.
Этот тест заменён реальным конфликтом header в другом Thread; existing helper отвергает его.
Независимое scoped review выявило реальное переиспользование чужого Thread между precheck
и helper; исправлено проверкой фактического insert и проверено PG interleaving.

## Границы и следующий шаг

Есть только typed internal entry и ограниченный history subset. Нет live admission,
новых Person, UI/API/grants, включения processors/cron или живых коннекторов.
blocked_config recovery ещё не подключён. Далее bounded resume того же receipt,
затем настоящий config writer/event consumer/housekeeping. ROB-764 остаётся In Progress.
Демо/production не менялись; GitHub Actions не использовался.


Публикация LOG-036: код 533fc589ca8774ca28e3266636409d7c14850caa, remote проверен GitHub API. Описание ROB-764 и комментарий fc300f88-88b2-4060-8ae0-c5b56b27c37e прочитаны обратно; все11 статусов сохранены. Продолжаем LOG-037.
