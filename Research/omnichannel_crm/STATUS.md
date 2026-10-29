# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG140:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG140 подключает global CalendarEvent sweep к одному аудиту на все страницы и трём реальным заданиям. Live-only discovery, точные каскады и сохранность CallRecording проверены; ошибка поздней страницы откатывает весь sweep.

2160 tests/73 suites PASS (420.276s); 88 targeted/5 suites PASS (35.255s), 30 новых cases. 26 guard tests PASS; 10 migration checksums неизменны. Types 411/415 roots, baseline/current 225 diagnostics, 0 новых/changed-file. 10 local/remote source hashes совпадают.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG140](implementation/log140/results.json) · [исходники и ревью](implementation/log140/README.md).

Global sweep подключён к трём jobs. Весь проход использует одну транзакцию;
предшествующий channel association cleanup остаётся отдельной операцией.
LOG138 сохраняет SHARE lock core.calendarChannel только для absent-channel proof.

Далее — provider expectedRun cleanup и сохранение unsafe outcomes:
[следующая граница](implementation/log140/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–140 не выкатывался. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
