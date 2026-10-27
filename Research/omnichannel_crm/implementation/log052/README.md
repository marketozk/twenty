# LOG-052: atomic core metadata mutations

ROB-764 In Progress. Закрыты pure DB account/channel mutations, не весь lifecycle.

## Изменение

ConnectedAccountMetadataService.update, MessageChannelMetadataService.create/update/
delete и APP create/update/delete используют один core transaction manager.
READ COMMITTED + shared native fence до row locks исключает first-bootstrap gap.
Account IDs блокируются в стабильном порядке; после channel FOR UPDATE parent
сверяется с первоначальным. Source/destination ownership, APP application/provider/
scope/custodian читаются заново. Другой pool для проверки/записи не используется.
Nested pre-existing transaction отвергается, чтобы не брать fence после чужих locks.

Generic create отклоняет id и relation objects workspace/connectedAccount/messageFolders;
parent проверяется внутри workspace и не может быть omni-owned. APP no-op update
остаётся read-only. Missing/foreign-workspace/foreign-app parent отвечают одинаково.
Delete event публикуется после успешного commit; SQL/ownership failure откатывает
изменения и не посылает event. Lost ACK не выдаётся за подтверждённый success.

## Доказательства

244 tests /9 affected suites +20 dependency +6 checksum tests =270 PASS.
29 новых PostgreSQL проверок actual metadata services/TypeORM repositories:
обе очередности bootstrap vs rename/archive/channel delete/create, destination
ownership race, stale source parent, свежие APP permission поля, opposite reparents
без deadlock, foreign workspace, relation injection, permission/SQL failure,
postcommit visibility на втором connection, lost ACK и ordinary EMAIL/EMAIL_GROUP/
APP behavior. Сохранены44 прежних unit cases; fake transaction manager моделирует
только DI, реальные row/advisory locks проверяются отдельно на PostgreSQL.

Typecheck219 roots:162 baseline/current,0 new/changed-code. Полный server typecheck
не выполнялся. Enterprise guard PASS; семь migrations неизменны; tested/local
source hashes совпали. Полный1635-test suite LOG051 прошёл на предыдущем коде;
для этого ограниченного diff запущены9 релевантных suites, full suite не повторялся.

[Tests](tests.txt), [verification](verification.json), [typecheck](typecheck-differential.json),
[source snapshot](source-snapshot.json), [dependency guard](dependency-guard.json).

## Исправления по проверкам

Первый PG run требовал UUID DEFAULT у тестовой native core таблицы; исправлена fixture.
Typecheck нашла union Promise только в test capture; исправлен тип без any.
Independent review нашёл APP missing/unreachable error disclosure. Теперь typed
missing-account error преобразуется только в прежний APP not-found; прочие SQL и
ownership errors не маскируются. Paired PG regression проходит. Полный Claude pass
не повторялся.

## Границы и дальнейшая работа

Network disconnect/transfer/deleteMany с hooks/revoke и существующие reconnect/
background writers ещё требуют согласованного протокола. archivedAt может быть снят
reconnect; считать его вечным admission нельзя. Рассматривается native APP-only
identity с explicit CAS reconnect и DB-only native lifecycle, но это следующий код.
Generic resolver updateMessageChannel отдельно изменяет pendingGroupEmailsAction
перед service.update; это следующий owner, не покрытый данным diff.

Ordinary postcommit metadata events сохраняют legacy delivery: lost ACK может
оставить committed ordinary mutation без event. Durable omni effects идут своим
DomainEvent/outbox; generic mutation owned records запрещена. Это изменение не
расширяет blanket event reliability guarantee.

Rollback: остановить новые metadata callers, вернуть согласованный полный Git
снимок; schema changes нет. Возврат старого кода снова открывает SELECT/write gap
и не является безопасной production стратегией при активных bindings.
Публичный API, ACL/UI и transport не включались. Демо, SaleBot и внешние маршруты
не менялись. GitHub Actions не использовался.


Дополнительная проверка до публикации: фактический TypeORM0.3.31 EntityManager.transaction
глотает rollback error и возвращает connection через release. Для новых locks это
могло оставить открытый transaction в pool. Проверенный LOG051 owner вынесен в общий
omni-core-transaction; metadata использует свежий QueryRunner и runner.manager,
workspace wrapper сохраняет прежний UnknownError. READ COMMITTED явный, commit/release
unknown типизирован, rollback failure агрегирует причины и уничтожает connection.
Новый PG case подтверждает освобождение account lock запросом второго connection;
lost ACK не вызывает success event. Extraction отдельно просмотрена, blockers не найдены.
Финальный affected run244/9 +26 guards=270 PASS; typecheck219 roots162/162,0new/changed.
