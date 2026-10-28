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
ещё не включены; shares остаются отдельным access owner.

[LOG098](implementation/log098/README.md): soft-delete/restore и public lifecycle owner,
792 tests/29 suites PASS, 26 новых PG cases, 0 новых type diagnostics.
Создание core user-session покрыто LOG099, logout/revoke — LOG100; physical delete/merge, public CREATE/shared access,
metadata/roles и negative audit ещё открыты. [Приёмка ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Чаты, внешние коннекторы, собственные права и автоматизация ещё не готовы.
Демо прежнее; отправок клиентам не было; GitHub Actions не используется.

[Журнал](DEVLOG.md) · [Задачи](linear.md) · [Контракты](plan/contracts/README.md).

LOG099 подключает реальное создание workspace user-session к strict core owner:
session INSERT, actual readback и audit в одной транзакции; cookie после COMMIT.
coreUser actor и отдельный impersonation initiator определяются по серверным данным.
Workspace-agnostic session, logout/revoke и appToken пока отдельные открытые owners.
Postflush credential/lifecycle проверка и различимый committed post-hook error
не позволяют принять неизвестный исход за rollback. [Доказательства](implementation/log099/README.md).

820 tests/30 suites PASS, 28 новых PG cases; 26 guards, 10 unchanged migration checksums. Types 338/340 roots, 189/189 baseline diagnostics, 0 новых/changed. 5 source hashes совпадают.

LOG100: single/bulk UserSession revoke использует strict core owner и audit SAVEPOINT
после actual UPDATE. Отказ журнала не отменяет отзыв, но явно сигнализируется.
Cache-hit перепроверяет DB revocation, поэтому failed Redis eviction не возвращает
доступ. Current actor/impersonation initiator, exact actual rows, preserved filters и
полная проверка остальных session fields покрываются PostgreSQL tests.
Workspace-agnostic revoke сохраняется без выдуманного audit tenant; appToken и
concurrent sign-in fencing пока открыты. [Доказательства](implementation/log100/README.md).

835 tests/30 suites PASS, 15 новых PG cases, 43 targeted. 26 guards PASS, 10 migration checksums неизменны. Types: все изменённые server roots включены явно, 341/341 roots, 189/189 baseline diagnostics, 0 новых/changed. 4 source hashes совпадают.

LOG101: обычные public CREATE_ONE/MANY для Company/Person/Opportunity и local custom
objects получают strict native owner. Admission использует snapshot после pre-hook;
настоящие share writes, upsert и nested CREATE пока остаются в прежнем root path.
PRIVATE/INHERITED с пустыми shares не считаются no-share. Strict inherited scope
требует proof, legacy inherited path сохраняется. FILES и postcommit hooks используют
существующие механизмы. Полного HTTP/JWT покрытия и выката нет. [Доказательства](implementation/log101/README.md).

854 tests/30 suites PASS (169.5s), 19 новых PG cases, 58 targeted. 26 guard tests PASS; 10 migration checksums неизменны. Types 343/343 roots, 189/189 baseline diagnostics, 0 новых и 0 в изменённых строках. Существующая Brackets type diagnostic в неизменённом методе сохранена. 4 source hashes совпадают.
