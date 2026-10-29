# LOG141 — provider cleanup и сохранение unsafe outcomes

Изучены CalendarFetchEventsService, CalendarEventsImportService, реальный
CalendarEventImportErrorHandlerService, прежний cleaner и lockOrdinaryNativeSyncRun.
Два consumer передают захваченного named system actor и копию admitted run.
Закрытый owner объединяет точные Association DELETE и связанные orphan Event
в одну strict/exclusive транзакцию и один audit context.

## Полномочия и исходные данные

Сохраняются проверки существующего expectedRun helper, включая его текущий
account ownership gate. Дополнительно проверяется неизменность его несекретных
полей полномочий до и после audit/deferred boundary. Initial stale run возвращает
false; позднее изменение вызывает откат. Провайдерные токены в снимки не попадают.

До удаления Association блокируется и снимается исходный граф пяти таблиц.
Это не позволяет триггеру первой стадии изменить Event или CallRecording,
а следующей стадии принять изменённые данные за первоначальные. Все фактические
Association удаления выполняются до обработки уникальных Event IDs. Допуск
последующих каскадов определяется только проверенным Event RETURNING, после
проверки прежних снимков перед следующей стадией.

Первые runtime проверки выявили два нарушения прежнего поведения при раннем
переназначении канала/external ID. Исправление сохраняет такие связи и пропускает
их при выборе удаления; original IDs остаются в последующих проверках.
Изменение Event-parent по-прежнему отклоняется. Legacy assertions не ослаблены.
Отдельно исправлена тестовая core projection: nullable archivedAt требуется
настоящему bootstrap. Bootstrap и проверка retained binding не подменялись.

Добавлены три PG случая: 501 Association с одним внешним ID, однократный аудит
matching tombstoned source при каскаде и отказ скрыть её промежуточное изменение.
В первом тесте исправлено чтение query-object.values в наблюдателе запросов.
Первые targeted проверки: 111 тестов в трёх наборах прошли.

Расширенная регрессия обнаружила два устаревших messaging test doubles:
они возвращали boolean вместо действующего NativeMessageCleanupResult | null.
Production caller уже в HEAD проверял null; его поведение не менялось.
Подстановки приведены к реальному контракту и получили явный return type;
assertions о запрете cursor/completion оставлены прежними. Повторные targeted
проверки: 462 теста в четырёх наборах прошли, включая весь omni-sync-status.

## Ошибки и совместимость

Обе consumer catch и центральный error handler проверяют isTransactionUnsafeToRetry
до логирования и изменения статуса. В частности, CoreAuditPostCommitError больше
не превращается в обычную CalendarEventImportException с возможностью повтора.
Существующий queue classifier сохраняется; новый retry механизм не добавляется.

Pure import filter не менялся: blocklisted events исключаются из обоих наборов,
затем canceled/private-with-exclusion попадают в removal. Отдельно выполнены
три существующих upstream unit cases этого helper.
Неиспользуемый public candidate service wrapper и прежний private helper удалены
после проверки всех call sites; standalone audited candidate API LOG139 сохранён.

Независимое чтение owner, исправления и consumers конкретных блокеров не выявило.
Итоговые runtime/typecheck результаты сохраняются отдельно в results.json.

## Ограничения

ExpectedRun не доказывает актуальность ранее прочитанной blocklist/privacy policy.
Предшествующие cache pop и provider saves находятся вне cleanup транзакции.
Страницы по 500 ограничивают отдельные запросы, а не общий объём снимков/блокировок.
Произвольные raw-SQL phantom после последней проверки не объявляются покрытыми.
Provider save audit, core calendar metadata writers, durable delivery и полная
HTTP/JWT приёмка остаются дальнейшей работой. Выкат не выполнялся.
