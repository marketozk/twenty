# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG150:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG150 переводит первоначальное сохранение обычных сообщений (`messageThread`, `message`, `messageChannelMessageAssociation`, `messageParticipant`, `messageChannelMessageAssociationMessageFolder`) на закрытый owner с единым аудитом в одной strict/exclusive транзакции для входов provider, inbound, sent, sent-tool и application. Проверены полномочия источника, папки `core.messageFolder`, ссылки `person`/`workspaceMember`, неизменность `messageThreadTarget`, фактический `RETURNING` и манифест затронутых участников для последующего сопоставления.

2956 tests/94 suites PASS (605.022s). 669 targeted/14 suites PASS (164.12s), 30 новых PostgreSQL случаев. 26 guard tests PASS, 10 migration checksums неизменны. Types 439/442 roots, baseline/current 225 diagnostics, 0 новых/changed-file. Совпали 10 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG150](implementation/log150/results.json) · [исходники и ревью](implementation/log150/README.md).

Сохранение сообщений и последующее постраничное сопоставление выполняются в отдельных транзакциях с сохранением порядка save -> очередь контактов -> matching. Долговечное сохранение манифеста сопоставления между этими транзакциями, создание контактов, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - долговечное сохранение и восстановление манифеста сопоставления после сохранения сообщений.
[Следующая граница](implementation/log150/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–150 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
