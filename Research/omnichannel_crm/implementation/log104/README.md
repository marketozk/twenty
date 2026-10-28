# LOG104 — аудит вложенного public CREATE

ROB765 In Progress. Автоматический CREATE/upsert owner допускает цепочку covered
local standard/custom объектов, когда ни один узел не требует real share writes.
Рекурсивная проверка смотрит только MANY_TO_ONE relation/morph .create и actual
relationTargetObjectMetadataId, сохраняет предел глубины5 и nested count200.
Обычные JSON поля не трактуются как вложенные relation commands.

После каждого child prehook admission проверяется снова внутри proven native scope,
до prepareAndRun/ShareWithService. Unsupported/share/actor failure отравляет owner:
перехват ошибки вызывающим кодом не позволяет частичный commit. WeakMap registration
probe только выбирает ветку; identity/lifecycle/workspace/actor проверяет прежний
runInExistingNativeCrmAuditScope. Покрытые strict unproven scopes по-прежнему отказаны.
Незарегистрированный strict owner для unsupported объекта остаётся прежним.
Первоначально unsupported graph полностью сохраняет legacy transaction path.

PG tests: root Company→customCase→Company, nested upsert, audit/permission/FILES
rollback, unsupported/share injection, supported child hook, postcommit visibility,
legacy graph и strict non-native owner, caller-caught poison, copied scope, changed
actor, depth5/6 и lost actual COMMIT ACK. Ограничение200/201 отдельно проверяется
только на admission, не как PG runtime counter test. Полный HTTP/JWT не включён.

Используются существующие kernel snapshots/FILES/audit aggregation. Share writes и
unsupported standard/system/remote objects не становятся аудированными. Own access,
metadata/roles, physical delete/merge, negative audit/health ещё открыты. Образ/демо,
внешние сообщения, провайдеры и GitHub Actions не затронуты.

905 tests/30 suites PASS (174.02s); 109 targeted PASS. 17 новых cases: 15 PostgreSQL и 2 admission-only. 26 guards PASS; 10 migration checksums неизменны. Types 342/342 roots, 189/189 baseline diagnostics, 0 новых/changed-code. 4 local/remote source hashes совпадают.
