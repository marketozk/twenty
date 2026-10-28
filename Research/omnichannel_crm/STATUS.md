# Текущее состояние Twenty CRM

LOG-068 / ROB-764 In Progress: все восемь notification trigger calls передают
captured account; очередь разделяет dedup по аккаунту с сохранением legacy payload/key.
Первое scheduling проверяет expected parent до UPDATE. Calendar webhook делает
fresh scheduled read и после fetch допускает inline import только из current
IMPORT_PENDING того же account, затем повторяет guarded read.
Проверено 568 targeted Jest/7 suites +26 guards =594 PASS,
21 новый case (17 PostgreSQL,4 queue dispatch). Typecheck 290 roots:189/189,0 new/changed-code.
7 migrations неизменны. [Доказательства](implementation/log068/README.md). Scoped review без blockers.
Последний full fork LOG067:2205/75. Далее calendar cache/provider callbacks,
MS notification lifecycle и direct importer/onboarding/native apply.
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
