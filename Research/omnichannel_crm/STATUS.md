# Текущее состояние Twenty CRM

LOG-063 / ROB-764 In Progress:7 provider writers используют shared ownership
fence, account FOR UPDATE и существующую полную проверку derived ownership перед
identity-limited записью. Google/MS/IMAP outer owners стали strict; helper methods
не открывают nested transactions. SSO merge читает текущие scopes; app reconnect
сохраняет shared access/external account pinning и same-manager readback.
Unknown commit не возвращает новые credentials и не запускает postcommit cleanup.
IMAP archived re-enable дополнительно проверяет parent обоих каналов.
Проверено 342 targeted Jest/6 suites +26 guards =368 PASS,
45 новых regression cases. Typecheck 269 roots:190/190,0 new/changed-code.
Все7 migrations неизменны. [Доказательства](implementation/log063/README.md). Scoped review finding исправлена.
Последний full fork LOG0561881/71. Далее reconnect reset/enqueue и downstream
list-fetch callbacks, затем свежая T22/ROB764 acceptance; этап In Progress.
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
