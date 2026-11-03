# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG147:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG147 добавляет аудит автоматических связей переписки после привязки компании к контакту. Закрытые страницы проверяют исходные связи участников и сообщений, сохраняют ручные назначения и записывают фактические изменения вместе с аудитом. Messaging pages выполняются перед календарными.

2804 tests/86 suites PASS (551.4s). 142 targeted/5 suites PASS (61.992s), 19 новых PG cases. 26 guard tests PASS, 10 migration checksums неизменны. Types 426/427 roots, baseline/current 225 diagnostics, 0 новых/changed-file. Совпали 5 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG147](implementation/log147/results.json) · [исходники и ревью](implementation/log147/README.md).

Каждая страница сохраняется отдельно. После неоднозначного результата COMMIT дальнейшие страницы останавливаются. Надёжная доставка очереди, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее — повторное сопоставление участников переписки с контактами и сотрудниками.
[Следующая граница](implementation/log147/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–147 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
