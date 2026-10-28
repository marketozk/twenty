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

Последние проверки: 1152 tests/36 suites PASS (201.448s); 98 targeted/2 suites + 11 existing role-tool unit tests PASS. 44 новых cases: 40 PG + 4 descriptor. 26 guards PASS; 10 migration checksums неизменны. Types 352/354 roots, 218/218 прежних диагностик, 0 новых/changed-code. 11 local/remote source hashes совпадают.
Это не чистый full-server typecheck. [LOG113 results](log113/results.json).

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

LOG113 сериализует покрытые публичные назначения роли. Core deleteUserWorkspace ещё
удаляет targets/membership раздельно без общего fence; вся публичная removal полоса
также включает native member, transfers и workflow shares. Это следующая исследованная
граница, не завершённый lifecycle и не полная защита last-admin от удаления сотрудника.
