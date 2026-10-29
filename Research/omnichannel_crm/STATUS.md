# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG142:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG142 объединяет публичные настройки календарного канала, условный сброс синхронизации и аудит в одной core транзакции. Проверяются текущий владелец и точные фактические изменения; сохранены прежние права, pre-reset ответ и публичные коды ошибок. Кэш очищается только после подтверждённого COMMIT.

2610 tests/78 suites PASS (504.957s); 513 targeted/4 suites PASS (87.432s), 53 новых cases. 26 guard tests PASS; 10 migration checksums неизменны. Types 416/419 roots, baseline/current 225 diagnostics, 0 новых/changed-file. 8 local/remote source hashes совпадают.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG142](implementation/log142/results.json) · [исходники и ревью](implementation/log142/README.md).

Настройки и reset имеют один audit context. Cache-only действие выполняется
после сохранения; потеря COMMIT ACK не запускает его. Current owner, deferred
эффекты, API error mapping и source dependency guards проверены.

Далее — сохранение provider Event/Association/Participant:
[следующая граница](implementation/log142/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–142 не выкатывался. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
