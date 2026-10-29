# LOG132 — аудит удаления сообщений без каналов

ROB765 остаётся In Progress. Внутренний owner принимает до 500 message IDs
в исходной strict/exclusive system-транзакции. Любая association, включая
soft-deleted, сохраняет сообщение; soft-deleted message также сохраняется.
Удаляется только фактический граф Message → MessageParticipant.

affectedThreadIds строится по before-images фактически удалённых сообщений.
Пропущенный триггером DELETE не создаёт ложный аудит и не добавляет чужой thread
в последующий reconciliation. Thread/Target этим owner не изменяются.

- [Результаты](results.json), [ревью](review.md), [следующая граница](next-boundary.md).
- [Точные исходники](source-snapshot.json), [целевые тесты](target.log).
- [Регрессия](regression.log), [типы](typecheck-differential.json).

Полный sweep пока не подключён. HTTP, сборка, выкат и GitHub Actions не выполнялись.
