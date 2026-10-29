# LOG138 — проверка календарных association

Исследованы CalendarEventCleanerService, CalendarChannelDeletionCleanupJob,
CalendarChannelMetadataService, core/native metadata и существующий owner LOG130.
Native calendarChannelId — UUID без межсхемного FK; отсутствие core канала
нельзя доказывать только однократным SELECT при существующих unfenced writers.

## Изменение и проверка

Используются issued SYSTEM scope, exact standard metadata, active workspace,
workspace-first lock order, core calendar table SHARE и native table DDL fence.
Полные snapshots сохраняются до DELETE; actual RETURNING определяет журнал.
Итоговый граф, включая retained/tombstoned rows и исходные IDs, проверяется
до audit flush и после SET CONSTRAINTS ALL IMMEDIATE.

Независимое чтение owner не выявило новых actionable findings в этой границе.
Проверены реальные обе очередности INSERT канала, 501 строка, частичный skip,
отказ второй страницы, audit/deferred изменения, unsupported FK, lost COMMIT ACK
и запрет удаления для живого канала другой workspace.

Service/job tests используют реальный control flow с mock только на terminal owner.
Они проверяют captured IDs/actor, strict options, workspace mismatch и остановку
перед global sweep при unsafe outcome. Первый typecheck нашёл четыре ошибки
только в тестовом wrapper remove; явный async сохраняет настоящий Promise-контракт.

## Ограничения

SHARE lock блокирует DML core.calendarChannel во всех workspace до COMMIT.
При будущем расширении writers этот lock можно заменить доказанным общим fence,
но текущий absent-channel proof без блокировки был бы недостаточен.

Не покрываются произвольные trigger writes вне отслеживаемого графа, durable
доставка postcommit событий, core calendar metadata audit и следующий orphan sweep.
Полный orphan Event graph включает Target CASCADE и CallRecording SET NULL;
это отдельная следующая работа, а не скрытая часть удаления association.
