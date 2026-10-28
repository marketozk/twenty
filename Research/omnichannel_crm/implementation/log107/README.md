# LOG107 — защита от неаудированных ON UPDATE effects

ROB765 In Progress. Covered native single/batch/lifecycle UPDATE проверяет реальные
incoming FK перед SET, под уже взятыми parent FOR UPDATE locks. CASCADE/SET NULL/
SET DEFAULT с существующими references отказываются, если referenced key действительно
меняется. Сравнение делает PostgreSQL по тем же SET expressions, параметрам, WHERE,
row-access и lifecycle predicate; учитываются автоматические updatedAt/deletedAt.
Стандартные id references, unchanged values, пустые referencing tables и unmatched
updates допускаются. NO ACTION/RESTRICT по-прежнему проверяет PostgreSQL.

При enabled custom BEFORE UPDATE trigger существующие mutating references
консервативно запрещаются: trigger способен переписать NEW key вне заявленного SET.
Проверяется обычный origin replication mode (O/A). Arbitrary SQL внутри triggers,
внешние DDL changes и privileged replication-role overrides не объявлены покрытыми.
Legacy owner не изменён. Native error отравляет owner даже при caller-caught exception;
ранние batch mutations и audit откатываются вместе.

Mutation builder передаёт существующий WHERE renderer/compiler и структурное
состояние в изолированный guard. Новые Enterprise dependency edges не добавлены;
baseline не расширялся. Повторные запросы не меняют ordinary permissions.

24 новых PG cases: actual composite cascade, NULL/default, single/batch/lifecycle,
implicit/explicit timestamp equality, archived predicate, unchanged/id/empty/other-key,
legacy parity, caught poison, оба порядка concurrent FK insert, custom trigger pair.
До исправления regression действительно завершался success вместо отказа.

Полный общий audit, public DESTROY/MERGE, metadata/roles, share writes, failed/denied
и health остаются открытыми. Прямой ON DELETE CASCADE — следующий ограниченный участок.
Демо/образ/клиентские сообщения не менялись. GitHub Actions не использовался.

978 tests/33 suites PASS (191.233s); 166 targeted/4 suites PASS. 24 новых PostgreSQL cases. 26 guards PASS; 10 migration checksums неизменны. Types 347/349 roots, 189/189 прежних диагностик, 0 новых/changed-code. 6 local/remote source hashes совпадают.
