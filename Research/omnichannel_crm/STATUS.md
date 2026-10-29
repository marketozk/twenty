# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG120:

- Native audit для covered Company/Person/Opportunity и local custom objects: create/update, FILES, soft-delete/restore и внутренний hard-delete с покрытыми прямыми FK effects.
- Workspace sessions, предъявленный refresh signOut и workspace refresh issuance/rotation; security-first отзыв и DB recheck вместо доверия stale cache.
- Public/AI role CREATE/UPDATE и public member assignment с сериализацией demotions.
- Core membership cleanup с trusted API/job attribution, exact targets, actual FK effects и durable workflow-share recovery intent.
- Core account deactivation с fresh membership check, strict owner, audit savepoint и cache-finally.
- LOG119: production membership INSERT блокирует и проверяет active user в своей транзакции; обе очередности create/deactivate проверены. Locale UPDATE не восстанавливает удалённое членство.
- LOG120: email verification и admin flags используют narrow active updates; свежий last-admin check и обе очередности update/deactivate проверены.
- 10 неизменённых fork migrations; audit operation index при будущем выкате требует остановки writers.

1380 tests/45 suites PASS (209.814s); 69 targeted/3 suites PASS, 37 новых PG cases. 26 guards PASS; 10 migration checksums неизменны. Types 361/362 roots, 189/189 прежних диагностик, 0 новых/changed-file. 3 local/remote source hashes совпадают.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/signup тест.

Далее — private native workspaceMember cleanup audit:
[следующая граница](implementation/log120/next-boundary.md).
Открыты native member/transfers, real shares, public DESTROY/MERGE, остальные metadata/role/system writers, общий denied/failed audit и health/alert. Общая безопасность всех уже принятых запросов этим срезом не заявлена.

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–120 не выкатывался. Клиентские сообщения не отправлялись. GitHub Actions не используется.

- [Проверки LOG120](implementation/log120/README.md).
- [Критерии и остаток ROB765](implementation/rob765-progress.md).
- [Журнал разработки](DEVLOG.md).
