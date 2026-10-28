# LOG103 — public UPDATE и lifecycle пользовательских объектов

ROB765 In Progress. UPDATE_ONE/MANY, DELETE_ONE/MANY (soft-delete), RESTORE_ONE/MANY
теперь автоматически используют существующий strict native audit owner и для
metadata-covered local custom objects. Предыдущий standard selector сохранён через
OR: испорченная standard metadata не превращается в неаудированный legacy path.
Новые transaction owners, share writers или разрешения не добавлены.

Проверены реальные шесть Common runners, single/batch actual rows и один operationId,
user/API actor, object permission denial, audit failure rollback, inherited scope
proof, scoped relation read/rollback, actual lost COMMIT ACK, custom FILES commit
и audit fault rollback. Это soft-delete, не physical delete/FK cascade.

Первый relation test использовал неверный connect:{id}; actual контракт требует
connect:{where:{id}}. Следующий прогон выявил отсутствие обратной metadata relation
в прежней synthetic fixture (она прежде проверяла writes, не nested result reads).
Добавлены взаимные MANY_TO_ONE/ONE_TO_MANY metadata в shared fixture; runtime relation
code не менялся. Все четыре использующие fixture suites включены в targeted run.

Непокрытые system/remote/другие standard objects не объявляются аудированными.
Полный HTTP/JWT, private-sharing integration и rollout не проверялись в этом срезе;
собственная политика доступа остаётся ROB766. Native nested CREATE, physical delete/
merge, metadata/roles, negative audit и health остаются открытыми. Демо, внешние
сообщения и GitHub Actions не затронуты.

888 tests/30 suites PASS (174.467s), 17 новых PG cases; targeted193 tests/4 suites PASS. 26 guards PASS, 10 migration checksums неизменны. Types 341/341 roots, 189/189 baseline diagnostics, 0 новых/changed-code. 3 local/remote source hashes совпадают.
