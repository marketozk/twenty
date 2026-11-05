# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG153:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG153 закрывает долговечное намерение и восстановление post-save сопоставления календаря (`reconcile_calendarImportMatching` в `core.deferredWorkspaceMigrationAction`): `CalendarSaveEventsService` сохраняет и верифицирует `PENDING`-намерение внутри strict/exclusive транзакции сохранения до `COMMIT`, `MatchParticipantService.matchCalendarImportParticipantsWithAudit` координирует `IN_PROGRESS` и атомарно удаляет завершённое намерение до `COMMIT`, изолирует `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError` в `FAILED` с `payload.unsafeOutcome`, а `reconcileCalendarImportMatchingIntentsWithAudit` воспроизводит незавершённые намерения с проверкой актуальных `core.workspace`, `core.connectedAccount`, `core.calendarChannel` и отсутствия привязки к omnichannel.

3007 tests/98 suites PASS (644.622s). 711 targeted/17 suites PASS (163.942s), 12 новых PostgreSQL и 1 unit случай. 26 guard tests PASS, 10 migration checksums неизменны. Types 446/447 roots, baseline 219 / current 219 diagnostics, 0 новых/changed-file. Совпали 6 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG153](implementation/log153/results.json) · [исходники и ревью](implementation/log153/README.md).

Контур сохранения, автосоздания контактов/компаний и долговечного post-save сопоставления для сообщений и календаря закрыт (`LOG143`–`LOG153`). Интеграция общего runner/recovery отложенных действий с намерениями сопоставления импорта, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - интеграция runner/recovery отложенных действий с намерениями сопоставления импорта.
[Следующая граница](implementation/log153/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–153 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
