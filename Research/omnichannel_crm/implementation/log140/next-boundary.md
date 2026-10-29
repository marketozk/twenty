# Далее — календарный provider cleanup

Подключить удаление Association и связанных orphan Event по expectedRun в
CalendarFetchEventsService и CalendarEventsImportService к одному закрытому
transaction owner. Использовать private stages, один context и final flush;
не вызывать terminal candidate facade внутри более широкой mutation.

Проверять текущий sync run, точные source IDs и связи после блокировок, actual
RETURNING и snapshots до дальнейших изменений. Сохранить stale-run refusal,
отсутствие дополнительных ограничений account ownership и текущую классификацию
удаляемых provider events. Unsafe outcome должен доходить до вызывающего задания
до изменения cursor, cache и статусов; общий error handler не должен его скрывать.

По коду import filter сначала исключает blocklisted events и из сохранения,
и из удаления; затем в удаление попадают отменённые либо private события при
excludePrivateEvents. Это правило сохраняется. ExpectedRun не доказывает
актуальность ранее прочитанных blocklist/aliases/privacy settings; новый аудит
mutation не должен объявлять эту существующую границу решённой.

Отдельно закрыть оставшийся public candidate wrapper либо документированно
устранить неиспользуемый путь после проверки всех call sites. Затем продолжить
core calendar metadata writers и остальные строки приёмки ROB765.
