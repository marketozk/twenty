# ROB765 — сбор аудита действий

Статус: In Progress. Приёмка всей задачи не выполнена.

| Критерий | Подтверждение / остаток |
|---|---|
| Один workspace executor, audit до COMMIT | LOG028/ROB764; LOG089 native Company update/updateMany opt-in |
| Автор из server authentication | LOG089 user/apiKey/application/agent/system; нет browser-selected actor |
| Rollback при сбое журнала, безопасный unknown | LOG089 PG insert fault, actual lost COMMIT ACK, poisoned caller-caught failure |
| Точный безопасный diff и aggregation | LOG089 first-before/last-after, custom NUMERIC >2^53, metadata IDs, без значений |
| Повтор не скрывает вторую mutation | LOG089 sequential/concurrent reuse rejected; повтор после rollback допустим. General command replay ещё не реализован |
| Общий native CRUD/merge/bulk и API | Частично: LOG094 автоматически включает public UPDATE Company/Person/Opportunity; CREATE/delete/merge и остальные writers впереди. FILES same-executor — LOG092/093 |
| Metadata/role/session lifecycle | Предстоит, каждый через реального transaction owner |
| Denied/failed audit и health | Omni уже имеет отдельные attempts; general native post-rollback/alert предстоит |
| AI/workflow/connector события | Дополняются ROB768/769, текущий срез их не подключает |
| Operation lookup index | LOG090: generated migration10, populated prefix upgrade/replay/down, real EXPLAIN, drift refusal; не выкатывалось |
| Production rollout | Не выполнялся; нужны полная native coverage и согласованный выкат с остановленными writers при построении индекса |

Подробные результаты: [LOG089 native owner](log089/README.md), [LOG090 operation index](log090/README.md).
Следом завершаем native transaction boundary и покрытие writers, затем core/metadata/session.
Просмотр и экспорт относятся к ROB767, свои права — ROB766; обе задачи пока Backlog.

LOG091: [проверки расширенного native покрытия](log091/README.md);606 tests/24 suites PASS,27 новых PG tests. FilesFieldSync и batch owner mapping реализованы LOG092.

LOG092: [core File transaction/audit](log092/README.md),642 tests/25 suites PASS. Public valid-input parity сохранён LOG093; далее UPDATE owner; общий CRUD/merge/metadata/session/negative audit не готовы.

LOG093: [public input parity](log093/README.md),660 tests/25 suites PASS. Полные snapshots + operation-level explicit timestamp diff; FILES null без изменения прежнего core lifecycle.

LOG094: [public UPDATE owner](log094/README.md), 685 tests/26 suites PASS, 25 новых PG
cases. Реальные processors/repositories/permissions; root hooks после COMMIT,
inherited identity/workspace/actor proof и nested reads в том же executor. Создание
записей, mixed upsert, shareWith и custom nested creates требуют следующей реализации;
общая приёмка ROB765 не выполнена.

LOG095: [native CREATE kernel](log095/README.md), 716 tests/27 suites PASS, 31 новый PG
case. Actual inserted rows/defaults, mixed save/upsert и input capture до lookup;
реальная FK ошибка откатывает все writes. FILES create arrays добавлены LOG096;
public CREATE/другие объекты ещё не включены.

LOG096: [CREATE FILES](log096/README.md), 744 tests/27 suites PASS, 28 новых PG cases.
Actual-written parents и неизменность skipped File rows, full FILES-field readback,
mixed save/upsert, concurrent claim, trigger/core/audit rollback и unknown COMMIT.
Далее coverage связанных пользовательских записей и public CREATE; recordShare не
добавляется в generic CRM allowlist, собственные права остаются ROB766.
