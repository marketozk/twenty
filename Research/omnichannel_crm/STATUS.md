# Текущее состояние Twenty CRM

LOG-082 / ROB-764 In Progress: внутренний writer связывает ExternalIdentity с Person,
меняет или снимает связь. Участники штатной переписки обновляются атомарно с identity,
policy epoch, audit и receipt; прежний автор сообщения остаётся неизменным.
Старая явная связь с Person и её native projection инвалидируются при rebind/unlink.
2661 tests/83 suites +26 guards =2687 PASS;21 new PG cases. Differential typecheck 313 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged. [Доказательства](implementation/log082/README.md). Полный fork regression выполнен на текущем исходнике.
Далее explicit ConversationTarget link/unlink/projector и оставшиеся phase1 criteria;
transport discovery и полный ACL/API ещё не подключены.
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
