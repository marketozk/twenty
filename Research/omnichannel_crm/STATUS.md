# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG127:

- Native audit для covered Company/Person/Opportunity и local custom objects: create/update, FILES, soft-delete/restore и внутренний hard-delete с покрытыми прямыми FK effects.
- Workspace sessions, предъявленный refresh signOut и workspace refresh issuance/rotation; security-first отзыв и DB recheck вместо доверия stale cache.
- Public/AI role CREATE/UPDATE и public member assignment с сериализацией demotions.
- Core membership cleanup с trusted API/job attribution, exact targets, actual FK effects и durable workflow-share recovery intent.
- Core account deactivation с fresh membership check, strict owner, audit savepoint и cache-finally.
- LOG119: production membership INSERT блокирует и проверяет active user в своей транзакции; обе очередности create/deactivate проверены. Locale UPDATE не восстанавливает удалённое членство.
- LOG120: email verification и admin flags используют narrow active updates; свежий last-admin check и обе очередности update/deactivate проверены.
- LOG121: private native member deletion и actual transitive FK effects; security-first audit savepoint, issued strict/exclusive scope и обе очередности FK races проверены.
- LOG122: передача подключённых аккаунтов и обоих channel types аудируется в strict core owner; fresh destination membership, exact JSONB precision, unknown COMMIT и security-first audit проверены.
- LOG123: отключение аккаунта сохраняет тот же strict owner, повторно проверяет caller на свежем account после внешних awaits; active membership, redaction authentication failures, cross-workspace impersonation и отсутствие отдельного nested commit проверены.
- 10 неизменённых fork migrations; audit operation index при будущем выкате требует остановки writers.

1657 tests/52 suites PASS (249.238s); 41 новых целевых PG cases/1 suite PASS (15.902s). 26 guard tests PASS; 10 migration checksums неизменны. Types 369/371 roots, 211/211 прежних диагностик, 0 новых/changed-file. 4 local/remote source hashes совпадают.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/signup тест.

Далее — подключение closed deletion owner к production callers:
[следующая граница](implementation/log127/next-boundary.md).
Открыты account delete callers, остальные native/system writers, real shares, public DESTROY/MERGE, остальные metadata/role/system writers, общий denied/failed audit и health/alert. Общая безопасность всех уже принятых запросов этим срезом не заявлена.

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–127 не выкатывался. Клиентские сообщения не отправлялись. GitHub Actions не используется.

- [Проверки LOG127](implementation/log127/README.md).
- [Критерии и остаток ROB765](implementation/rob765-progress.md).
- [Журнал разработки](DEVLOG.md).

LOG124 добавляет immutable attribution context после server authentication и переносит identity через install/upgrade/uninstall queue. Параллельные запросы изолированы, impersonator и initiator сохранены, legacy job не заимствует ambient actor. Это attribution, не проверка полномочий. OAuth/system wrappers добавлены в LOG125; account delete ещё впереди.
Upstream middleware: 10 tests PASS; четыре application suites имеют одинаковый ESM load failure на baseline/current. С явными адаптерами несвязанных DI-зависимостей: 20 tests/5 suites PASS. Full HTTP и выкат не выполнены.

LOG125 фиксирует OAuth user/impersonator в одноразовом коде и проверяет membership до auto-install; packaged install больше не маскируется bare fallback. Preinstalled/backfill/CLI/automatic upgrade имеют явный system source. Оба unknown transaction outcome типа проходят через install/upgrade без compensation и telemetry replacement.
LOG126 добавляет queue no-retry для recognized unknown/confirmed-commit failures. Crash/stall/manual retry этим ещё не защищены. Legacy OAuth codes без attribution требуют повторной авторизации; срок кода 5 минут. Выката нет.

LOG126 запрещает normal automatic queue retry для обоих unknown transaction errors и confirmed postcommit failure. Explorer не заменяет исходную ошибку при сбое telemetry. Install/upgrade не компенсируют confirmed committed effect. Actual Redis проверяет одну попытку, persisted failure, worker restart и ordinary retry; actual PG INSERT с падающим after-commit hook остаётся сохранённым.
Crash до persisted failure, stalled redelivery, manual retry и новый scheduled run остаются отдельными границами. Four-table primitive реализован в LOG127; далее callers. Выката нет.

LOG127 реализует closed four-table delete owner: account/messageChannel/calendarChannel/messageFolder, actual FK inventory, retained account и folder-only guards, exact DB snapshots, actual DELETE RETURNING и readback после audit. Сбой журнала откатывает удаление; повторное удаление recreated IDs получает новую operation. Production callers пока не переключены; далее их authorization/selection boundaries и wiring.
