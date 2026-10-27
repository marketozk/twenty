# Текущее состояние Twenty CRM

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
[Доказательства и границы](implementation/log045/README.md). Проверены55 новых PG-сценариев, в том числе
fault injection, expiry после audit, concurrent replay и lost COMMIT ACK.
Далее — сохранение неопределённого исхода, backoff и поиск due Commands в PostgreSQL.
HTTP/UI, transport, scheduler/own ACL и полный ROB-764 ещё не готовы.
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
