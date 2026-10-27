# Текущее состояние Twenty CRM

LOG-052 / ROB-764 In Progress: чистые DB mutations ConnectedAccount.update,
MessageChannel.create/update/delete и APP channel create/update/delete выполняют
ownership check и запись в одной READ COMMITTED transaction под shared native fence.
Account locks предшествуют channel lock; parent и APP permissions читаются заново.
Create relation objects запрещены, delete event публикуется только после commit.
Проверено 244 targeted Jest /9 suites +26 guards =270 PASS, 29 новых PostgreSQL
случаев; typecheck219 roots:162 baseline/current,0 новых/changed-code. Все7 migrations
неизменны. Полный1635-test прогон LOG051 относится к предыдущему снимку; здесь не повторялся.
[Доказательства и границы](implementation/log052/README.md). Independent review выявил различимые APP ошибки:
исправлено и проверено. Полный Claude pass не повторялся.
Далее network lifecycle/reconnect, resolver side effects и итоговый T22 inventory.
ROB-764 остаётся In Progress; публичные API, ACL, UI и транспорт ещё впереди.
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
