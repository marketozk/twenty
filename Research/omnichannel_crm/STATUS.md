# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG167:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI/system/bootstrap/workflow role CREATE/UPDATE/DELETE (`createAuditedRole`, `createRole`, `createMemberRole`, `createGuestRole`, `createWorkspaceCustomApplicationRole`, `updateRole`, `deleteRole`, `deleteAgentOnlyRoleIfUnused`), одиночные, пакетные и первичные назначения ролей сотрудникам (`assignRoleToWorkspaceMember`, `assignRoleToManyUserWorkspace`), агентам (`assignRoleToAgent`, `removeRoleFromAgent`, встроенные привязки `AgentService.createOneAgent` / `updateOneAgent` / `deleteOneAgent` / `deleteManyAgents`) и API-ключам (`RoleTargetService.createMany`), смена роли по умолчанию рабочего пространства (`core.workspace."defaultRoleId"` в `WorkspaceService.updateWorkspaceById`, `WorkspaceManagerService.setupDefaultRoles`, `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace`) и приложения (`core.application."defaultRoleId"` в `ApplicationService.update`, `RoleService.createWorkspaceCustomApplicationRole`, `TwentyStandardApplicationService.setStandardApplicationDefaultRoleOrThrow`, `ApplicationManifestMigrationService.syncApplicationReferencesFromManifest`), upsert всех прав роли (`rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`), пакетные миграции ролей, прав, `roleTarget` и каскадов переменных при синхронизации манифеста, стандартного приложения и удалении приложений (`ApplicationManifestMigrationService.syncMetadataFromManifest`, `ApplicationSyncService.uninstallApplication`, `ApplicationService.delete`, `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`), каскадное удаление и обнуление прав при отдельном удалении объектов и полей (`ObjectMetadataService.deleteOneObject` / `deleteManyObjectMetadatas`, `FieldMetadataService.deleteOneField`, fail-closed барьер в `WorkspaceMigrationRunnerService.executeRun`), полный жизненный цикл и каскадное удаление OAuth-согласий приложений (`applicationAuthorization`) и пользовательских значений переменных приложений (`userApplicationVariableValue`) и полный жизненный цикл API-ключей (`apiKey` `create` + `roleTarget` `create`, `apiKey` `update` / `revoke`).
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG167 закрывает аудит жизненного цикла (`create`, `update`, `delete`) и каскадного удаления пользовательских OAuth-согласий приложений (`core."applicationAuthorization"`) и пользовательских значений переменных приложений (`core."userApplicationVariableValue"`): подключены `ApplicationAuthorizationService` (`recordAuthorization`, `backfillAuthorizationFromRefreshToken`, `revokeAuthorizationByIdForUserWorkspace`, `revokeAuthorizationForApplication`), `ApplicationAuthorizationResolver.revokeApplicationAuthorization`, `OAuthService` (`exchangeAuthorizationCode`, `refreshTokenGrant`, `revokeToken`), `UserApplicationVariableValueService.updateMyUserApplicationVariable`, `UserApplicationVariableValueResolver.updateMyUserApplicationVariable`, `ApplicationService.delete`, `ApplicationSyncService.uninstallApplication` и `runAuditedApplicationMetadataMigration` (`WorkspaceMigrationRunnerService.executeRun`), секретные поля `scopes` и `value` редактируются маркером `{ redacted: true }`, а `WorkspaceMigrationRunnerService.executeRun` отклоняет неаудируемые удаления `applicationVariable`.

3132 tests/112 suites PASS (691.471s). 251 targeted/15 PostgreSQL suites PASS (31.574s), 6 новых PostgreSQL случаев. 33 guard tests PASS, 10 migration checksums неизменны, 0 нарушений границы Enterprise. Types 472/474 roots, baseline 270 / current 270 diagnostics, 0 новых/changed-code. Совпали 13 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG167](implementation/log167/results.json) · [исходники и ревью](implementation/log167/README.md).

Контур сохранения, автосоздания контактов/компаний, долговечного post-save сопоставления, интеграции с общим runner/recovery отложенных действий, транзакционной свежести import policy/blocklist (`LOG143`-`LOG155`) и полного жизненного цикла ролей, назначений `roleTarget`, смены `core.workspace."defaultRoleId"` и `core.application."defaultRoleId"`, прав ролей, пакетных миграций метаданных приложений, каскадного удаления прав при удалении объектов/полей, OAuth-согласий приложений (`applicationAuthorization`), пользовательских значений переменных приложений (`userApplicationVariableValue`) и API-ключей (`LOG111`-`LOG113`, `LOG156`-`LOG167`) закрыт. Оставшиеся native/core writers, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - закрытие следующих открытых границ ROB765.
[Следующая граница](implementation/log167/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–167 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
