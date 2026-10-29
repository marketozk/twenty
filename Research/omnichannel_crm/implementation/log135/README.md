# LOG135 — адресная очистка связей и переписки

Внутренний terminal owner deleteNativeMessageAssociationsAndRelatedOrphansWithAudit
принимает исходный issued strict/exclusive system scope, обязательную operation,
channel ID и список external IDs. Captured входы не меняются после первого await.
Проверяет живой workspace, account/channel и прямые omni bindings; затем удаляет
только выбранные живые обычные associations и их junctions. Только фактически
удалённые before-images дают кандидатов Message, а фактические Message effects —
кандидатов Thread. Существующие private stages выполняют reconciliation и удаление
пустых threads. Один audit context и одна финализация включают весь граф.

LOG130 по-прежнему требует отсутствующего канала. Новый owner разрешает живой
обычный канал; это внутренний mutation boundary, не замена caller authorization.
Production callers ещё не переключены: expectedRun, group, folder, draft и
blocklist требуют своих проверок и общей финализации после последней записи.

- [Ревью](review.md), [следующая работа](next-boundary.md).
- [Результаты](results.json), [исходники](source-snapshot.json), [целевые тесты](target.log),
  [регрессия](regression.log), [типы](typecheck-differential.json), [guards](guards.log).

ROB765 остаётся In Progress. Выкат, полный HTTP/JWT и GitHub Actions не выполнялись.
