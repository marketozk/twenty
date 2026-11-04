# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG151:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG151 закрывает долговечное сохранение и восстановление манифеста сопоставления сообщений (`reconcile_messageImportMatching` в `core.deferredWorkspaceMigrationAction`) между первоначальным сохранением (`LOG150`) и постраничным сопоставлением (`LOG149`). Намерение со страницами до 200 записей и захваченным контекстом источника записывается и проверяется внутри транзакции сохранения, каждая страница сопоставления атомарно продвигает `nextPageIndex` или удаляет завершённое намерение в своём `COMMIT`, неопределённые исходы (`NativeTransactionOutcomeUnknownError`, `CoreAuditPostCommitError`) блокируются в `FAILED` с `unsafeOutcome`, а `reconcileMessageImportMatchingIntentsWithAudit` восстанавливает незавершённые страницы с проверкой актуальных полномочий без широкого пересопоставления исторических участников.

4707 tests/155 suites PASS (1348.722s). 686 targeted/15 suites PASS (180.849s), 15 новых PostgreSQL и 2 unit случая. 26 guard tests PASS, 10 migration checksums неизменны. Types 441/442 roots, baseline/current 225 diagnostics, 0 новых/changed-file. Совпали 11 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG151](implementation/log151/results.json) · [исходники и ревью](implementation/log151/README.md).

Первоначальное сохранение сообщений, долговечное намерение и постраничное сопоставление согласованы с порядком save -> очередь контактов -> matching. Автоматическое создание контактов и компаний (`CreateCompanyAndContactJob`), полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - аудит автоматического создания контактов и компаний.
[Следующая граница](implementation/log151/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–151 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
