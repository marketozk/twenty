# Следующая работа — календарный orphan sweep

Выделить private stage из проверенного candidate owner и использовать его в
закрытом global owner. Сохранить live-only Event discovery, keyset по 500 UUID,
проверку живых Association после блокировок и actual RETURNING на каждой странице.
Накопленные snapshots и фактические эффекты проверять до дальнейших стадий,
перед единственным audit flush и после отложенных constraints.

Подключить CalendarEventCleanerService.cleanWorkspaceCalendarEvents и реальные
jobs: захватывать workspace/actor до ожиданий, передавать operation, использовать
strict/exclusive scope и сохранять unsafe outcome без следующей destructive стадии.
Предшествующий channel cleanup остаётся отдельной транзакцией: whole-job atomicity
не обещается. Provider expectedRun cleanup требует отдельной композиции.

Проверить 501+ Event, blocked и skipped строки, tombstone discovery parity,
сохранность CallRecording, отказ поздней страницы и audit, cross-page изменения,
реальные entrypoints. После этого продолжить provider-sync и core metadata writers.
