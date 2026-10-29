# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG143:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG143 объединяет сохранение Event, Association и Participant календаря с аудитом в одной strict/exclusive транзакции. Сохранены прежние планировщики sharing; проверяются фактический RETURNING, источники, вычисляемые поля и поздние эффекты. Ручное создание захватывает автора до вызова провайдера и сохраняет его успешный результат при локальном postcommit сбое.

2690 tests/81 suites PASS (517.813s); 145 targeted/4 suites PASS (40.133s), 80 новых cases. 3 upstream unit cases PASS. 26 guard tests PASS; 10 migration checksums неизменны. Types 425/429 roots, baseline/current 247 diagnostics, 0 новых/changed-file. 13 local/remote source hashes совпадают.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG143](implementation/log143/results.json) · [исходники и ревью](implementation/log143/README.md).

Один audit context покрывает фактические изменения трёх объектов. Проверены
откат графа, actual-only IDs, позднее владение, generated columns, сохранение
sharing и ручного provider success. Matching остаётся отдельной транзакцией.

Далее — сопоставление участников календаря и обновление связанных целей:
[следующая граница](implementation/log143/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–143 не выкатывался. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
