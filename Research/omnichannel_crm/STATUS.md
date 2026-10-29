# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG135:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG135 добавляет внутренний owner адресной очистки associations и связанной переписки с единым аудитом фактического графа. Проверены живой канал/аккаунт, смешанная защищённая выборка, пагинация, откат, lost COMMIT ACK и контроль исходных снимков перед последующим каскадом.

1928 tests/63 suites PASS (332.401s); 153 targeted/6 suites PASS (62.083s), 36 новых cases. 26 guard tests PASS; 10 migration checksums неизменны. Types 390/392 roots, baseline/current 225 diagnostics, 0 новых/changed-file. 3 local/remote source hashes совпадают.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG135](implementation/log135/results.json) · [исходники и ревью](implementation/log135/README.md).

Далее — подключение адресного owner к provider/group/folder/draft callers с их точными проверками; blocklist остаётся отдельным путём:
[следующая граница](implementation/log135/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–135 не выкатывался. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
