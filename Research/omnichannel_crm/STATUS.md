# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG134:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG134 объединяет очистку orphan messages, пересчёт связей CRM и удаление пустых threads в одной закрытой транзакции с общим аудитом. Подключены реальные jobs/CLI с server-derived identity; dry-run не меняет данные, а unsafe transaction outcome останавливает CLI без повторов и подмены исходной ошибки.

1892 tests/62 suites PASS (321.604s); 152 targeted/7 suites PASS (60.786s), 29 новых cases. 26 guard tests PASS; 10 migration checksums неизменны. Types 392/396 roots, baseline 226/current 225 diagnostics, 0 новых/changed-file. 17 local/remote source hashes совпадают.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG134](implementation/log134/results.json) · [исходники и ревью](implementation/log134/README.md).

Далее — адресная очистка associations и связанных сообщений, включая folder/provider/group/blocklist boundaries:
[следующая граница](implementation/log134/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–134 не выкатывался. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
