# Текущее состояние Twenty CRM

LOG-050 / ROB-764 In Progress: generic hard-delete защищает retained core targets,
ExternalIdentity и native references Person/Company/Opportunity/MessageCampaign.
Проверка выполняется под ownership fence и parent row locks, независимо от bypass,
skipEvents и native capability. Обычные email FK и WorkspaceMember SET NULL сохранены.
Корзина пропускает protected records, двигает точный PostgreSQL (deletedAt,id) cursor
и повторно проверяет retention после lock; concurrent restore не удаляется.
Полный набор: 1604 Jest /65 suites +26 guards =
1630 PASS; 26 новых PostgreSQL случаев. Typecheck 211 roots:
146 baseline/current,0 новых/0 changed-code. Все7 migrations неизменны.
[Доказательства и границы](implementation/log050/README.md). Scoped independent review: замечание о
микросекундах исправлено и проверено. Полный Claude pass не повторялся.
Далее — запрет workspace deletion до первого side effect и гонки metadata/first bootstrap.
ROB-764 не закрыт; разрешённый domain destroy, публичный API, ACL и UI ещё впереди.
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
