# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG137:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG137 подключает удаление переписки по блок-листу к общей транзакции аудита. Правила, участники, текущий владелец аккаунта и адреса канала проверяются заново; удаляются точные associations с фактическими зависимостями, защищённые записи сохраняются.

2072 tests/68 suites PASS (393.496s); окончательные 75 targeted/3 suites PASS (32.227s), 40 новых cases. 26 guard tests PASS; 10 migration checksums неизменны. Types 401/403 roots, baseline/current 225 diagnostics, 0 новых/changed-file. 7 local/remote source hashes совпадают.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG137](implementation/log137/results.json) · [исходники и ревью](implementation/log137/README.md).

Далее — аудит очистки календарных associations после удаления канала:
[следующая граница](implementation/log137/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–137 не выкатывался. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
