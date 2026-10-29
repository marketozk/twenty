# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG145:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG145 подключает календарный rematch job к закрытым страницам по 200 участников с отдельным аудитом каждой страницы. Person-only и member-only сохраняют противоположные связи; цели пропущенных событий не меняются. Исправлен подтверждённый баг сохранения устаревшей связи сотрудника при отсутствии нового совпадения.

2756 tests/84 suites PASS (539.3s); 85 targeted/4 suites PASS (33.949s), 21 новый case (11 PG и 10 job entry). 26 guard tests PASS; 10 migration checksums неизменны. Types 424/425 roots, baseline/current 225 diagnostics, 0 новых/changed-file. 4 local/remote source hashes совпадают.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG145](implementation/log145/results.json) · [исходники и ревью](implementation/log145/README.md).

Каждая страница имеет отдельные транзакцию и аудит. Проверены пропуски,
перемещения участников, сохранение противоположных связей и откат поздней страницы.
Ранее сохранённые страницы остаются сохранёнными.

Далее — цели при привязке компании к контакту:
[следующая граница](implementation/log145/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–145 не выкатывался. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
