# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 In Progress: [LOG089](implementation/log089/README.md) добавил внутренний
атомарный аудит Company scalar update/updateMany.570 tests/22 suites и26 guards
прошли; новые28 PG tests проверяют rollback, concurrency, NUMERIC precision,
operationId reuse, permissions и unknown COMMIT. Новых ошибок типов нет;
189 существующих диагностик остаются, full-server typecheck не чистый.

[LOG090](implementation/log090/README.md): подготовлена десятая миграция с индексом
по workspace/operation,72 tests/5 suites +26 guards PASS; данные prefix9 сохранены,
EXPLAIN использует индекс. Проверка типов не добавила диагностик. Не выкатывалось.

[LOG091](implementation/log091/README.md): non-file updates Company/Person/Opportunity,
606 tests/24 suites +26 guards PASS,27 новых PG cases. Composite/JSON/array/Date/FK,
mutable input protection;0 новых type diagnostics.

Это ещё не общий аудит всех ORM writers: непокрытые entry points работают как прежде.
[LOG092](implementation/log092/README.md): FILES включены в тот же executor,
core File audit и actual parent/state readback;642 tests/25 suites +26 guards PASS.
Типы без новых диагностик.

[LOG093](implementation/log093/README.md): FILES null/system timestamp parity сохранён,
660 tests/25 suites +26 guards PASS,18 новых PG cases.

[LOG094](implementation/log094/README.md): автоматический owner для REST/GraphQL
UPDATE стандартных Company/Person/Opportunity, inherited scope proof и scoped nested
reads. 685 tests/26 suites PASS, 25 новых PostgreSQL cases. Прежние awaited postcommit
hook errors сохранены; unknown COMMIT не вызывает повторную запись. Это код и тесты,
не выкат. Публичный CREATE ещё не подключён.

[LOG095](implementation/log095/README.md): native CREATE kernel без вложений,
actual INSERT IDs/defaults и mixed save/upsert. 716 tests/27 suites PASS, 31 новый PG
case. Ограничение FILES arrays снято в [LOG096](implementation/log096/README.md):
вложения меняются только для actual inserted parents, skipped файлы остаются
неизменными, all-fields readback защищает от trigger/default подмены.
Далее публичные create/upsert/nested/shareWith контракты.

LOG096: 744 tests/27 suites PASS, 28 новых PostgreSQL cases; 26 guards PASS,
10 migration checksums неизменны, 0 новых type diagnostics. Демо не менялось.

[LOG097](implementation/log097/README.md): внутренние create/update local custom
objects, включая FILES и вложенную цепочку standard→custom→standard. 766 tests/28
suites PASS, 22 новых PG cases; 0 новых type diagnostics. Public custom owner и CREATE
ещё не включены. Следом soft-delete/restore; shares остаются отдельным access owner.

Продолжаем native CRUD/merge и подключение реальных writers, затем
metadata/session и negative audit. [Приёмка ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Чаты, внешние коннекторы, собственные права и автоматизация ещё не готовы.
Демо прежнее; отправок клиентам не было; GitHub Actions не используется.

[Журнал](DEVLOG.md) · [Задачи](linear.md) · [Контракты](plan/contracts/README.md).
