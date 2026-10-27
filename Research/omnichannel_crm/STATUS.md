# Текущее состояние Twenty CRM

LOG-056 / ROB-764 In Progress: пакетные message/calendar sync-status записи
используют одну fresh transaction: shared fence → все account locks → channel locks
→ fresh full ownership → фактические updates. Folder reset и authFailed атомарны.
Cache/broadcast/metrics/reconnect после commit только для обновлённых IDs и captured
recipients. Credential failure сверяет исходный parent; unknown commit пробрасывается
без повторного FAILED/cache replay. Microsoft reset после commit получает channel IDs.
Проверено 1881 full fork Jest /71 suites +26 guards =1907 PASS;
66 новых PG cases заменяют в том числе7 прежних mock reset checks.
Typecheck242 roots:197/191,0 new/changed-code.7 migrations неизменны.
[Доказательства](implementation/log056/README.md). Scoped review замечания исправлены.
Далее group-action/resolver, cursor/throttle/folder writers и итоговый T22.
ROB-764 остаётся In Progress; публичные API, ACL, UI и транспорт ещё впереди.
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
