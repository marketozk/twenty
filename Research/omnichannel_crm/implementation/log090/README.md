# LOG090 — audit operation lookup index

ROB765 остаётся In Progress. Generated migration добавляет один неуникальный B-tree
`crm_audit.crmAuditEntry(workspaceId, operationId)` для native operation reuse guard
из LOG089. Ни данные журнала, ни предыдущие9 migration sources/checksums не меняются.

Старый isolated generator DB был на prefix5. Первый dry-run обнаружил только уже
существующие migrations6–9; их применили штатным fork CLI из образа LOG088 к этой
тестовой БД. После этого официальный `generate:instance-command` подтвердил пустой
baseline и сгенерировал ровно CREATE INDEX / DROP INDEX. Original source сохранён;
адаптация удаляет upstream registration и задаёт существующий fork-only contract.
Snapshot получен через настоящий PostgreSQL introspection в transaction с rollback.

Новая десятая manifest entry: `omni-1793194359465-audit-operation-index`.
Bootstrap verifier выбирает updated audit snapshot только по applied manifest prefix;
наличие индекса без ledger не считается миграцией. Полный snapshot и проверки
valid/ready сохраняют отказ при missing/reordered/partial/unique index.

## Проверено

- **72 tests /5 suites PASS**,59.227s, в том числе9 новых PostgreSQL cases.
- Populated prefix9 →10:10 000 audit rows и отдельная CRM fixture сохранены;
  replay пуст; PostgreSQL EXPLAIN выбирает новый индекс без Seq Scan.
- Несколько audit rows одной операции допустимы; индекс не уникальный.
- SQL failure после CREATE INDEX откатывает DDL и ledger вместе.
- Missing/reordered/partial/unique index и необъяснённый индекс отказаны.
- Down/up сохраняет аудит и удаляет/возвращает только индекс.
-26 guard/checksum tests PASS; dependency baseline PASS;10 source checksums PASS,
  первые9 manifest entries и source files неизменны.
- Differential types326/329 roots:189/189 existing diagnostics,0 новых/в changed files.
  Это не чистый full-server typecheck.10 local/uploaded LF hashes совпадают.

[Результаты](results.json), [тесты](regression.log), [types](typecheck-differential.json),
[исходники](source-snapshot.json), [original generator output](generated-original.ts).
Read-only review проверило prefix, SQL, snapshot и gates; блокеров не обнаружило.
Reviewer тесты не запускал; результаты выше получены основным исполнителем.

## Ограничения и выкат

Обычный CREATE INDEX выполняется внутри migration transaction и блокирует записи
на время построения. Выкат — при остановленных writers; это не online CONCURRENTLY.
Новый production image не собирался/не выкатывался, демо и внешние источники не менялись.
Runtime image в test harness — LOG088, TypeScript tests исполняют текущий source overlay.
GitHub Actions не использовался. Broad native audit coverage остаётся будущей работой
[ROB765](../rob765-progress.md); наличие индекса не включает её автоматически.
