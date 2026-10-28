# Текущее состояние Twenty CRM

LOG-079 / ROB-764 In Progress: реализована metadata-only обработка входящих
placeholder/fill/edit/delete с одним canonical Message. Current head, revision,
receipt outcome и audit сохраняются атомарно; duplicate/stale не меняют текст,
счётчики или events. Legacy replay после edits остаётся read-only. Full fork 2598 tests/80 suites +26 guards=2624 PASS; 38 new PG cases. Differential typecheck 307 roots:187/187,0 new/changed-code. Nine migration sources unchanged.
[Доказательства](implementation/log079/README.md). Реальная квалификация Telegram/MAX и UI ещё впереди.
Далее unbound identity и внутренние identity/target writers по ранним критериям ROB-764;
полный ACL/API остаётся ROB-766.
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
