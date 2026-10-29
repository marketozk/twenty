# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG144:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG144 объединяет календарное сопоставление Participant и обновление CalendarEventTarget с аудитом в одной strict/exclusive транзакции. Сохранены прежние email-поиск и правила целей; фактический RETURNING, источники и поздние эффекты проверяются до COMMIT. Coordinator сохраняет автора и порядок enqueue → matching.

2733 tests/83 suites PASS (532.019s); 70 targeted/3 suites PASS (21.065s), 45 новых cases (37 PG и 8 entry). 26 guard tests PASS; 10 migration checksums неизменны. Types 424/426 roots, baseline/current 247 diagnostics, 0 новых/changed-file. 6 local/remote source hashes совпадают.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG144](implementation/log144/results.json) · [исходники и ревью](implementation/log144/README.md).

Один audit context покрывает Participant и CalendarEventTarget. Проверены
откат, actual-only effects, source SHARE, вычисляемые поля и поздние изменения.
Matching остаётся отдельной от сохранения и enqueue транзакцией.

Далее — фоновые пересопоставления календарных участников:
[следующая граница](implementation/log144/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–144 не выкатывался. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
