# LOG147 — цели переписки после привязки компании

Проверки узкого шага завершены. ROB765 In Progress.
[Исследование](../log146/next-boundary.md), [решение](../log146/next-design.md),
[ревью решения](../log146/next-design-review.md).

Оставшийся messaging loop ReconcilePersonCompanyTargetsJob переведён через
существующий сервис на закрытые страницы по 200 кандидатов. Повторно используется
native message audit session и target stage; новый частный selector не меняет
прежние direct thread-ID callers. Новые DI-провайдеры и миграции не нужны.

Источники Person/Company/Opportunity защищены SHARE до discovery. Точные исходные
Participant/Person/Message/Thread сохраняются и повторно проверяются после
блокировок родителей. Перемещённые/удалённые hints пропускаются; обе стороны
planner ограничены допущенными Thread. Исходные строки и их отсутствие сохраняются
в отдельной проверке, которая выполняется до DML и после deferred drain.

Цели вычисляются по всем живым участникам допущенного диалога. Ручные назначения,
tombstones и фактическое omni ownership сохраняются. Ordinary APP остаётся
допустимым; перенят прежний контракт native owner: удалённый Thread не изменяется.
Generated target effects по-прежнему могут приводить к явному отказу: новая
поддержка таких изменений этим шагом не заявляется.

Messaging pages выполняются раньше calendar pages, cursors независимы. Каждый
commit и audit отдельны; успешные ранние страницы не откатываются вместе с поздней.
При потере COMMIT ACK исключение проходит неизменным, календарь не запускается.
Общая атомарность задания и надёжная доставка очереди остаются открытыми.

2804 tests/86 suites PASS (551.4s). 142 targeted/5 suites PASS (61.992s), 19 новых PG cases. 26 guard tests PASS, 10 migration checksums неизменны. Types 426/427 roots, baseline/current 225 diagnostics, 0 новых/changed-file. Совпали 5 local/remote source hashes.

[Результаты](results.json), [сверка исходников](source-snapshot.json), [ревью](review.md).
Первое расширение тестов выявило ошибку наблюдателя pg QueryConfig, исправлен
доступ к statement.values. Семь type diagnostics относились к объявлению одного
асинхронного тестового помощника. После исправлений проверки завершились успешно.

Общая HTTP/JWT приёмка и выкат остаются открытыми. Далее — [messaging rematch](next-boundary.md).
