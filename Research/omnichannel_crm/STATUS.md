# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG136:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG136 подключает аудируемую адресную очистку к синхронизации, групповым письмам, папкам и отправленным черновикам. Проверяются актуальные основания операции и точные исходные строки; подтверждённая отправка сохраняет успех при сбое последующей очистки.

2032 tests/67 suites PASS (380.84s); 194 targeted/6 suites PASS (74.066s), 47 новых cases. Дополнительно 9 upstream tests/2 suites PASS (25.907s). 26 guard tests PASS; 10 migration checksums неизменны. Types 397/406 roots, baseline/current 225 diagnostics, 0 новых/changed-file. 26 local/remote source hashes совпадают.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG136](implementation/log136/results.json) · [исходники и ревью](implementation/log136/README.md).

Далее — аудит удаления по blocklist с актуальной политикой адресов и владельцев:
[следующая граница](implementation/log136/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–136 не выкатывался. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
