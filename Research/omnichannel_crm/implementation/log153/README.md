# LOG153 - долговечное намерение и восстановление сопоставления календаря после сохранения

Проверки доработки завершены. ROB765 остаётся In Progress.
[Дизайн](design.md), [ревью решения](design-review.md), [ревью кода](review.md), [план проверок](test-research.md).

LOG153 закрывает окно долговечности между сохранением событий календаря (`CalendarSaveEventsService.saveCalendarEventsAndEnqueueContactCreationJob`, `LOG143`) и последующим сопоставлением участников и целей (`CalendarEventParticipantService.matchParticipantsAndEnqueueContactCreationJob` -> `MatchParticipantService.matchCalendarImportParticipantsWithAudit`, `LOG144`).

Внутри strict/exclusive транзакции сохранения событий при наличии непустых `calendarEventIds` или `savedParticipantIds` в `core."deferredWorkspaceMigrationAction"` записывается намерение `reconcile_calendarImportMatching` в статусе `PENDING` с проверенным `CalendarImportMatchingIntentPayload` (`operation` с `causationId` операции сохранения, `authority` канала и аккаунта, `participantIds`, `eventIds`). Строка намерения верифицируется в `verifySaveGraph` до `audit.flush()` и после `SET CONSTRAINTS ALL IMMEDIATE`.

При штатном выполнении и фоновом восстановлении (`reconcileCalendarImportMatchingIntentsWithAudit` / `CalendarEventParticipantService.reconcileCalendarImportMatchingIntents`) намерение переводится в `IN_PROGRESS`, блокируется `FOR UPDATE` внутри `prepareCalendarMatching`, проверяется на неизменность на каждом шаге обновления `calendarEventParticipant` и `calendarEventTarget`, атомарно удаляется перед `audit.flush()` и повторно проверяется на отсутствие после `SET CONSTRAINTS ALL IMMEDIATE`. При восстановлении проверяются актуальные `core.workspace`, `core.connectedAccount`, `core.calendarChannel` и отсутствие привязки к omnichannel (`findOmniOwnedConnectedAccountIds`). Неопределённые исходы (`NativeTransactionOutcomeUnknownError`, `CoreAuditPostCommitError`) изолируются в `FAILED` с `payload.unsafeOutcome` через `jsonb_set`.

3007 tests/98 suites PASS (644.622s). 711 targeted/17 suites PASS (163.942s), 12 новых PostgreSQL и 1 unit случай. 26 guard tests PASS, 10 migration checksums неизменны. Types 446/447 roots, baseline 219 / current 219 diagnostics, 0 новых/changed-file. Совпали 6 local/remote source hashes.

[Результаты](results.json), [сверка исходников](source-snapshot.json),
[типы](typecheck-differential.json), [регрессия](regression.log).

Начальный путь импорта `findOmniOwnedConnectedAccountIds`, нумерация параметров SQL при сбросе `IN_PROGRESS -> PENDING` и две первичные ошибки типов в тестах устранены и сохранены в логах.

Далее - [интеграция runner/recovery отложенных действий с намерениями сопоставления импорта](next-boundary.md). Полный HTTP/JWT контроль и выкат остаются открытыми критериями. GitHub Actions не используется.
