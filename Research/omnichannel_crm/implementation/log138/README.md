# LOG138 — аудит удаления связей календарного канала

Удаление native calendarChannelEventAssociation после удаления канала использует
закрытый owner и одну strict/exclusive транзакцию с аудитом фактических DELETE.
Рабочее задание захватывает идентификаторы и системного автора до ожиданий,
передаёт operation в service и сохраняет unsafe error без последующей очистки.

Страницы по 500 проходят также пропущенные триггером строки. Tombstones сохраняются
в проверяемом снимке, но не удаляются. Event, Participant, Target и CallRecording
этот owner не изменяет. Неизвестные populated mutating FK effects отклоняются.

Поскольку calendar metadata writers пока не используют общий ownership fence,
owner удерживает SHARE lock таблицы core.calendarChannel до COMMIT. Это защищает
от INSERT/UPDATE/DELETE между доказательством отсутствия канала и завершением.
Цена — календарные изменения всех workspace ждут окончания очистки; ожидание
блокировок самим owner ограничено восемью секундами. Позднее создание после
COMMIT разрешено.

- [Ревью](review.md), [следующая работа](next-boundary.md).
- [Результаты](results.json), [исходники](source-snapshot.json), [целевые тесты](target.log),
  [регрессия](regression.log), [типы](typecheck-differential.json), [guards](guards.log).

Следующий global orphan sweep пока остаётся отдельным неаудированным путём.
ROB765 In Progress; полный calendar audit, HTTP/JWT, сборка и выкат не выполнены.
GitHub Actions не используется.
