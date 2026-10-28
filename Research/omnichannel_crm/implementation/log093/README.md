# LOG093 — valid public input parity перед API owner

ROB765 In Progress. Native audit update сохраняет существующий контракт Twenty:
createdAt/updatedAt/deletedAt имеют writability OPEN и проходят обычные permissions;
FILES null очищает только native column, не меняет core File. [] остаётся отдельным
file remove path. Публичный transaction owner этим срезом ещё не подключён.

Native snapshots теперь включают все metadata fields, кроме id. Для автоматического
updatedAt используется внутренний implicitUpdatedAtFieldId: допустим только crmRecord,
UUID присутствует в обеих полных snapshots, значение задаёт native helper из metadata.
Suppression сохраняется лишь если все writes данного record/action implicit. Любая
явная дата снимает suppression окончательно; diff сравнивает реальный first-before и
last-after. Batch учитывает explicitness отдельно по authoritative recordId, включая
повтор ID. Flag не сохраняется в audit payload/descriptor. createdAt всегда сравнивается.

## Проверено

- **660 tests /25 suites PASS**,156.771s;18 новых PG cases;109 targeted tests.
- Реальный DataArgProcessorService принимает три системные даты, микросекунды сохранены
  в PostgreSQL; audit хранит field IDs без значений.
- Automatic-only timestamps не шумят; explicit-first/middle/last, mixed/repeated batch
  IDs и возврат к исходной точной дате дают корректный first/last diff.
-5 malformed suppression cases отказаны; flag отсутствует в persisted payload.
- Actual FILES validator: null single/batch сохраняет core File byte-for-byte;
  JSON-array input нормализуется и проходит обычное audited attachment.
-26 guard/checksum tests PASS; dependency baseline PASS;10 checksums неизменны.
- Types332/332 roots:189/189 existing diagnostics,0 новых/changed; full-server typecheck
  не clean.8 uploaded/local LF hashes совпадают. Независимое read-only review без блокеров.

Первый запуск настоящего DataArgProcessor обнаружил ESM marked в rich-text import graph.
Jest/SWC теперь преобразует JS и разрешает transform только marked из node_modules;
production dependencies не менялись, validators/transformers не замоканы. В этих тестах
подменён только position collaborator, которому backfill явно запрещён.

[Результаты](results.json), [регрессия](regression.log), [types](typecheck-differential.json),
[исходники](source-snapshot.json), [review](review.md).
Runtime image LOG088 + текущий source overlay; образ/демо не обновлялись, внешние
отправки/файлы/коннекторы не затронуты, GitHub Actions не использовался.

## Следом

Automatic REST/GraphQL UPDATE_ONE/UPDATE_MANY для exact standard objects: server-owned
strict transaction, proof inherited scope, same-executor nested reads, прежний awaited
postcommit hook error contract. Create/delete/merge и metadata/session/negative audit
остаются впереди. Native exact NUMERIC tests не означают public numeric precision >2^53:
существующий DataArgProcessor numeric transformer переводит значения в Number и не менялся.
