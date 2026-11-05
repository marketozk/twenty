# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG155:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG155 закрывает транзакционную проверку свежести `import policy` и `blocklist` (`import-policy-proof.ts`) при сохранении сообщений (`saveOrdinaryMessageBatchWithAudit`, `InboundEmailImportService`), сохранении событий календаря (`CalendarSaveEventsService`) и очистке связей синхронизации календаря (`deleteOrdinarySyncCalendarAssociationsWithAudit`): под блокировками транзакции фиксируются `blocklist`, `workspaceMember` и `core."userWorkspace"` (`IN SHARE MODE` / `FOR SHARE`), обновляются поля политики канала и аккаунта из заблокированных строк БД, отклоняются пачки сообщений и событий, исключённые актуальной политикой или `blocklist`, до любых native-записей, и откатывается транзакция при дрейфе политики или `blocklist` до `COMMIT`.

3018 tests/100 suites PASS (668.834s). 170 targeted/6 suites PASS (84.991s), 4 новых PostgreSQL и 1 unit случай. 26 guard tests PASS, 10 migration checksums неизменны. Types 449/451 roots, baseline 220 / current 220 diagnostics, 0 новых/changed-file. Совпали 7 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG155](implementation/log155/results.json) · [исходники и ревью](implementation/log155/README.md).

Контур сохранения, автосоздания контактов/компаний, долговечного post-save сопоставления, интеграции с общим runner/recovery отложенных действий и транзакционной свежести import policy/blocklist закрыт (`LOG143`–`LOG155`). Удаление ролей и назначение ролей агентам/API-ключам, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - аудит удаления ролей и назначения ролей агентам и API-ключам.
[Следующая граница](implementation/log155/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–155 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
