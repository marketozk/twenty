# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG168:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI/system/bootstrap/workflow role CREATE/UPDATE/DELETE (`createAuditedRole`, `createRole`, `createMemberRole`, `createGuestRole`, `createWorkspaceCustomApplicationRole`, `updateRole`, `deleteRole`, `deleteAgentOnlyRoleIfUnused`), одиночные, пакетные и первичные назначения ролей сотрудникам (`assignRoleToWorkspaceMember`, `assignRoleToManyUserWorkspace`), агентам (`assignRoleToAgent`, `removeRoleFromAgent`, встроенные привязки `AgentService.createOneAgent` / `updateOneAgent` / `deleteOneAgent` / `deleteManyAgents`) и API-ключам (`RoleTargetService.createMany`), смена роли по умолчанию рабочего пространства (`core.workspace."defaultRoleId"` в `WorkspaceService.updateWorkspaceById`, `WorkspaceManagerService.setupDefaultRoles`, `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace`) и приложения (`core.application."defaultRoleId"` в `ApplicationService.update`, `RoleService.createWorkspaceCustomApplicationRole`, `TwentyStandardApplicationService.setStandardApplicationDefaultRoleOrThrow`, `ApplicationManifestMigrationService.syncApplicationReferencesFromManifest`), upsert всех прав роли (`rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`), пакетные миграции ролей, прав, `roleTarget` и каскадов переменных при синхронизации манифеста, стандартного приложения и удалении приложений (`ApplicationManifestMigrationService.syncMetadataFromManifest`, `ApplicationSyncService.uninstallApplication`, `ApplicationService.delete`, `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`), каскадное удаление и обнуление прав при отдельном удалении объектов и полей (`ObjectMetadataService.deleteOneObject` / `deleteManyObjectMetadatas`, `FieldMetadataService.deleteOneField`, fail-closed барьер в `WorkspaceMigrationRunnerService.executeRun`), полный жизненный цикл и каскадное удаление OAuth-согласий приложений (`applicationAuthorization`), пользовательских значений переменных приложений (`userApplicationVariableValue`) и методов двухфакторной аутентификации (`twoFactorAuthenticationMethod` + пакетный отзыв `refreshToken` при `redeemRecoveryCode`) и полный жизненный цикл API-ключей (`apiKey` `create` + `roleTarget` `create`, `apiKey` `update` / `revoke`).
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG168 закрывает аудит жизненного цикла (`create`, `update`, `delete`) методов двухфакторной аутентификации (`core."twoFactorAuthenticationMethod"`) и операций восстановления (`TwoFactorAuthenticationRecoveryService.redeemRecoveryCode`, включая пакетный отзыв `core."appToken"` типа `RefreshToken` с записью `refreshToken:update` и создание резервного `PENDING` метода при обязательной 2FA): подключены `TwoFactorAuthenticationService` (`initiateStrategyConfiguration`, `validateStrategy`, `verifyTwoFactorAuthenticationMethodForAuthenticatedUser`, `deleteTwoFactorAuthenticationMethod`), `TwoFactorAuthenticationResolver` и `TwoFactorAuthenticationRecoveryService.redeemRecoveryCode`, а секрет `secret` редактируется маркером `{ redacted: true }`.

3138 tests/113 suites PASS (692.416s). 257 targeted/16 PostgreSQL suites PASS (32.165s), 6 новых PostgreSQL случаев. 33 guard tests PASS, 10 migration checksums неизменны, 0 нарушений границы Enterprise. Types 469/471 roots, baseline 270 / current 270 diagnostics, 0 новых/changed-code. Совпали 6 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG168](implementation/log168/results.json) · [исходники и ревью](implementation/log168/README.md).

Контур сохранения, автосоздания контактов/компаний, долговечного post-save сопоставления, интеграции с общим runner/recovery отложенных действий, транзакционной свежести import policy/blocklist (`LOG143`-`LOG155`) и полного жизненного цикла ролей, назначений `roleTarget`, смены `core.workspace."defaultRoleId"` и `core.application."defaultRoleId"`, прав ролей, пакетных миграций метаданных приложений, каскадного удаления прав при удалении объектов/полей, OAuth-согласий приложений (`applicationAuthorization`), пользовательских значений переменных приложений (`userApplicationVariableValue`), методов двухфакторной аутентификации (`twoFactorAuthenticationMethod`) и API-ключей (`LOG111`-`LOG113`, `LOG156`-`LOG168`) закрыт. Оставшиеся native/core writers, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - закрытие следующих открытых границ ROB765.
[Следующая граница](implementation/log168/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–168 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
