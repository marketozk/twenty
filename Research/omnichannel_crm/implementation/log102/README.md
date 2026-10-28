# LOG102 — публичное создание с обновлением совпадений

ROB765 In Progress. Public CREATE_ONE/MANY upsert=true теперь использует native audit
owner для metadata-covered local объектов. Nested create и real share writes остаются
в прежнем root cohort. Единственное runtime изменение снимает запрет upsert в admission;
классификация, runBatchUpdate/runInsert и FILES переиспользуют уже проверенный executor.

Это read/classify → update/insert, не PostgreSQL ON CONFLICT DO UPDATE. Отсутствующий
unique key не блокируется lookup: конкурентный проигравший получает PostgreSQL23505
и полный rollback. Автоматического retry нет. Lost COMMIT ACK остаётся unknown.

Проверены actual Common One/Many + processors + PostgreSQL: четыре standard/custom
объекта, mixed create/update и один operationId, unique composite match, restore и
сохранение createdBy, ambiguous unique match, FILES commit/audit failure/реальный
SQL23505 после UPDATE, object/field permission denial, repeated IDs aggregation,
FILES repeated-ID отказ, empty FILES normalization, selection без requested id,
concurrent absent-key race с подтверждённым23505, actual lost COMMIT acknowledgement.

При разработке тестов подтверждены исходные контракты: domainName нормализуется до
host; FILES [] превращается в null; insert/update используют canUpdateObjectRecords,
отдельного canCreateObjectRecords нет. Невлияющий выдуманный fixture field удалён.
Common fetch принудительно включает id даже без requested id — это сохраняется.
Первые fixture expectations исправлены по этим исходникам, runtime ради них не менялся.

Полные HTTP/JWT тесты, UI, image build/deploy не выполнялись. Демо, внешние сообщения,
провайдеры и GitHub Actions не затронуты. Full public nested/shares, physical delete/
merge, metadata/roles, negative audit и health остаются открытыми.

871 tests/30 suites PASS (171.954s), 17 новых PG cases, 75 targeted. 26 guards PASS; 10 migration checksums неизменны. Types 341/341 roots, 189/189 baseline diagnostics, 0 новых/changed-code. Прежняя Brackets diagnostic в неизменённом методе остаётся. 2 source hashes совпадают.
