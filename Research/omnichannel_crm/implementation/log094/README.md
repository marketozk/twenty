# LOG094 — атомарный аудит публичных обновлений

ROB765 остаётся In Progress. Обновления стандартных Company, Person и Opportunity
через Common UPDATE_ONE/UPDATE_MANY теперь автоматически получают strict transaction
и server-derived audit operation. Этими обработчиками пользуются четыре существующих
REST/GraphQL entry points. Сравниваются имя и standard universal identifier объекта.

Mutation, разрешение связей и nested reads используют один executor. Входящий scope
принимается только по identity регистрации действующего native audit owner; проверяются
workspace и actor. Копия, завершённый или legacy scope не дают обхода через обычный
repository. Ошибка scoped write отравляет owner, даже если вызывающий код её перехватил.
Nested writes объединяются по прежнему first-before/last-after контракту.

Root getters, visibility и awaited post-query hooks остаются после COMMIT. Ошибка
root hook по-прежнему возвращается вызывающему коду, но не отменяет committed mutation
и audit. Inherited hooks откладываются владельцем. Сбой подтверждения COMMIT остаётся
unknown: нет автоматического retry, ложного failed audit или postcommit hook.

## Проверки

- 685 тестов / 26 suites PASS, 159.3 s; 25 новых PostgreSQL tests.
- Реальные CommonUpdateOne/Many.execute, DataArgProcessor, RecordPositionService,
  FilterArgProcessor, GraphqlQueryParser, nested resolver, result getters, visibility,
  WorkspaceDataSource/Repository, permissions и SQL.
- User/API key/application/system actors; single/batch, реальные affected IDs;
  object/field permission denial; flush failure rollback; lost real COMMIT ACK.
- Inherited aggregation, actor/workspace mismatch, copied/expired/legacy scope;
  uncommitted nested read и полный rollback; root hook видит committed audit.
- Nested visibility, connect/disconnect, OPEN timestamps с микросекундами,
  missing single и empty batch; actual audit не содержит значений полей.
- 20 dependency guard tests и 6 migration guard tests PASS; dependency baseline PASS;
  десять migration checksums неизменны.
- Types: 332/333 roots, 189/189 существующих diagnostics, 0 новых или в изменённых файлах.
  Full-server typecheck не чистый. Пять uploaded/local LF hashes совпадают: [results](results.json),
  [types](typecheck-differential.json), [hashes](source-snapshot.json).

Fixture заменяет Nest DI tokens для внешних collaborators (hooks, quotas, metrics,
config/cache, file URL service) и направляет manager в настоящий actor-specific
datasource. SQL, permissions, validators и transformers не подменены. Полный HTTP/JWT
stack и подпись файловых URL этим набором не проверяются. FilesFieldSync имеет отдельные
проверки LOG092/093; здесь его общий regression набор тоже выполнен.

Первый запуск fixture потребовал изоляции Nest DI imports от AI/Enterprise графа.
Ожидания updatedAt и цепочки DB exception приведены к действующему поведению Twenty.
Тест connect исправлен на настоящий контракт `connect.where`; production resolver не
менялся. После общего прогона изменён только порядок новых imports.

[Targeted](target.log) · [Regression](regression.log) · [Review](review.md).
Новый образ и выкат не выполнялись; демо, коннекторы и отправки клиентам не менялись.
GitHub Actions не использовался.

## Остаток и следующий шаг

Каждый самостоятельный API-вызов получает новый operationId. Это не command receipt
и не гарантия идемпотентности повторного HTTP-запроса. Общий native CRUD/merge,
metadata/role/session owners, отрицательные события и health/alert ещё впереди.
Следом — native CREATE kernel с фактическими INSERT IDs и after snapshots. FILES,
ON CONFLICT, mixed upsert, nested custom creates и shareWith требуют отдельных
доказательств до автоматического включения публичного CREATE.
