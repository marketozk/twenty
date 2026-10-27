# LOG-051: workspace deletion admission

ROB-764 In Progress. Защищено начало удаления рабочей области и direct schema DROP.

## Поведение

WorkspaceService вызывает короткую admission transaction до любых membership,
application uninstall, metadata/schema/file effects. Exclusive native ownership
fence и workspace row lock сериализуют admission с первым bootstrap. Catalog
проверяет все core omni* tables с workspaceId, включая policy-only, inactive и
будущие retained tables. Неполный catalog и потеря SELECT → отказ.

Для обычной области сохраняется deletedAt=COALESCE(existing,DB clock), commit,
cache invalidation. Bootstrap проверяет workspace exists/not deleted до первого
policy INSERT. Долгую transaction вокруг cleanup не держим: nested native ORM
использует свои connections/shared fences. Hard delete проверяет billing перед
members; uninstall hooks получают обновлённый timestamp. Soft delete не меняет
его вторым UPDATE. При сбое billing/hooks/cache tombstone сохраняется.

WorkspaceSchemaService оставляет DDL lock и делегирует fenced drop: наличие
предварительного tombstone и отсутствие retained omni rows проверяются в одной
transaction с DROP SCHEMA. В случае lost COMMIT ACK результат unknown, cleanup
не продолжается, cache инвалидируется. Если cache тоже упал, обе причины сохранены.
Неподтверждённый commit/rollback уничтожает pg connection вместо возврата в pool.

## Проверка

1635 Jest /67 suites +26 guards = 1661 PASS.
18 новых PostgreSQL случаев и 13 owner-level проверок. База реальная, runtime role
с ограниченными правами. Проверены race в обе стороны с pg_locks wait, replay,
policy-only/future table retention, missing catalog/permission, lost ACK, failed
rollback и отсутствие leaked lock, direct DROP и сохранность чужой схемы.
Actual WorkspaceService/WorkspaceSchemaService/DestroySoftDeletedWorkspaceJob
проверены с изолированными DI dependencies: refusal до effects, billing/uninstall/
cache failure, точный timestamp для hooks, отсутствие false-success metrics.

Typecheck 216 roots: 162 baseline/current,
0 new/changed-code. Это дифференциальный затронутый граф, не весь server typecheck.
Enterprise dependency guard PASS; семь migration sources неизменны. Hashes
локальных и tested remote sources совпали. Scoped independent review: blockers
не найдены. Полный Claude review не повторялся.

[Full tests](tests.txt), [targeted](targeted-tests.txt), [verification](verification.json),
[typecheck](typecheck-differential.json), [source hashes](source-snapshot.json),
[dependency guard](dependency-guard.json).

## Найденное и границы

Первый прогон обнаружил неверную распаковку UPDATE RETURNING TypeORM:
исправлено по фактическому PostgresQueryRunner [rows,affected], проверяется affected=1.
Owner-test DI setup требовал изоляции unrelated ESM AI imports, production behavior
ради запуска тестов не меняли. Исходный unknown error сохраняется при cache failure.

Controlled purge не реализован; области с retained omni данными намеренно запрещено
удалять стандартным путём. Reopen после partially completed cleanup запрещён;
нельзя вручную снимать deletedAt. Для обычной области устранить причину и повторить
штатную очистку с исходным timestamp. Проверка billing до effects сохраняет запрет
hard delete активной подписки. Cleanup старого кода сам по себе не стал atomic.
Trusted administrator raw SQL/ручной DROP вне этой boundary. Direct drop callers
теперь обязаны проходить admission; публичного обходного API нет.

Далее metadata check/write против first bootstrap; lifecycle с внешними hooks
разбирается отдельно, archivedAt сам по себе не monotonic guard. Затем итоговые
ROB-764 acceptance/T22. ACL, полный audit, UI, transport и AI — следующие этапы.
Демо/маршруты не менялись; GitHub Actions не использовался.
