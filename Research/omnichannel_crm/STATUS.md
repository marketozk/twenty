# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG154:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG154 подключает `DeferredWorkspaceMigrationActionRunnerService`, `DeferredWorkspaceMigrationActionRecoveryService` и `DeferredWorkspaceMigrationActionHandlerRegistryService` к долговечным намерениям `reconcile_messageImportMatching` (`LOG151`) и `reconcile_calendarImportMatching` (`LOG153`) через обработчики с `managesOwnPersistence = true` и токен `IMPORT_MATCHING_INTENT_RECONCILIATION`: `runPendingActions` выполняет оба вида намерений с сохранением постраничного курсора `nextPageIndex` и транзакционного удаления до `COMMIT`, очищает устаревшие `PENDING`-намерения при soft-delete `core.workspace`, а `resetStaleInProgressActions`, `enqueueWorkspacesWithPendingActions` и `retryFailedActions` защищены условием `NOT (payload ? 'unsafeOutcome')`.

3013 tests/99 suites PASS (656.643s). 275 targeted/11 suites PASS (125.942s), 6 новых PostgreSQL случаев. 26 guard tests PASS, 10 migration checksums неизменны. Types 453/455 roots, baseline 220 / current 220 diagnostics, 0 новых/changed-file. Совпали 11 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG154](implementation/log154/results.json) · [исходники и ревью](implementation/log154/README.md).

Контур сохранения, автосоздания контактов/компаний, долговечного post-save сопоставления и интеграции с общим runner/recovery отложенных действий закрыт (`LOG143`–`LOG154`). Свежесть import policy, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - транзакционная проверка свежести import policy и blocklist при сохранении сообщений и календаря.
[Следующая граница](implementation/log154/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–154 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
