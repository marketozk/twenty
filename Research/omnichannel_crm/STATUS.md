# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG141:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG141 подключает оба provider/import cleanup caller к одной транзакции аудита Association и orphan Event. Проверяются текущий expectedRun и исходный граф; раннее переназначение связи безопасно пропускается, позднее изменение откатывается. Unsafe outcomes сохраняются до логирования и изменения статусов.

2557 tests/76 suites PASS (493.096s); 462 targeted/4 suites PASS (91.02s), 46 новых cases. 3 upstream unit cases PASS. 26 guard tests PASS; 10 migration checksums неизменны. Types 413/416 roots, baseline/current 225 diagnostics, 0 новых/changed-file. 10 local/remote source hashes совпадают.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG141](implementation/log141/results.json) · [исходники и ревью](implementation/log141/README.md).

Оба provider cleanup caller используют общий audit owner. Проверены 501 Association
на один external ID, раннее переназначение, сохранность tombstones и unsafe outcomes.
Provider save/matching и свежесть ранее прочитанной import policy остаются открыты.

Далее — публичные настройки календарного канала и условный сброс:
[следующая граница](implementation/log141/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–141 не выкатывался. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
