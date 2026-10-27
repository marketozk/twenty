# Текущее состояние Twenty CRM

LOG-040 / ROB-764 In Progress: recovery связан с существующим strict native
transaction owner. Пять закрытых команд, snapshot до await, свежие grants;
failed/denied audit только после подтверждённого rollback, unknown ACK без false failure.
Housekeeping возвращает один последний завершённый проход для поздних blocked
receipts. Реальный accepted→blocked→repair→wakeup→claim/apply→Message+Person проверен,
включая defer после завершения config event. 226 Jest/11 затронутых suites +26 guards
=252 PASS; финальные21 unit повторены после исправления test typing. Typecheck155roots:
146 baseline/current,0 новых/0 changed-code; одна baseline ошибка в неизменённом
старом методе. Все6 миграций и прежние методы aggregate неизменны.
[Доказательства и границы](implementation/log040/README.md). Далее — human command admission и исходящая очередь.
Scheduler/current production grants, полные ROB-764/T05, own ACL/UI/HTTP и живые
коннекторы ещё не готовы. Демо прежнее, GitHub Actions не используется.

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
