# Остаток после трёх раундов правок

26.10.2026. Итог: **needs_revision / escalate**, реализации новых функций ещё нет. Полные сценарии, сигналы и обратимость — [независимая сверка R4 B](claude-r4-reconciliation.md). [Реестр](registry.md) сохраняет все 46 причин и историю. 38 закрыты только в плане; 8 открыты. Этот документ предлагает следующий пакет, но не применяет четвёртую правку спецификации и не принимает риски за владельца.

| ID | Сценарий и последствия | Наблюдение / обратимость | Конкретная предлагаемая правка плана |
|---|---|---|---|
| N-1 major | Разрешённый workflow/ИИ сохраняет секретный клиентский контент; другой сотрудник читает историю запуска | Негативный API test показывает body; раскрытые данные не вернуть | Охватить workflowRun и AI thread/message/parts/turn/targets собственным derived ACL либо redaction+protected references; T08/T21 |
| N-13 major | Собственный ACL фактически опирается на Enterprise-marked helper | Source import/dependency test; технически обратимо, юридический вывод не установлен | Дополнить inventory, проверить текст лицензий, явно отделить own ACL от record-share; T20. Не просить подписку и не отключать защиту |
| N-14 major | После takeover новый workflow с ИИ создаёт отправку с новым epoch | Command/audit после human mode; отправку не отменить задним числом | Полная матрица sender×mode, provenance AI-контента, cancellation всех соответствующих non-human commands; T13/T24 |
| N-15 major | Несвязанная правка повышает workspace epoch и обрывает все операции; upgrade shared lock вызывает deadlock | Interrupted export/turn, 40P01; обратимо | Значение mismatch = reauthorize, explicit SHARE/UPDATE до начала операции, без lock upgrade; T10 |
| N-16 major | Import job не имеет API источника native/archive pages | Batch не может получить страницу; обратимо | Pull history contract с limited import credential/cursor/window/page hash, origin назначает только job; T11/T16 |
| M-7 minor | Hard throttle создаёт FAILED run с детерминированным ID, resume повторяет INSERT | FAILED/throttle error; явный reprocess возможен | Terminal throttled disposition, notification, explicit reprocess; T14 |
| L-2 minor | Таблица решений владельца не перечисляет все введённые настройки | Неожиданный activation denial; обратимо | Единая таблица gates с моментом выбора, ссылками на контракты и отсутствием implicit defaults |
| N-17 minor | expectedRevision сделки не связан с реальным CAS token | Обнаружится при реализации; обратимо | Выбрать core revision либо проверенный updatedAt contract, охватить все writers; T30 |

Цена продолжения: ограниченный пакет документальных исправлений и проверка затронутых исходников, затем свежий полный review и reconciliation. Прототип, перенос данных или деплой для этого не нужны. N-1/N-14 остаются open: необратимые нарушения не выносятся на принятие как «достаточно безопасно».

Применённый скилл cross-review-convergence требует: «начиная с четвёртого продолжай только с явного решения владельца». Первичное R1 + три fix-and-recheck выполнены (R2, R3, R4). Поэтому следующий запрос владельцу — разрешить четвёртый пакет исправлений и проверку, а не принять перечисленные дефекты или купить платную редакцию.

ROB-772 остаётся In Progress, ROB-764 Todo и заблокирована этой задачей. Работающий Twenty не менялся, реальные сообщения не отправлялись. Тесты T01–T33 описаны, не написаны и не пройдены.
