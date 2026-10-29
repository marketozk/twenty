# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG122:

- Native audit для covered Company/Person/Opportunity и local custom objects: create/update, FILES, soft-delete/restore и внутренний hard-delete с покрытыми прямыми FK effects.
- Workspace sessions, предъявленный refresh signOut и workspace refresh issuance/rotation; security-first отзыв и DB recheck вместо доверия stale cache.
- Public/AI role CREATE/UPDATE и public member assignment с сериализацией demotions.
- Core membership cleanup с trusted API/job attribution, exact targets, actual FK effects и durable workflow-share recovery intent.
- Core account deactivation с fresh membership check, strict owner, audit savepoint и cache-finally.
- LOG119: production membership INSERT блокирует и проверяет active user в своей транзакции; обе очередности create/deactivate проверены. Locale UPDATE не восстанавливает удалённое членство.
- LOG120: email verification и admin flags используют narrow active updates; свежий last-admin check и обе очередности update/deactivate проверены.
- LOG121: private native member deletion и actual transitive FK effects; security-first audit savepoint, issued strict/exclusive scope и обе очередности FK races проверены.
- LOG122: передача подключённых аккаунтов и обоих channel types аудируется в strict core owner; fresh destination membership, exact JSONB precision, unknown COMMIT и security-first audit проверены.
- 10 неизменённых fork migrations; audit operation index при будущем выкате требует остановки writers.

1478 tests/47 suites PASS (233.545s); 90 targeted/2 suites PASS, 17 новых cases (15 PG, 2 service/caller). 26 guards PASS; 10 migration checksums неизменны. Types 365/366 roots, 189/189 прежних диагностик, 0 новых/changed-file. 9 local/remote source hashes совпадают.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/signup тест.

Далее — connected-account disconnection audit:
[следующая граница](implementation/log122/next-boundary.md).
Открыты account disconnect/delete, остальные native/system writers, real shares, public DESTROY/MERGE, остальные metadata/role/system writers, общий denied/failed audit и health/alert. Общая безопасность всех уже принятых запросов этим срезом не заявлена.

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–122 не выкатывался. Клиентские сообщения не отправлялись. GitHub Actions не используется.

- [Проверки LOG122](implementation/log122/README.md).
- [Критерии и остаток ROB765](implementation/rob765-progress.md).
- [Журнал разработки](DEVLOG.md).
