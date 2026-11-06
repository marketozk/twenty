# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG159:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI role CREATE/UPDATE/DELETE, одиночные, пакетные и первичные назначения ролей сотрудникам (`assignRoleToWorkspaceMember`, `assignRoleToManyUserWorkspace`), агентам и API-ключам, upsert всех прав роли (`rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`) и полный жизненный цикл API-ключей (`apiKey` `create` + `roleTarget` `create`, `apiKey` `update` / `revoke`).
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG159 закрывает атомарный аудит всех прямых и пакетных назначений ролей участникам (`UserRoleService.assignRoleToManyUserWorkspace`, `UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace`, `WorkspaceManagerService.setupDefaultRoles`, `DevSeederPermissionsService.initPermissions`) через `withBulkUserRoleAssignmentAudit` и ветку `userWorkspaceBulk` в `runAuditedRoleAssignment`: внутри одной транзакции `core` / `crm_audit` под блокировками `FOR NO KEY UPDATE` / `FOR SHARE` / `FOR UPDATE` проверяются все целевые `userWorkspace` и `workspaceMember` (при `requireWorkspaceMember !== false`), запрет самоназначения, `canBeAssignedToUsers === true` и сохранение хотя бы одного активного администратора вне разжалуемого пакета (`NOT (u.id=ANY($3::uuid[]))`), после чего записываются события `roleTarget` (`delete` и `create`) с единым `operationId`.

4805 tests/164 suites PASS (1395.066s). 262 targeted/7 suites PASS (23.74s), 12 новых PostgreSQL случаев. 26 guard tests PASS, 10 migration checksums неизменны. Types 457/458 roots, baseline 237 / current 237 diagnostics, 0 новых/changed-code. Совпали 7 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG159](implementation/log159/results.json) · [исходники и ревью](implementation/log159/README.md).

Контур сохранения, автосоздания контактов/компаний, долговечного post-save сопоставления, интеграции с общим runner/recovery отложенных действий, транзакционной свежести import policy/blocklist (`LOG143`–`LOG155`) и полного жизненного цикла ролей, одиночных/пакетных/первичных назначений `roleTarget`, прав ролей и API-ключей (`LOG111`–`LOG113`, `LOG156`–`LOG159`) закрыт. Оставшиеся metadata writers, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - аудит оставшихся метаданных и привязок `roleTarget`.
[Следующая граница](implementation/log159/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–159 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
