# LOG092 — независимое read-only review

Проверены same-executor file port, FilesFieldSync integration, native single/batch
paths, crmFile security descriptor и PG regressions. Исходный research обнаружил
batch diff по payload.id; authoritative input.id теперь задаёт owner, повторные
record/File owners в файловом batch отказаны.

Первый implementation review нашёл postcondition gap: RETURNING parent id не
доказывает фактическую запись FILES списка при DB trigger. Исправлено final readback
core rows и полного native parent FILES списка тем же executor. Audit использует
final actual File snapshot; missing/extra IDs и неверный temporary/deleted state
откатывают owner. Attach/remove RETURN OLD.documents и core temporary-preservation
PG tests добавлены. Повторный review подтверждённых блокеров не нашёл.
Reviewer не менял файлы и не запускал тесты; проверки основного исполнителя отдельно.

## Следующий public UPDATE срез — подтверждённые стыки

REST update-one/many handlers и GraphQL resolver factories вызывают execute без
transactionScope. UpdateOne.run делегирует UpdateMany.run; merge работает напрямую
с scoped repositories, nested create вызывает CreateMany.execute. Public UPDATE
трёх standard objects можно включать отдельно от merge/create/delete.

CommonBase owner: после existing validation/process/pre-hooks/metering —
executeInWorkspaceContext, strict nativeAudit scope, scoped prepare+run. После
собственного commit — getters/visibility/post-hooks в прежнем awaited режиме.
Нельзя механически передать scope во весь enrichment: hook errors тогда swallowed
через datasource afterCommit вместо прежнего propagated error. Inherited scope
требует server-issued proof audit owner + active/workspace/actor, без nested commit
или fallback. UpdateMany nested helper уже принимает repository; передать scoped
repository, иначе он создаёт независимый read connection и видит старые данные.

Перед включением проверить parity: public FILES validator принимает null, текущий
LOG092 internal opt-in только arrays; нужны явные null-clear semantics и тесты.
Системные timestamps и остальные valid public input types проверить по validators,
GraphQL input factories и actual public-runner tests. Это не готовая API интеграция.
