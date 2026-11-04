# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG149:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE и public member assignment.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG149 переводит сопоставление участников и обновление целей диалога после сохранения сообщений на закрытые страницы с аудитом для входов provider, inbound, sent, sent-tool и application. Манифест затронутых участников и пар Message/Thread фиксируется до очереди контактов, неизменённые участники сохраняют ручные связи, успешная внешняя отправка не теряется при последующем сбое записи.

2926 tests/93 suites PASS (583.836s). 540 targeted/9 suites PASS (112.617s), 74 новых случая (73 net), включая 35 PostgreSQL и 39 entrypoint/orchestration tests; 34 upstream unit tests/4 suites PASS (33.839s). 26 guard tests PASS, 10 migration checksums неизменны. Types 443/449 roots, baseline/current 225 diagnostics, 0 новых/changed-file. Совпали 26 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG149](implementation/log149/results.json) · [исходники и ревью](implementation/log149/README.md).

Каждая страница сохраняется отдельно. После неоднозначного результата COMMIT дальнейшие страницы останавливаются. Надёжная доставка очереди, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - аудит первоначального сохранения обычных сообщений и последующее долговечное сохранение манифеста сопоставления.
[Следующая граница](implementation/log149/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–149 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
