# Текущее состояние Twenty CRM

LOG-087 / ROB-764 In Progress: внутренний Person/Company destroy атомарно снимает
identity/target связи, сохраняет историю, пишет административный audit и receipt.
Повтор после удаления и потери COMMIT ACK проверяет актуальные права и прежний результат.
209 tests/8 suites +26 guards =235 PASS;37 new PG cases. Differential typecheck 323 roots:187 baseline/187 current,0 new/changed-code. All nine migration sources unchanged.
[Доказательства](implementation/log087/README.md). Последний полный fork regression: LOG082,2661 tests/83 suites.
Необработанные native/custom FK приводят к полному отказу; generic delete не открыт.
Далее актуальный startup/restart девяти миграций и полный fork regression для ROB-764.
Полный native audit остаётся ROB-765, ACL/API — ROB-766, governed events — ROB-769.
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
