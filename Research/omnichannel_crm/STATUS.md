# Текущее состояние Twenty CRM

LOG-059 / ROB-764 In Progress: создание, изменение, синхронизация и удаление
папок выполняются с актуальной проверкой владельца внутри одной транзакции.
Порядок блокировок: подключения → каналы → папки. Родитель перепроверяется после
блокировки; resolver повторно проверяет текущего сотрудника-владельца. Смешанный
пакет с защищённой папкой отклоняется целиком. Google backfill semantics сохранены.
Проверено 226 targeted Jest /5 suites +26 guards =252 PASS,
30 новых PG cases. Typecheck 256 roots: 191/191, 0 new/changed-code.
Все7 migrations неизменны. Последний full fork: LOG056, 1881 tests/71 suites.
[Доказательства](implementation/log059/README.md). Scoped review без подтверждённых блокеров.
Далее group/folder background cleanup, provider predicate, итоговый T22.
ROB-764 остаётся In Progress; собственные ACL, UI и транспорт ещё впереди.
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
