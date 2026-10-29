# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG139:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG139 подключает аудит удаления календарных associations для удалённого канала. Удаляются и журналируются только фактические строки; проверены пагинация, частичный DELETE, откат и конкурентное создание канала. Само событие и его участники этим owner не удаляются.

2130 tests/71 suites PASS (415.115s); 30 targeted/1 suite PASS (15.432s), 30 новых cases. 26 guard tests PASS; 10 migration checksums неизменны. Types 405/407 roots, baseline/current 225 diagnostics, 0 новых/changed-file. 2 local/remote source hashes совпадают.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG139](implementation/log139/results.json) · [исходники и ревью](implementation/log139/README.md).

Candidate owner проверяет полный Event graph; он пока не подключён к service/jobs.
LOG138 association cleanup по-прежнему удерживает SHARE lock core.calendarChannel;
это ограничение не переносится на новый Event owner.

Далее — единый аудит global CalendarEvent sweep и подключение трёх jobs:
[следующая граница](implementation/log139/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–139 не выкатывался. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
