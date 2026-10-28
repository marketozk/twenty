# ROB765 — сбор аудита действий

Статус: In Progress. Приёмка всей задачи не выполнена.

| Критерий | Подтверждение / остаток |
|---|---|
| Один workspace executor, audit до COMMIT | LOG028/ROB764; LOG089 native Company update/updateMany opt-in |
| Автор из server authentication | LOG089 user/apiKey/application/agent/system; нет browser-selected actor |
| Rollback при сбое журнала, безопасный unknown | LOG089 PG insert fault, actual lost COMMIT ACK, poisoned caller-caught failure |
| Точный безопасный diff и aggregation | LOG089 first-before/last-after, custom NUMERIC >2^53, metadata IDs, без значений |
| Повтор не скрывает вторую mutation | LOG089 sequential/concurrent reuse rejected; повтор после rollback допустим. General command replay ещё не реализован |
| Общий native CRUD/merge/bulk и API | Предстоит; LOG091/092 opt-in updates Company/Person/Opportunity, включая FILES через same executor; public entry points впереди |
| Metadata/role/session lifecycle | Предстоит, каждый через реального transaction owner |
| Denied/failed audit и health | Omni уже имеет отдельные attempts; general native post-rollback/alert предстоит |
| AI/workflow/connector события | Дополняются ROB768/769, текущий срез их не подключает |
| Operation lookup index | LOG090: generated migration10, populated prefix upgrade/replay/down, real EXPLAIN, drift refusal; не выкатывалось |
| Production rollout | Не выполнялся; нужны полная native coverage и согласованный выкат с остановленными writers при построении индекса |

Подробные результаты: [LOG089 native owner](log089/README.md), [LOG090 operation index](log090/README.md).
Следом завершаем native transaction boundary и покрытие writers, затем core/metadata/session.
Просмотр и экспорт относятся к ROB767, свои права — ROB766; обе задачи пока Backlog.

LOG091: [проверки расширенного native покрытия](log091/README.md);606 tests/24 suites PASS,27 новых PG tests. FilesFieldSync и batch owner mapping реализованы LOG092.

LOG092: [core File transaction/audit](log092/README.md),642 tests/25 suites PASS. Далее public valid-input parity и UPDATE owner; общий CRUD/merge/metadata/session/negative audit не готовы.
