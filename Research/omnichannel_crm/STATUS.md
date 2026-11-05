# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG156:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE/DELETE и назначения ролей сотрудникам, агентам и API-ключам.
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG156 закрывает атомарный аудит удаления ролей (`RoleService.deleteRole`, `RoleResolver.deleteOneRole`, `DeleteRoleTool.execute`), назначения и снятия ролей ИИ-агентов (`AiAgentRoleService.assignRoleToAgent`, `AiAgentRoleService.removeRoleFromAgent`) и назначения ролей API-ключам (`ApiKeyRoleService.assignRoleToApiKey`) в одной транзакции `core` / `crm_audit`: при удалении роли под блокировками `FOR NO KEY UPDATE` / `FOR UPDATE` / `FOR SHARE` проверяются `core.workspace`, `core.application`, удаляемая роль, `defaultRole`, отсутствие самоблокировки, точное совпадение набора `core."roleTarget"` и перепривязка всех активных участников, активных API-ключей и неудалённых агентов к `defaultRoleId` с записью атомарного аудита `roleTarget` (`delete` + `create`) и `role` (`delete`).

3034 tests/101 suites PASS (671.015s). 116 targeted/3 suites PASS (8.675s), 16 новых PostgreSQL случаев. 26 guard tests PASS, 10 migration checksums неизменны. Types 456/457 roots, baseline 253 / current 252 diagnostics, 0 новых/changed-code. Совпали 12 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG156](implementation/log156/results.json) · [исходники и ревью](implementation/log156/README.md).

Контур сохранения, автосоздания контактов/компаний, долговечного post-save сопоставления, интеграции с общим runner/recovery отложенных действий, транзакционной свежести import policy/blocklist (`LOG143`–`LOG155`) и полного жизненного цикла ролей и назначений `roleTarget` (`LOG111`–`LOG113`, `LOG156`) закрыт. Upsert прав роли, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - аудит upsert флагов прав, объектных/полевых прав и предикатов строкового доступа роли.
[Следующая граница](implementation/log156/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–156 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
