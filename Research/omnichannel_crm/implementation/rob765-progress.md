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

Последние проверки: 1836 tests/59 suites PASS (294.057s); 100 targeted/3 suites PASS (37.568s), 30 новых cases. 26 guard tests PASS; 10 migration checksums неизменны. Types 382/384 roots, 225/225 прежних диагностик, 0 новых/changed-file. 2 local/remote source hashes совпадают.
Это не чистый full-server typecheck. [LOG132 results](log132/results.json).

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
LOG121: private native member writer имеет issued strict/exclusive scope, actual
transitive FK audit и mandatory verification вне security-first savepoint. Полное
public removal, physical file cleanup и отдельные transfers этим не приняты.
LOG122 добавляет connected-account transfer audit вместе с обоими channel types,
active membership locks, exact JSONB snapshots и unknown COMMIT. Внешние hooks/revoke
не становятся атомарными с БД; real shares остаются открытыми.
[Следующая граница](log122/next-boundary.md) — account disconnection audit.

LOG123 добавляет disconnect audit и свежую проверку administration после внешних
awaits: workspace/caller membership/account/channel locks, exact DB snapshots,
credential/auth failure cleanup и security-first savepoint. Caller/identity
сохраняются до awaits; cross-workspace impersonation не теряет инициатора.
[Следующая граница](log123/next-boundary.md) — account deletion и фактический core FK graph.

LOG124 добавляет immutable attribution context после server authentication и переносит identity через install/upgrade/uninstall queue. Параллельные запросы изолированы, impersonator и initiator сохранены, legacy job не заимствует ambient actor. Это attribution, не проверка полномочий. OAuth/system wrappers добавлены в LOG125; account delete ещё впереди.
Upstream middleware: 10 tests PASS; четыре application suites имеют одинаковый ESM load failure на baseline/current. С явными адаптерами несвязанных DI-зависимостей: 20 tests/5 suites PASS. Full HTTP и выкат не выполнены.

LOG125 фиксирует OAuth user/impersonator в одноразовом коде и проверяет membership до auto-install; packaged install больше не маскируется bare fallback. Preinstalled/backfill/CLI/automatic upgrade имеют явный system source. Оба unknown transaction outcome типа проходят через install/upgrade без compensation и telemetry replacement.
LOG126 добавляет queue no-retry для recognized unknown/confirmed-commit failures. Crash/stall/manual retry этим ещё не защищены. Legacy OAuth codes без attribution требуют повторной авторизации; срок кода 5 минут. Выката нет.

LOG126 запрещает normal automatic queue retry для обоих unknown transaction errors и confirmed postcommit failure. Explorer не заменяет исходную ошибку при сбое telemetry. Install/upgrade не компенсируют confirmed committed effect. Actual Redis проверяет одну попытку, persisted failure, worker restart и ordinary retry; actual PG INSERT с падающим after-commit hook остаётся сохранённым.
Crash до persisted failure, stalled redelivery, manual retry и новый scheduled run остаются отдельными границами. Далее — strict four-table account deletion primitive, затем callers. Выката нет.

LOG127 реализует closed four-table delete owner: account/messageChannel/calendarChannel/messageFolder, actual FK inventory, retained account и folder-only guards, exact DB snapshots, actual DELETE RETURNING и readback после audit. Сбой журнала откатывает удаление; повторное удаление recreated IDs получает новую operation. Production callers пока не переключены; далее их authorization/selection boundaries и wiring. [Следующая граница](log127/next-boundary.md).

LOG128 добавляет обязательные captured deletion boundaries для administration/emailGroup/manifest/providerScopeRepair и locked membership/provider prerequisites. Actual CLI/upgrade runners дают исторической команде одноразовый scoped source по точной registered metadata; detached work лишается source после завершения. Старый command не изменён. Account service callers ещё не переключены; финальный provider cascade guard и require-all effects входят в ближайшее wiring. [Следующая граница](log128/next-boundary.md).

LOG129 подключает production account deletion к closed audit owner: caller/manifest/email-group/repair boundaries, сохранённый handle, fresh checks и фактические RETURNING IDs. Non-administrative deletion требует полного результата внутри транзакции; provider handler блокирует captured ID и отказывает при любых оставшихся account refs. Синхронный сбой событий после COMMIT сохраняет unsafe classification. Старый command не изменён.
1729 tests/55 suites PASS (261.127s); 309 targeted/8 suites PASS (44.631s), 42 новых cases. 26 guard tests PASS; 10 migration checksums неизменны. Types 380/382 roots, 229/229 прежних диагностик, 0 новых/changed-file. 17 local/remote source hashes совпадают. [Проверки](log129/results.json). Production callers подключены; native cleanup и durable delivery ещё открыты. [Следующая граница](log129/next-boundary.md). ROB765 In Progress; выкат не выполнялся.


LOG130 подключает аудит фактической очистки associations удалённого канала и их folder junctions: именованный worker actor, исходный strict/exclusive scope, active workspace, обязательный FK, exact snapshots/RETURNING и повторные проверки ownership. Сохранены soft-deleted roots и прежние after-commit события; исправлены ложные события при trigger-skipped DELETE. Общий guard учитывает прямую association.messageThreadId, в том числе при null messageId.
1771 tests/57 suites PASS (270.446s); 162 targeted/5 suites PASS (49.856s), 42 новых cases. 26 guard tests PASS; 10 migration checksums неизменны. Types 379/382 roots, 225/225 прежних диагностик, 0 новых/changed-file. 9 local/remote source hashes совпадают. [Проверки](log130/results.json). ROB765 In Progress. Последующий orphan sweep, reconciliation, calendar cleanup и durable dispatch остаются открытыми. После LOG088 выкат не выполнялся; GitHub Actions не использовался. [Далее](log130/next-boundary.md).

LOG132 добавляет внутренний owner удаления сообщений без каналов с аудитом фактических Message/Participant effects. Любая association, включая soft-deleted, сохраняет сообщение. affectedThreadIds формируются только из реально удалённых before-images. Проверены required FK, snapshots/RETURNING, concurrent inserts, rollback/unknown, late ownership и deferred triggers.
1836 tests/59 suites PASS (294.057s); 100 targeted/3 suites PASS (37.568s), 30 новых cases. 26 guard tests PASS; 10 migration checksums неизменны. Types 382/384 roots, 225/225 прежних диагностик, 0 новых/changed-file. 2 local/remote source hashes совпадают. [Проверки](log132/results.json). ROB765 In Progress. Message owner пока не подключён к полному orphan sweep: впереди target reconciliation и закрытый общий transaction owner. Код после LOG088 не выкатывался; GitHub Actions не использовался. [Далее](log132/next-boundary.md).
