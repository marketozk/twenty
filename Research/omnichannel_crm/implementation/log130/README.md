# LOG130 — аудит очистки связей удалённого канала

ROB765 остаётся In Progress. Этот участок подключает фактический worker удаления
канала к атомарному аудиту associations и их folder junctions. Последующая очистка
самих сообщений/диалогов и согласование CRM-связей ещё не покрыты.

Обработчик фиксирует workspace/channel до ожидания и создаёт системную operation
с собственным именем. Owner требует исходный strict/exclusive transaction scope,
активное workspace и отсутствующий core channel. Сохранённые Omni-связи и обычные
soft-deleted associations остаются на месте. Проверяются реальные FK, фактические
DELETE RETURNING и полный оставшийся граф до и после записи аудита.
Обязательная FK-связь с folder junction проверяется по PostgreSQL. Общий ownership
guard теперь учитывает и прямой messageThreadId, включая association без messageId.

Обычные события удаления сохранены и отправляются после commit. Исправлен общий
repository: при частично пропущенном DELETE события содержат только действительно
удалённые ID; внутренний RETURNING id не меняет выбранный вызывающим кодом результат.
Сбой обычного after-commit callback по прежнему контракту логируется; успешный commit
не превращается в rollback. Надёжная доставка событий этим не реализована.

Проверки и границы:

- [Результаты](results.json), [разбор и исправления ревью](review.md).
- [Исходники и локальные/удалённые хэши](source-snapshot.json).
- [Целевые тесты](target.log), [регрессия](regression.log), [типы](typecheck-differential.json).
- [Следующий участок](next-boundary.md): orphan cleanup и reconciliation.

GitHub Actions, полный HTTP, сборка образа и выкат не выполнялись.
