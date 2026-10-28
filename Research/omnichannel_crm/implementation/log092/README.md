# LOG092 — атомарный FilesFieldSync и core File audit

ROB765 In Progress. Внутренний nativeAudit update/updateMany Company/Person/Opportunity
теперь включает FILES массивы. FilesFieldSync переиспользован: optional operation store
читает/блокирует и меняет core.file через тот же workspace executor, без второй SQL
транзакции. Обычные вызовы без opt-in сохраняют прежний core repository path.

Записи CRM блокируются раньше File rows; File IDs сортируются. Проверяются workspace,
активность, temporary/UPLOADED, field universal identifier, max values. Missing/deleted/
foreign removal отказан; старую ID-only softDelete слабость в opted path не переносим.
Batch diff использует настоящий input.id, не partialEntity.id; повтор record/File owners
в одном файловом batch отказан. Core изменения применяются только к actual written
parent IDs. После всех writes перечитываются core state и полный parent FILES список:
лишние/отсутствующие IDs, неверные temporary/deleted state откатывают transaction.

Новый25-й ресурс crmFile: action update, File ID + fileParent(objectMetadataId,
recordId,fieldMetadataId). Scope получен из серверных metadata/locked parent records.
Audit сохраняет только redacted settings/deletedAt diff. Path/label/content/signed URLs
не сохраняются; переименование label меняет только native запись. Same-operation
first/last aggregation и flush-before-COMMIT используют существующий audit context.
Entity/schema/миграции не менялись. Физическое storage deletion не включено в SQL owner.

## Проверено

- **642 tests /25 suites PASS**,156.637s;36 новых PG cases,91 targeted tests.
- Attach для Company/Person/Opportunity, rename/remove, batch без payload.id и spoofed id.
- Foreign/missing/deleted/pending/permanent/wrong-field files, duplicate owners/input,
  concurrent attachment одного temporary File; malformed security descriptor.
- Core write и audit insert failure откатывают native/File; lost real COMMIT ACK
  сохраняет одну success-пару без compensation/re-send.
- RETURN NULL native update и triggers, сохраняющие старый FILES список/temporary state,
  отказаны. Actual final readback добавлен по независимому review; повтор без блокеров.
-26 guard/checksum tests PASS; dependency baseline PASS;10 checksums неизменны.
- Types330/332 roots:189/189 existing diagnostics,0 новых и0 в changed files;
  full-server typecheck не clean.9 local/uploaded LF hashes совпадают.

Первичный typecheck нашёл6 implicit-any только в новых test readers; добавлены типы.
Первый broad run нашёл случайный выбор первой Company по UUID вместо recordId в тесте;
исправлен точный выбор. Финальная регрессия и types повторены, результаты выше.

[Результаты](results.json), [регрессия](regression.log), [types](typecheck-differential.json),
[исходники](source-snapshot.json), [review и следующие стыки](review.md).
Tests исполняют текущий source overlay на LOG088 image. Образ/демо не обновлялись,
внешние файлы/клиенты/коннекторы не затронуты, GitHub Actions не использовался.

## Следом

Перед automatic public UPDATE wiring сохраняем valid input parity: public FILES null
и OPEN system timestamp fields сейчас шире internal guard. Затем strict owner для
REST/GraphQL update-one/many, proven inherited scope, same-executor nested reads,
прежние postcommit hook errors. Create/delete/merge и metadata/session/negative audit
остаются отдельными незавершёнными критериями ROB765.
