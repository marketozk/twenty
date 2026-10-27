# Текущее состояние Twenty CRM

LOG-036 / ROB-764 In Progress: первое qualified history-сообщение атомарно
создаёт Conversation/Thread по действующим default queue/human mode и существующим
verified Identity/Person. Параллельные receipts сходятся в одном диалоге;
conversation.created и message.received имеют отдельные suppressed roots/events.
Подтверждается фактическое создание native Thread, rollback и replay проверены.
Нет подходящей конфигурации — тот же receipt переводится в blocked_config после
подтверждённого rollback; неизвестный COMMIT не превращается в retry/успех.
701 Jest/29 suites +25 guards =726 PASS. Typecheck136roots:0 новых/0 changed-code,
146 baseline/current; все5 миграций прежние. [Доказательства и границы](implementation/log036/README.md).
Далее — bounded восстановление blocked_config, затем config producer/consumer,
остальные inbox/outbox пути. HTTP/own ACL/UI/живые коннекторы не подключены;
полные ROB-764/T05 и lifecycle races ещё открыты. Демо прежнее, Actions не используется.

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
