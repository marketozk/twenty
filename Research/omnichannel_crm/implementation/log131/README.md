# LOG131 — аудит удаления пустых диалогов

ROB765 остаётся In Progress. Добавлен внутренний owner удаления до 500 пустых
native threads с фактическими каскадами targets, associations и folder junctions.
Любое сообщение, в том числе soft-deleted, сохраняет thread. Защищённая дочерняя
запись сохраняет весь родительский граф.

Owner проверяет исходный strict/exclusive system scope, активное workspace,
обязательные реальные FK, ownership, точные снимки и DELETE RETURNING. События
удаления сохраняют прежнее поведение. Диалог, message и participant, на которые
association ссылается независимо от удаляемого thread, остаются неизменными.

Найдена и исправлена граница отложенных constraint triggers: LOG130 и LOG131
выполняют их до финальной сверки, чтобы изменение при COMMIT не обходило аудит.
Владельцы транзакции обязаны передавать ошибку наружу и сохранять проверенный граф.

- [Результаты](results.json), [ревью и ограничения](review.md).
- [Исходники и совпадение хэшей](source-snapshot.json).
- [Целевые тесты](target.log), [регрессия](regression.log), [типы](typecheck-differential.json).
- [Следующие действия](next-boundary.md).

Полный orphan sweep ещё не подключён: сначала нужны аудит message/participant
cleanup и target reconciliation, затем общий transaction owner. HTTP, сборка,
выкат и GitHub Actions не выполнялись.
