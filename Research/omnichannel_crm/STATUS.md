# Текущее состояние Twenty CRM

LOG-047 / ROB-764 In Progress: Command хранит immutable createdRestoreIncarnation.
Admission берёт её из policy под lock; первый claim требует совпадения с текущей.
NULL/старая incarnation запрещают новую отправку, replay не переписывает provenance.
Историческая сверка dispatching/accepted/outcome_unknown сохраняется, включая NULL.
Седьмая миграция additive, без default/backfill; первые6 источников неизменны.
Полный fork suite: 1460 Jest /61 suites +26 guards =
1486 PASS. Typecheck 200 roots:
146 baseline/current,0 новых/0 changed-code.
[Доказательства и границы](implementation/log047/README.md). PostgreSQL проверяет upgrade populated prefix6,
schema drift, auth/replay, policy locks и audit/AFTER UPDATE tamper.
Независимое scoped review без блокеров; полный Claude pass не повторялся.
Далее — локальная отмена ещё не переданной команды и общий native mutation guard.
ROB-764 не закрыт; restore coordinator/provider fence, HTTP/UI/ACL/transport ещё впереди.
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
