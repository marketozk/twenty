# ROB765 — сбор аудита действий

Статус: In Progress. Приёмка всей задачи не выполнена.
Это единственная текущая таблица приёмки ROB765; хронология находится в [DEVLOG](../DEVLOG.md).

| Критерий | Подтверждение / остаток |
|---|---|
| Один workspace executor, audit до COMMIT | LOG028/ROB764; [LOG089](log089/README.md) и последующие covered owners. Неподключённые native/core/metadata writers остаются открытыми |
| Автор из server authentication | LOG089; immutable request/application/OAuth attribution [LOG124](log124/README.md), [LOG125](log125/README.md); captured job/CLI identity LOG117/129/130/134. Attribution не заменяет авторизацию |
| Rollback, точный diff, aggregation и operation reuse | LOG089: writer failure, first-before/last-after, NUMERIC precision, no secret values, lost COMMIT ACK; reused operation rejected. General command replay ещё не реализован |
| Native public CRM CRUD | LOG094/098/101–104: covered standard/custom create/update/FILES/soft-delete/restore/upsert/bounded nested writes. Внутренний hard-delete/FK effects — LOG105–108. Real shares, public DESTROY/MERGE, остальные FK effects и native/system writers открыты |
| Session lifecycle | LOG099/100: workspace create/revoke, audit SAVEPOINT и stale-cache DB recheck; LOG109/110: presented refresh signOut и workspace refresh issuance/rotation. Family revoke, stateless application JWT, concurrent-sign-in и in-flight fencing не закрыты |
| Role lifecycle | LOG111/112: public/AI CREATE/UPDATE; LOG113: public member assignment и serialized demotions. Role delete, bulk/agent/API-key assignments и остальные metadata writers открыты |
| Membership / core user lifecycle | LOG114–121: core cleanup с durable workflow-share recovery intent, API/job attribution, stale JWT/cookie checks, core deactivation, creation/deactivation race, narrow email/admin updates и private native member deletion. Полный public removal, real shares и общая last-admin защита всех путей не приняты |
| Connected accounts | [LOG122](log122/README.md)/[LOG123](log123/README.md): transfer/disconnect; [LOG127](log127/README.md)–[LOG129](log129/README.md): four-table delete owner и production callers с fresh authorization, actual FK graph и exact retained checks. Внешние provider effects не откатываются транзакцией БД |
| Native messaging cleanup | [LOG130](log130/README.md): associations удалённого канала и folder junctions. [LOG131](log131/README.md)–[LOG134](log134/README.md): общий orphan sweep, Message/Participant, target reconciliation и empty-thread effects; jobs/CLI, dry-run и unsafe outcome проверены. [LOG135](log135/README.md)–[LOG136](log136/README.md): адресный owner и реальные sync/group/folder/draft callers с актуальными proofs, exact sent target и общим аудитом. [LOG137](log137/README.md): blocklist caller с текущей SQL policy и member custodian proof подключён. [LOG138](log138/README.md): calendar-channel associations и первый job call аудируются; SHARE table lock держит channel DML всех workspace до COMMIT. [LOG139](log139/README.md): закрытый candidate Event owner учитывает Association/Participant/Target CASCADE и точный CallRecording SET NULL; пока без production callers. Calendar orphan sweep/sync и core metadata writers остаются открытыми |
| Background delivery / retries | [LOG126](log126/README.md): recognized unknown/confirmed-commit failure не вызывает automatic queue retry. Crash до сохранения failure, stalled redelivery, manual retry, новый scheduled run и надёжная доставка фоновых событий остаются открытыми |
| File hard-delete | Covered FILES create/update используют тот же executor (LOG092/093/096). Физическое удаление требует audit/durable cleanup owner: штатный DESTROYED listener только ставит FilesFieldDeletionJob после commit |
| Denied/failed audit и health | Omni имеет отдельные attempts; general native post-rollback audit и alert предстоят |
| AI/workflow/connector события | Дополняются ROB768/769; текущий срез их не подключает |
| Operation lookup index | LOG090: migration10, populated upgrade/replay/down, real EXPLAIN и drift refusal. 10 fork migrations неизменны; при будущем построении индекса writers останавливаются |
| Build / deployment / acceptance | Последний собранный кандидат LOG088. Полные HTTP/JWT проверки и выкат последующих изменений не выполнены; isolated tests не закрывают эту строку |

Последние проверенные результаты — в [STATUS](../STATUS.md) и [LOG139 results](log139/results.json).
Full-server typecheck не чистый; новые/changed-file диагностики проверяются отдельно от baseline.
Следующая работа — [global CalendarEvent sweep и jobs](log139/next-boundary.md).
Просмотр/экспорт ROB767 и собственные права ROB766 остаются Backlog.

[Нормативный план этапа](../plan/phase_2_audit.md) · [история](../DEVLOG.md).
Исторические «ещё не подключено» в старых LOG описывают тот момент и не являются текущим статусом.
