# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG152:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG152 переводит автоматическое создание компаний и контактов (`CreateCompanyAndContactJob`, `CreateCompanyAndPersonService`, `CreateCompanyService`, `CreatePersonService`) для источников `EMAIL` и `CALENDAR` на двухфазный закрытый owner в strict/exclusive транзакции: внешний HTTP-запрос метаданных домена выполняется до захвата блокировок БД, внутри транзакции проверяются актуальные `core.workspace`, `core.connectedAccount`, `core.userWorkspace`, `core.user`, каналы и отсутствие привязки к omnichannel, а создание, восстановление и обогащение имени `company` и `person` проверяются по полному образу PostgreSQL, точному `RETURNING` и `assertNoReferentialUpdateEffects` с пробросом `unsafeOutcome`.

2994 tests/97 suites PASS (636.398s). 817 targeted/19 suites PASS (232.996s), 17 новых PostgreSQL и 4 unit случая. 26 guard tests PASS, 10 migration checksums неизменны. Types 445/448 roots, baseline 225 / current 219 diagnostics, 0 новых/changed-file. Совпали 7 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG152](implementation/log152/results.json) · [исходники и ревью](implementation/log152/README.md).

Контур сохранения, автосоздания контактов/компаний и постраничного сопоставления сообщений полностью закрыт (`LOG148`–`LOG152`). Долговечное намерение сопоставления календаря после сохранения событий, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - долговечное сохранение и восстановление манифеста сопоставления календаря.
[Следующая граница](implementation/log152/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–152 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
