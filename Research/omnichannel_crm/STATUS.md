# Текущее состояние Twenty CRM

LOG-037 / ROB-764 In Progress: typed bounded resume возвращает qualified history
blocked_config/configuration_missing в retryable_error с прежним receipt и capture.
Текущие права/config/generation проверяются; existing Conversation сохраняет собственную
очередь независимо от defaults. Точный DB cursor, full-page progress и SKIP LOCKED
проверены; новый проход без cursor подбирает пропуски. Аудит атомарен, unknown COMMIT
не объявляется успехом. Реальная цепочка repair→resume→claim→apply проверена.
745 distinct Jest (полный прогон744/745 + исправленный focused44) +25 guards =770 PASS.
Typecheck140roots:0 новых/0 changed-code,
146 baseline/current; все5 миграций прежние. [Доказательства и границы](implementation/log037/README.md).
Далее — настоящий config writer и durable binding.config_changed, затем typed
consumer/housekeeping и остальные inbox/outbox пути. Полный recovery pipeline,
ROB-764/T05, own ACL/UI/HTTP и живые коннекторы ещё не готовы. Демо прежнее,
GitHub Actions не используется.

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
