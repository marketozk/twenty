# Текущее состояние Twenty CRM

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
[Доказательства и границы](implementation/log048/README.md). Проверены claim/cancel race, lost COMMIT ACK,
current/delegated revoke, отсутствие audit, malformed proof/FIFO, >100 отменённых
предшественников, audit/AFTER UPDATE tamper и JS/SQL parity.
Далее — общий native mutation guard по T05/T22. ROB-764 не закрыт; публичный API,
UI, transport cancellation, собственный ACL и автоматизация ещё впереди.
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
