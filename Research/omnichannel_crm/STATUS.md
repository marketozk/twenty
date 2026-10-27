# Текущее состояние Twenty CRM

LOG-035 / ROB-764 In Progress: native metadata lifecycle проверяет владение до
hooks/отзыва токенов/удаления подписок, DB update/delete и событий. Защищены
аккаунты, каналы, reset до cache и folder actions до import/cleanup/удаления папки.
Прямая binding и косвенные связи учитываются; обычные соседние папки сохранены.
667 Jest полного прогона + финальные86 focused (2 новых) +25 guards:
694 distinct PASS. Typecheck133roots:0 новых/0 changed-code,149→146 baseline.
Все5 миграций прежние. [Доказательства и границы](implementation/log035/README.md).
Далее — первый Conversation/Thread при receipt apply, затем config recovery и
остальные inbox/outbox пути. Проверки lifecycle point-in-time; гонки владения,
generic/raw CRUD и полный T05/ROB-764 ещё открыты. HTTP/own ACL/UI/живые коннекторы
не подключены. Демо прежнее; GitHub Actions не используется.

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
