# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG170:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI/system/bootstrap/workflow role CREATE/UPDATE/DELETE (`createAuditedRole`, `createRole`, `createMemberRole`, `createGuestRole`, `createWorkspaceCustomApplicationRole`, `updateRole`, `deleteRole`, `deleteAgentOnlyRoleIfUnused`), одиночные, пакетные и первичные назначения ролей сотрудникам (`assignRoleToWorkspaceMember`, `assignRoleToManyUserWorkspace`), агентам (`assignRoleToAgent`, `removeRoleFromAgent`, встроенные привязки `AgentService.createOneAgent` / `updateOneAgent` / `deleteOneAgent` / `deleteManyAgents`) и API-ключам (`RoleTargetService.createMany`), смена роли по умолчанию рабочего пространства (`core.workspace."defaultRoleId"` в `WorkspaceService.updateWorkspaceById`, `WorkspaceManagerService.setupDefaultRoles`, `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace`) и приложения (`core.application."defaultRoleId"` в `ApplicationService.update`, `RoleService.createWorkspaceCustomApplicationRole`, `TwentyStandardApplicationService.setStandardApplicationDefaultRoleOrThrow`, `ApplicationManifestMigrationService.syncApplicationReferencesFromManifest`), upsert всех прав роли (`rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`), пакетные миграции ролей, прав, `roleTarget` и каскадов переменных при синхронизации манифеста, стандартного приложения и удалении приложений (`ApplicationManifestMigrationService.syncMetadataFromManifest`, `ApplicationSyncService.uninstallApplication`, `ApplicationService.delete`, `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`), каскадное удаление и обнуление прав при отдельном удалении объектов и полей (`ObjectMetadataService.deleteOneObject` / `deleteManyObjectMetadatas`, `FieldMetadataService.deleteOneField`, fail-closed барьер в `WorkspaceMigrationRunnerService.executeRun`), полный жизненный цикл и каскадное удаление OAuth-согласий приложений (`applicationAuthorization`), пользовательских значений переменных приложений (`userApplicationVariableValue`), методов двухфакторной аутентификации (`twoFactorAuthenticationMethod` + пакетный отзыв `refreshToken` при `redeemRecoveryCode`), смена владельца (`createdByUserWorkspaceId`) и видимости (`visibility`) рабочих процессов (`coreWorkflow` + долговечное намерение `sync_workflowRunShares`) и представлений (`coreView`), полный жизненный цикл (`create`, `update`, `delete`) и каскадное удаление пунктов навигационного меню (`navigationMenuItem` + каскады папок, `objectMetadata`, `fieldMetadata -> view`, `view`, `pageLayout`, `agentChatChannel`, `application`) и полный жизненный цикл API-ключей (`apiKey` `create` + `roleTarget` `create`, `apiKey` `update` / `revoke`).
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG170 закрывает транзакционный аудит полного жизненного цикла (`create`, `update`, `delete`) и каскадных удалений пунктов навигационного меню (`core."navigationMenuItem"`): подключены `NavigationMenuItemService`, `NavigationMenuItemResolver`, AI-инструменты (`CreateNavigationMenuItemTool`, `UpdateNavigationMenuItemTool`, `DeleteNavigationMenuItemTool`), `NavigationMenuItemDeletionService`, `ObjectMetadataService` (`createOneObject`, `deleteOneObject`, `deleteManyObjectMetadatas`), `FieldMetadataService` (`updateOneField`, `deleteOneField`), `ViewService` (`deleteOne`, `destroyOne`), `PageLayoutService` (`destroy`, `destroyMany`), `AgentChatChannelMetadataService.deleteChannel`, `seedPageLayouts`, `runAuditedApplicationMetadataMigration` и `WorkspaceMigrationRunnerService.executeRun` с fail-closed барьером на неаудируемые мутации `navigationMenuItem` и каскадные удаления `view` / `pageLayout` / `agentChatChannel`.

3150 tests/115 suites PASS (691.607s). 348 targeted/18 PostgreSQL suites PASS (36.221s), 6 новых PostgreSQL случаев. 33 guard tests PASS, 10 migration checksums неизменны, 0 нарушений границы Enterprise. Types 497/499 roots, baseline 271 / current 271 diagnostics, 0 новых/changed-code. Совпали 31 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG170](implementation/log170/results.json) · [исходники и ревью](implementation/log170/README.md).

Контур сохранения, автосоздания контактов/компаний, долговечного post-save сопоставления, интеграции с общим runner/recovery отложенных действий, транзакционной свежести import policy/blocklist (`LOG143`-`LOG155`) и полного жизненного цикла ролей, назначений `roleTarget`, смены `core.workspace."defaultRoleId"` и `core.application."defaultRoleId"`, прав ролей, пакетных миграций метаданных приложений, каскадного удаления прав при удалении объектов/полей, OAuth-согласий приложений (`applicationAuthorization`), пользовательских значений переменных приложений (`userApplicationVariableValue`), методов двухфакторной аутентификации (`twoFactorAuthenticationMethod`), смены владельца и видимости `coreWorkflow` и `coreView`, полного жизненного цикла и каскадного удаления `navigationMenuItem` и API-ключей (`LOG111`-`LOG113`, `LOG156`-`LOG170`) закрыт. Оставшиеся native/core writers, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - закрытие следующих открытых границ ROB765.
[Следующая граница](implementation/log170/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–170 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
