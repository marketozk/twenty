# Текущее состояние Twenty CRM

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
[Доказательства и границы](implementation/log046/README.md). Проверены ACK/sent races, lost COMMIT ACK,
audit/backoff/lease expiry, AFTER UPDATE tamper, другое существующее подключение.
Далее — оставшиеся критерии outbox/state machine по этапу1; текущий slice не
закрывает ROB-764 целиком. HTTP/UI, live transport, scheduler/own ACL ещё впереди.
Демо прежнее, GitHub Actions не используется.

## Предыдущая порция — LOG-022

LOG-022 / ROB-764 In Progress: реализованы минимальный audit writer и атомарное
создание выключенного подключения с disabled policy v0, текущей проверкой прав
через обязательный authorizer и защитой от повторов. Добавлены audit schema/receipt
и проверка append-only privileges перед runtime. Прошли81 PostgreSQL,25 Python
guard/checksum и7 shell tests, focused strict typecheck. [Доказательства и ограничения](implementation/log022/README.md).
Демо не обновлялось; публичного API/чатов/приёма/отправки нет. ROB-772 Done как
планирование; нового полного архитектурного review pass не заявлено.

[Результат R16](plan/cross-review/review-result.md) · [Владельцы контрактов](plan/contracts/README.md) · [Журнал](DEVLOG.md) · [Задачи](linear.md).

База2.52 развёрнута ранее; реализация ROB-764 не меняет её live runtime.
Остальные T01–T33 не закрыты,
внешние коннекторы требуют квалификации. ROB-765–771 Backlog, ROB-762/763 исторические Done.

[Реализация ROB-764 и оставшиеся шаги](implementation/rob764-progress.md).

Код LOG-022 опубликован (`128a3526`); журнал и подтверждение публикации —
`45c52c45`. [Сохранённый результат Linear/CI](implementation/log022/publication.json):
113 выполненных тестов прошли, оба GitHub job не стартовали из-за billing block.
Полный server typecheck не выполнялся. Это не препятствует учёту выполненной
порции, но облачный CI pass и готовность ROB-764 целиком не заявляются.
