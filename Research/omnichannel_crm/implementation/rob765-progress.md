# ROB765 — сбор аудита действий

Статус: In Progress. Приёмка всей задачи не выполнена.

| Критерий | Подтверждение / остаток |
|---|---|
| Один workspace executor, audit до COMMIT | LOG028/ROB764; LOG089 native Company update/updateMany opt-in |
| Автор из server authentication | LOG089 user/apiKey/application/agent/system; нет browser-selected actor |
| Rollback при сбое журнала, безопасный unknown | LOG089 PG insert fault, actual lost COMMIT ACK, poisoned caller-caught failure |
| Точный безопасный diff и aggregation | LOG089 first-before/last-after, custom NUMERIC >2^53, metadata IDs, без значений |
| Повтор не скрывает вторую mutation | LOG089 sequential/concurrent reuse rejected; повтор после rollback допустим. General command replay ещё не реализован |
| Общий native CRUD/merge/bulk и API | Предстоит; текущий opt-in только Company scalar updates. FilesFieldSync — отдельный pool |
| Metadata/role/session lifecycle | Предстоит, каждый через реального transaction owner |
| Denied/failed audit и health | Omni уже имеет отдельные attempts; general native post-rollback/alert предстоит |
| AI/workflow/connector события | Дополняются ROB768/769, текущий срез их не подключает |
| Production rollout | Не выполнялся; перед включением нужен audit(workspaceId,operationId) index и полная native coverage |

Подробные результаты и воспроизведение: [LOG089](log089/README.md).
Следом завершаем native transaction boundary и покрытие writers, затем core/metadata/session.
Просмотр и экспорт относятся к ROB767, свои права — ROB766; обе задачи пока Backlog.
