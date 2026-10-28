# ROB765 — сбор аудита действий

Статус: In Progress. Приёмка всей задачи не выполнена.

| Критерий | Подтверждение / остаток |
|---|---|
| Один workspace executor, audit до COMMIT | LOG028/ROB764; LOG089 native Company update/updateMany opt-in |
| Автор из server authentication | LOG089 user/apiKey/application/agent/system; нет browser-selected actor |
| Rollback при сбое журнала, безопасный unknown | LOG089 PG insert fault, actual lost COMMIT ACK, poisoned caller-caught failure |
| Точный безопасный diff и aggregation | LOG089 first-before/last-after, custom NUMERIC >2^53, metadata IDs, без значений |
| Повтор не скрывает вторую mutation | LOG089 sequential/concurrent reuse rejected; повтор после rollback допустим. General command replay ещё не реализован |
| Общий native CRUD/merge/bulk и API | Частично: LOG094 автоматически включает public UPDATE Company/Person/Opportunity; LOG098 включает public soft-delete/restore и native custom lifecycle; LOG101 включает обычный public CREATE standard/custom; LOG102 добавляет flat public upsert; LOG103 добавляет public custom UPDATE/lifecycle; LOG104 — bounded nested CREATE/upsert. LOG105 добавляет internal leaf hard-delete. Real shares, public DESTROY/MERGE, FK side effects и остальные writers впереди. FILES same-executor — LOG092/093 |
| Metadata/role/session lifecycle | LOG099: workspace session CREATE через реальный core owner; LOG100: single/bulk revoke с audit SAVEPOINT и DB cache recheck; metadata и roles открыты |
| Denied/failed audit и health | Omni уже имеет отдельные attempts; general native post-rollback/alert предстоит |
| AI/workflow/connector события | Дополняются ROB768/769, текущий срез их не подключает |
| Operation lookup index | LOG090: generated migration10, populated prefix upgrade/replay/down, real EXPLAIN, drift refusal; не выкатывалось |
| Production rollout | Не выполнялся; нужны полная native coverage и согласованный выкат с остановленными writers при построении индекса |

Подробные результаты: [LOG089 native owner](log089/README.md), [LOG090 operation index](log090/README.md).
Logout/revoke покрыт LOG100; оставшиеся native writers, metadata/roles и negative audit ещё требуют реализации.
Просмотр и экспорт относятся к ROB767, свои права — ROB766; обе задачи пока Backlog.

LOG091: [проверки расширенного native покрытия](log091/README.md);606 tests/24 suites PASS,27 новых PG tests. FilesFieldSync и batch owner mapping реализованы LOG092.

LOG092: [core File transaction/audit](log092/README.md),642 tests/25 suites PASS. Public valid-input parity сохранён LOG093; далее UPDATE owner; общий CRUD/merge/metadata/session/negative audit не готовы.

LOG093: [public input parity](log093/README.md),660 tests/25 suites PASS. Полные snapshots + operation-level explicit timestamp diff; FILES null без изменения прежнего core lifecycle.

LOG094: [public UPDATE owner](log094/README.md), 685 tests/26 suites PASS, 25 новых PG
cases. Реальные processors/repositories/permissions; root hooks после COMMIT,
inherited identity/workspace/actor proof и nested reads в том же executor. Создание
записей, mixed upsert, shareWith и custom nested creates требуют следующей реализации;
общая приёмка ROB765 не выполнена.

LOG095: [native CREATE kernel](log095/README.md), 716 tests/27 suites PASS, 31 новый PG
case. Actual inserted rows/defaults, mixed save/upsert и input capture до lookup;
реальная FK ошибка откатывает все writes. FILES create arrays добавлены LOG096;
public CREATE/другие объекты ещё не включены.

LOG096: [CREATE FILES](log096/README.md), 744 tests/27 suites PASS, 28 новых PG cases.
Actual-written parents и неизменность skipped File rows, full FILES-field readback,
mixed save/upsert, concurrent claim, trigger/core/audit rollback и unknown COMMIT.
Далее coverage связанных пользовательских записей и public CREATE; recordShare не
добавляется в generic CRM allowlist, собственные права остаются ROB766.

LOG097: [custom records](log097/README.md), 766 tests/28 suites PASS, 22 новых PG cases.
Custom create/update/FILES внутри явного owner, metadata boundaries и цепочка
Company→customCase→Company с полным rollback. Public selector пока standard UPDATE.
Следом soft-delete/restore; public CREATE/shares сохраняются в открытом остатке.

LOG098: native soft-delete/restore покрытых standard/custom records и автоматические
public DELETE_ONE/MANY, RESTORE_ONE/MANY Company/Person/Opportunity. Actual IDs,
scoped nested reads, deletedAt postconditions и audit используют один executor.
Matched restore/агрегация сохраняют success с пустым diff; hard-delete не включён.
792 tests/29 suites PASS, 26 новых PG cases, 140 targeted; 26 guards, 10 unchanged
migration checksums. Types 336/337 roots, 189/189 diagnostics, 0 новых/changed.
11 source hashes проверены. Демо не менялось, GitHub Actions не используется.
[Доказательства](log098/README.md). ROB765 остаётся In Progress.

LOG099 подключает реальное создание workspace user-session к strict core owner:
session INSERT, actual readback и audit в одной транзакции; cookie после COMMIT.
coreUser actor и отдельный impersonation initiator определяются по серверным данным.
Workspace-agnostic session, logout/revoke и appToken пока отдельные открытые owners.
Postflush credential/lifecycle проверка и различимый committed post-hook error
не позволяют принять неизвестный исход за rollback. [Доказательства](log099/README.md).

820 tests/30 suites PASS, 28 новых PG cases; 26 guards, 10 unchanged migration checksums. Types 338/340 roots, 189/189 baseline diagnostics, 0 новых/changed. 5 source hashes совпадают.

LOG100: single/bulk UserSession revoke использует strict core owner и audit SAVEPOINT
после actual UPDATE. Отказ журнала не отменяет отзыв, но явно сигнализируется.
Cache-hit перепроверяет DB revocation, поэтому failed Redis eviction не возвращает
доступ. Current actor/impersonation initiator, exact actual rows, preserved filters и
полная проверка остальных session fields покрываются PostgreSQL tests.
Workspace-agnostic revoke сохраняется без выдуманного audit tenant; appToken и
concurrent sign-in fencing пока открыты. [Доказательства](log100/README.md).

835 tests/30 suites PASS, 15 новых PG cases, 43 targeted. 26 guards PASS, 10 migration checksums неизменны. Types: все изменённые server roots включены явно, 341/341 roots, 189/189 baseline diagnostics, 0 новых/changed. 4 source hashes совпадают.

LOG101: обычные public CREATE_ONE/MANY для Company/Person/Opportunity и local custom
objects получают strict native owner. Admission использует snapshot после pre-hook;
настоящие share writes, upsert и nested CREATE пока остаются в прежнем root path.
PRIVATE/INHERITED с пустыми shares не считаются no-share. Strict inherited scope
требует proof, legacy inherited path сохраняется. FILES и postcommit hooks используют
существующие механизмы. Полного HTTP/JWT покрытия и выката нет. [Доказательства](log101/README.md).

854 tests/30 suites PASS (169.5s), 19 новых PG cases, 58 targeted. 26 guard tests PASS; 10 migration checksums неизменны. Types 343/343 roots, 189/189 baseline diagnostics, 0 новых и 0 в изменённых строках. Существующая Brackets type diagnostic в неизменённом методе сохранена. 4 source hashes совпадают.

LOG102: flat public upsert включён в native audit owner для covered local объектов.
Mixed update/insert, unique match/restore, FILES и audit теперь атомарны. Сохраняются
normalization, createdBy, permissions и response contract. Concurrent absent key
может дать PostgreSQL23505 с rollback, без retry; unknown COMMIT не повторяется.
Nested CREATE/real shares пока вне root admission. ROB765 In Progress. [Доказательства](log102/README.md).

871 tests/30 suites PASS (171.954s), 17 новых PG cases, 75 targeted. 26 guards PASS; 10 migration checksums неизменны. Types 341/341 roots, 189/189 baseline diagnostics, 0 новых/changed-code. Прежняя Brackets diagnostic в неизменённом методе остаётся. 2 source hashes совпадают.

LOG103: public UPDATE_ONE/MANY, soft-delete/restore One/Many для covered custom
objects подключены к тому же strict native audit owner. Standard selector сохранён
через OR, permissions и relation behavior не расширены. Actual mutations, FILES,
audit и scoped reads атомарны; hooks после confirmed COMMIT. ROB765 In Progress. [Доказательства](log103/README.md).

888 tests/30 suites PASS (174.467s), 17 новых PG cases; targeted193 tests/4 suites PASS. 26 guards PASS, 10 migration checksums неизменны. Types 341/341 roots, 189/189 baseline diagnostics, 0 новых/changed-code. 3 local/remote source hashes совпадают.

LOG104: bounded nested public CREATE/upsert standard/custom объектов использует единый native audit owner. Исходный граф и каждый child после prehook проверяются; unsupported/share/actor injection отравляет транзакцию. Права, FILES, actual rows и postcommit hooks сохраняются. Первоначально неподдерживаемый граф остаётся на прежнем пути целиком. ROB765 In Progress. [Доказательства](log104/README.md).

905 tests/30 suites PASS (174.02s); 109 targeted PASS. 17 новых cases: 15 PostgreSQL и 2 admission-only. 26 guards PASS; 10 migration checksums неизменны. Types 342/342 roots, 189/189 baseline diagnostics, 0 новых/changed-code. 4 local/remote source hashes совпадают.

LOG105: internal nativeAudit hard-delete covered standard/custom records без входящих FK и непустых FILES. Actual RETURNING определяет audit/events, deletedRecord descriptor требует текущую администрацию. Проверены rollback, FK races, retained omni protection и lost actual ACK. Public DESTROY/MERGE пока не включены, ROB765 In Progress. [Доказательства](log105/README.md).

935 tests/31 suites PASS (180.29s); 124 targeted/4 suites PASS. 30 новых cases: 25 PostgreSQL и 5 descriptor-only. 26 guards PASS; 10 migration checksums неизменны. Types 341/343 roots, 189/189 прежних диагностик, 0 новых/changed-code. 9 local/remote source hashes совпадают.
