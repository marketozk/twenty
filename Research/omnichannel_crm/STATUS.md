# Текущее состояние Twenty CRM

LOG-033 / ROB-764 In Progress: реальный atomic history receipt apply сохраняет
Message + participant с существующей Person, Link/Revision, DomainEvent,
suppressed root/dispatch, audit и applied receipt одной строгой транзакцией.
Поддержан qualified incoming complete text history_import, существующие
Conversation/Identity/Person, current generation и disabled policy v0; current
authorizer обязателен. Повторы/ошибки/unknown COMMIT проверены, автоэффектов нет.
558 Jest +25 guards =583 PASS; новые33 PG cases. Typecheck119roots:0 новых/
0 в изменённом коде;136 baseline, включая1 в неизменённом старом методе.
[Доказательства и границы](implementation/log033/README.md).
Следом — cleanup/lifecycle ownership guards, затем остальные domain apply,
inbox/outbox/recovery. Live/new-conversation/Person/edit/delete/admission и
полный T05/ROB-764 не закрыты. HTTP/own ACL/UI/живые коннекторы не подключены.
Демо прежнее; GitHub Actions не используется.

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
