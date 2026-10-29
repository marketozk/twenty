# ROB765 — сбор аудита действий

Статус: In Progress. Приёмка всей задачи не выполнена.

| Критерий | Подтверждение / остаток |
|---|---|
| Один workspace executor, audit до COMMIT | LOG028/ROB764 и LOG089–113: covered native CRUD, FILES и direct SET_NULL/CASCADE; неподключённые writers остаются открытыми |
| Автор из server authentication | LOG089 user/apiKey/application/agent/system; нет browser-selected actor |
| Rollback при сбое журнала, безопасный unknown | LOG089 PG insert fault, actual lost COMMIT ACK, poisoned caller-caught failure |
| Точный безопасный diff и aggregation | LOG089 first-before/last-after, custom NUMERIC >2^53, metadata IDs, без значений |
| Повтор не скрывает вторую mutation | LOG089 sequential/concurrent reuse rejected; повтор после rollback допустим. General command replay ещё не реализован |
| Общий native CRUD/merge/bulk и API | Частично: LOG094 автоматически включает public UPDATE Company/Person/Opportunity; LOG098 включает public soft-delete/restore и native custom lifecycle; LOG101 включает обычный public CREATE standard/custom; LOG102 добавляет flat public upsert; LOG103 добавляет public custom UPDATE/lifecycle; LOG104 — bounded nested CREATE/upsert. LOG105 добавляет internal leaf hard-delete; LOG106 — direct covered SET_NULL effects; LOG107 — fail-closed guard actual ON UPDATE effects; LOG108 — direct covered CASCADE с retained-child guards. Real shares, public DESTROY/MERGE, FK side effects и остальные writers впереди. FILES same-executor — LOG092/093 |
| Metadata/role/session lifecycle | LOG099: workspace session CREATE через реальный core owner; LOG100: single/bulk revoke с audit SAVEPOINT и DB cache recheck; LOG109: presented refresh security revoke и audit; LOG110: workspace refresh issuance/rotation; LOG111/112: public/AI role UPDATE/CREATE; LOG113: public member assignment и fresh application tenant checks. Role delete, bulk/agent/API-key assignments, membership removal и остальные metadata writers открыты |
| Denied/failed audit и health | Omni уже имеет отдельные attempts; general native post-rollback/alert предстоит |
| AI/workflow/connector события | Дополняются ROB768/769, текущий срез их не подключает |
| Operation lookup index | LOG090: generated migration10, populated prefix upgrade/replay/down, real EXPLAIN, drift refusal; не выкатывалось |
| Production rollout | Не выполнялся; нужны полная native coverage и согласованный выкат с остановленными writers при построении индекса |

Последние проверки: 1380 tests/45 suites PASS (209.814s); 69 targeted/3 suites PASS, 37 новых PG cases. 26 guards PASS; 10 migration checksums неизменны. Types 361/362 roots, 189/189 прежних диагностик, 0 новых/changed-file. 3 local/remote source hashes совпадают.
Это не чистый full-server typecheck. [LOG120 results](log120/results.json).

[Индекс реализованных участков](../plan/phase_2_audit.md), [текущие ограничения](log113/README.md),
[полная хронология](../DEVLOG.md). Исторические заявления «ещё не включено» внутри
старых LOG описывают состояние того среза, а не текущий статус.

LOG109 покрывает signOut предъявленного refresh token; LOG110 — workspace выпуск/rotation. Family revoke,
stateless application JWT и concurrent-sign-in fencing ещё не закрыты. Для файлового
hard-delete требуется audit/durable cleanup owner: штатный DESTROYED listener
только ставит FilesFieldDeletionJob после commit. Полного HTTP/JWT покрытия и
выката после LOG088 нет. Просмотр/экспорт ROB767 и собственные права ROB766 — Backlog.

LOG107 закрывает обнаруженный ON UPDATE gap отказом при реальных mutating references
к меняющемуся ключу, включая автоматические даты и custom BEFORE UPDATE rewrite.
LOG108 добавляет direct covered CASCADE. Далее — надёжный file cleanup owner и
оставшиеся public destroy/merge boundaries; параллельно source-разбор остальных
session/core writers для завершения критериев таблицы. Публичное удаление пока
не переключается на owner с несовместимым blanket отказом обычных записей.

LOG114 добавляет core membership cleanup под общим с LOG113 workspace fence: targets
и membership удаляются вместе, workflow-share recovery intent сохраняется до потери
creator FK. Полный public removal включает native member и transfers до этого owner.
LOG115 добавляет membership/FK audit primitive с явной operation и security-first
savepoint. Известные scope/effect checks сохраняются при отказе journal coverage.
LOG117 подключает trusted attribution известных API/jobs, включая impersonation
и delegated application; exact retained IDs и user под lock исключают подмену цели.
Общая last-admin защита и real native share integration открыты.
LOG116 закрывает soft-delete/JWT stale-cache gap:
actual strategy/cookie bridge проверены с PostgreSQL и отказавшей инвалидацией.
Полный HTTP и fence уже принятых запросов этим не заявлены.
LOG118 подключает три coreUser softDelete callers к strict owner с actual audit,
fresh remaining-membership check, security-first savepoint и cache-finally.
LOG119 закрывает production membership creation/deactivation race shared user lock
и active validation в INSERT transaction; locale-only UPDATE не восстанавливает
удалённое членство. LOG120 заменяет три старых coreUser saves
в email verification/server-admin и проверяет fresh admin flags под lock.
[Следующая граница](log120/next-boundary.md) — private native member writer.
