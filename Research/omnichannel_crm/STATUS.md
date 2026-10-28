# Текущее состояние Twenty CRM

LOG-071 / ROB-764 In Progress: message/calendar importer получают атомарный
допуск SCHEDULED→ONGOING и свежие channel/account/folders. Токен сохраняет
микросекунды PostgreSQL. Completion, retry, failure и legacy reset проверяют
account/stage/token под существующей блокировкой. Unknown native/core outcome
останавливает fallback; token копируется до ожиданий, actual run заморожен.
Проверено 717 targeted Jest/7 suites +26 guards =743 PASS,
58 новых PostgreSQL/caller cases. Typecheck 292 roots:188/188,0 new/changed-code.
7 migrations неизменны. [Доказательства](implementation/log071/README.md). Находка ревью исправлена и перепроверена.
Последний full fork LOG067:2205/75. Далее scheduling producers/onboarding,
provider cursors и native apply. Redis/run atomicity ещё не обеспечена.
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
