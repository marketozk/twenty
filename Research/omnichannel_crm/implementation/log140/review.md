# LOG140 — единый аудит календарного sweep и его заданий

Исследованы прежний CalendarEventCleanerService, все три production callers,
LOG139 owner и существующий private-stage pattern очистки сообщений. Выделен
модуль native-calendar-cleanup-with-audit с закрытыми session/stage/finalize.
Наружу экспортируются только terminal candidate и workspace sweep. Прежний
candidate facade и контракт явно выбранных tombstoned Event сохранены.

## Многостраничная транзакция

Global discovery выбирает только live Event через keyset500 и FOR UPDATE.
Курсор продвигается через защищённые и trigger-skipped корни. Все страницы
используют один original strict/exclusive scope, operation и audit context.
Перед снимком следующей страницы проверяются postimages предыдущих; финальные
проверки выполняются до единственного flush и после SET CONSTRAINTS ALL IMMEDIATE.

Фактические RETURNING определяют агрегированные IDs. Сохранение CallRecording
из LOG139, exact FK graph и запрет неучтённых косвенных effects не меняются.
Тест на 501 корень проверяет нулевое число audit rows после первой страницы
через то же соединение транзакции: отдельное соединение не обнаружило бы
ошибочный ранний flush. Поздний отказ откатывает изменения обеих страниц.

Дополнительно проверена реальная гонка двух соединений: чужой soft-delete
начат раньше discovery и удерживает Event. После наблюдаемого PostgreSQL Lock
и COMMIT другой транзакции sweep повторно оценивает live predicate, сохраняет
весь tombstoned граф и не пишет mutation audit. Итоговый targeted run —
88 тестов в пяти наборах, включая этот сценарий и прежние LOG138/139 cases.

## Подключение

Service требует auditOperation, копирует actor/initiator до ожиданий, проверяет
workspace context/scope и сохраняет Promise<void>. Channel deletion job всегда
запускает sweep после успешной первой стадии, даже при нуле удалений. Два owner
используют разные операции с общей correlation, оставаясь разными транзакциями.
Account cleanup остаётся workspace-wide, calendar blocklist — orphan-only;
участие заблокированного контакта не становится причиной удаления встречи.

Три задания используют захваченного named system actor. Unsafe outcome сохраняется
без catch/retry/продолжения. Entry tests подменяют terminal boundaries, сохраняя
настоящий control flow service/jobs; PG cases проверяют настоящий owner.
Независимое чтение замороженных TEMP-файлов конкретных блокеров не выявило.

## Ограничения

Это один проход, а не fixed point: произвольные новые строки позади курсора
повторно не сканируются. Снимки и блокировки удерживаются до конца sweep.
Provider expectedRun cleanup, его старый private helper и неиспользуемый public
candidate service wrapper пока не подключены к новому аудиту. Core calendar
metadata writers и durable queue/postcommit delivery остаются открытыми.
Сборка, выкат и полная HTTP/JWT приёмка не заявляются.
