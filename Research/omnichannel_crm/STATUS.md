# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG146:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG146 добавляет аудит календарных целей после привязки компании к контакту. Закрытые страницы по 200 участников повторно проверяют исходные Person/Event, сохраняют цели пропущенных событий и учитывают фактические изменения PostgreSQL. Связи участников не меняются.

2785 tests/85 suites PASS (545.438s); 106 targeted/4 suites PASS (40.19s), 29 новых cases (24 PG и 5 job entry). 26 guard tests PASS; 10 migration checksums неизменны. Types 425/427 roots, baseline/current 225 diagnostics, 0 новых/changed-file. 9 local/remote source hashes совпадают.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG146](implementation/log146/results.json) · [исходники и ревью](implementation/log146/README.md).

Каждая страница атомарна отдельно; прежняя messaging-ветка пока не аудируется этим owner. Ранее сохранённые страницы и messaging не откатываются при позднем отказе календаря. Durable delivery, полный HTTP/JWT тест и выкат не выполнены. ROB765 остаётся In Progress; GitHub Actions не используется.

Далее — аналогичная messaging-ветка привязки целей:
[следующая граница](implementation/log146/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–146 не выкатывался. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
