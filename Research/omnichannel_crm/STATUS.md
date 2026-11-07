# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG163:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI/system/bootstrap/workflow role CREATE/UPDATE/DELETE (`createAuditedRole`, `createRole`, `createMemberRole`, `createGuestRole`, `createWorkspaceCustomApplicationRole`, `updateRole`, `deleteRole`, `deleteAgentOnlyRoleIfUnused`), одиночные, пакетные и первичные назначения ролей сотрудникам (`assignRoleToWorkspaceMember`, `assignRoleToManyUserWorkspace`), агентам (`assignRoleToAgent`, `removeRoleFromAgent`, встроенные привязки `AgentService.createOneAgent` / `updateOneAgent` / `deleteOneAgent` / `deleteManyAgents`) и API-ключам (`RoleTargetService.createMany`), смена роли по умолчанию рабочего пространства (`core.workspace."defaultRoleId"` в `WorkspaceService.updateWorkspaceById`, `WorkspaceManagerService.setupDefaultRoles`, `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace`), upsert всех прав роли (`rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`) и полный жизненный цикл API-ключей (`apiKey` `create` + `roleTarget` `create`, `apiKey` `update` / `revoke`).
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG163 закрывает все три runtime-пути записи `core.workspace."defaultRoleId"` (`WorkspaceService.updateWorkspaceById` через `WorkspaceResolver.updateWorkspace`, `WorkspaceManagerService.setupDefaultRoles` и `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace`): через `captureWorkspaceDefaultRoleAudit` и `runAuditedWorkspaceDefaultRoleUpdate` в `workspace-default-role-audit.ts` внутри `runInCoreAuditTransaction` захватываются блокировки `core.workspace` (`FOR NO KEY UPDATE`) и `core.role` (`FOR SHARE`, проверка `canBeAssignedToUsers === true`), проверяется сохранённое состояние до и после `audit.flush()`, записывается событие `workspace` (`update`, `changedFields: ['defaultRoleId']`, `metadataAccess: 'currentWorkspaceAdministration'`), а при `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` инвалидируется кэш `workspaceEntity` и сохраняется зарегистрированный `customDomain`.

3107 tests/108 suites PASS (679.92s). 189 targeted/10 PostgreSQL suites PASS (19.504s), 8 новых PostgreSQL случаев. 33 guard tests PASS, 10 migration checksums неизменны, 0 нарушений границы Enterprise. Types 460/462 roots, baseline 237 / current 236 diagnostics, 0 новых/changed-code. Совпали 10 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG163](implementation/log163/results.json) · [исходники и ревью](implementation/log163/README.md).

Контур сохранения, автосоздания контактов/компаний, долговечного post-save сопоставления, интеграции с общим runner/recovery отложенных действий, транзакционной свежести import policy/blocklist (`LOG143`–`LOG155`) и полного жизненного цикла ролей, назначений `roleTarget` в `UserRoleService`/`AiAgentRoleService`/`ApiKeyRoleService`/`AgentService`, смены `core.workspace."defaultRoleId"`, прав ролей и API-ключей (`LOG111`–`LOG113`, `LOG156`–`LOG163`) закрыт. Поле `core.application."defaultRoleId"`, записи метаданных при установке, синхронизации и удалении приложений, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - аудит `core.application."defaultRoleId"` и записей метаданных при установке, синхронизации и удалении приложений.
[Следующая граница](implementation/log163/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–163 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
