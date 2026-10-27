# Текущее состояние Twenty CRM

LOG-043 / ROB-764 In Progress: внутренний verified connector acceptance реализован.
Current worker grant и qualified evidence обязательны также при replay. Новый
факт атомарно сохраняет proof/job/journal, меняет state/revision, снимает lease
и пишет audit; duplicate сохраняет новый reconcile lease. Historical ACK разрешён
без нового send; outcome_unknown не превращается в доставленное сообщение.
FIFO пропускает только строго сопоставленные proofs; неизвестные остаются bounded100.
285 Jest /14 затронутых suites +26 guards =311 PASS;91 новый case, включая53 PG.
Typecheck177roots:146 baseline/current,0 новых/0 changed-code; все6 миграций и
старые методы aggregate неизменны. Полный1025 suite прошёл в LOG041.
[Доказательства и границы](implementation/log043/README.md). Проверены151 подтверждённый predecessor,
23 malformed JS/SQL parity cases, rollback/lost ACK. Это внутренний server-owned
proof, не готовый протокол userbot. Далее — confirmed sent и штатный Message.
HTTP/UI, live transport, scheduler/own ACL и полный ROB-764 ещё не готовы.
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
