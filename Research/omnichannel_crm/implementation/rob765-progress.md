# ROB765 — сбор аудита действий

Статус: In Progress. Приёмка всей задачи не выполнена.

| Критерий | Подтверждение / остаток |
|---|---|
| Один workspace executor, audit до COMMIT | LOG028/ROB764 и LOG089–108: covered native CRUD, FILES и direct SET_NULL/CASCADE; неподключённые writers остаются открытыми |
| Автор из server authentication | LOG089 user/apiKey/application/agent/system; нет browser-selected actor |
| Rollback при сбое журнала, безопасный unknown | LOG089 PG insert fault, actual lost COMMIT ACK, poisoned caller-caught failure |
| Точный безопасный diff и aggregation | LOG089 first-before/last-after, custom NUMERIC >2^53, metadata IDs, без значений |
| Повтор не скрывает вторую mutation | LOG089 sequential/concurrent reuse rejected; повтор после rollback допустим. General command replay ещё не реализован |
| Общий native CRUD/merge/bulk и API | Частично: LOG094 автоматически включает public UPDATE Company/Person/Opportunity; LOG098 включает public soft-delete/restore и native custom lifecycle; LOG101 включает обычный public CREATE standard/custom; LOG102 добавляет flat public upsert; LOG103 добавляет public custom UPDATE/lifecycle; LOG104 — bounded nested CREATE/upsert. LOG105 добавляет internal leaf hard-delete; LOG106 — direct covered SET_NULL effects; LOG107 — fail-closed guard actual ON UPDATE effects; LOG108 — direct covered CASCADE с retained-child guards. Real shares, public DESTROY/MERGE, FK side effects и остальные writers впереди. FILES same-executor — LOG092/093 |
| Metadata/role/session lifecycle | LOG099: workspace session CREATE через реальный core owner; LOG100: single/bulk revoke с audit SAVEPOINT и DB cache recheck; metadata и roles открыты |
| Denied/failed audit и health | Omni уже имеет отдельные attempts; general native post-rollback/alert предстоит |
| AI/workflow/connector события | Дополняются ROB768/769, текущий срез их не подключает |
| Operation lookup index | LOG090: generated migration10, populated prefix upgrade/replay/down, real EXPLAIN, drift refusal; не выкатывалось |
| Production rollout | Не выполнялся; нужны полная native coverage и согласованный выкат с остановленными writers при построении индекса |

Последние проверки: 998 tests/33 suites PASS (197.09s); 134 targeted/4 suites PASS. Прирост 20 PostgreSQL cases. 26 guards PASS; 10 migration checksums неизменны. Types 345/345 roots, 189/189 прежних диагностик, 0 новых/changed-code. 3 local/remote source hashes совпадают.
Это не чистый full-server typecheck. [LOG108 results](log108/results.json).

[Индекс реализованных участков](../plan/phase_2_audit.md), [текущие ограничения](log108/README.md),
[полная хронология](../DEVLOG.md). Исторические заявления «ещё не включено» внутри
старых LOG описывают состояние того среза, а не текущий статус.

Session refresh/appToken/concurrent-sign-in fencing ещё не закрыты. Для файлового
hard-delete требуется audit/durable cleanup owner: штатный DESTROYED listener
только ставит FilesFieldDeletionJob после commit. Полного HTTP/JWT покрытия и
выката после LOG088 нет. Просмотр/экспорт ROB767 и собственные права ROB766 — Backlog.

LOG107 закрывает обнаруженный ON UPDATE gap отказом при реальных mutating references
к меняющемуся ключу, включая автоматические даты и custom BEFORE UPDATE rewrite.
LOG108 добавляет direct covered CASCADE. Далее — надёжный file cleanup owner и
оставшиеся public destroy/merge boundaries; параллельно source-разбор остальных
session/core writers для завершения критериев таблицы. Публичное удаление пока
не переключается на owner с несовместимым blanket отказом обычных записей.
