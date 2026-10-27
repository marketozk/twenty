# Текущее состояние Twenty CRM

LOG-038 / ROB-764 In Progress: config writer создаёт/изменяет очереди и human
defaults binding с current authorization, CAS и общим idempotency receipt.
Policy UPDATE с начала; resource revision/epoch, durable binding.config_changed,
audit и receipt атомарны. No-op не выпускает event; replay повторно проверяет права.
Default/retained queue нельзя отключить, existing Conversations не переносятся.
Actual writer→resume→claim→apply проверен; binding activation остаётся test-only.
826 Jest полного прогона + финальные84 focused (3 новых) +25 guards =854 distinct PASS.
Typecheck145roots:0 новых/0 changed-code,146 baseline/current;5 миграций прежние.
[Доказательства и границы](implementation/log038/README.md). Далее — typed event consumer и durable recovery/
housekeeping, затем остальные inbox/outbox пути. ROB-764/T05, own ACL/UI/HTTP и живые
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
