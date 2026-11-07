# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG166:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI/system/bootstrap/workflow role CREATE/UPDATE/DELETE (`createAuditedRole`, `createRole`, `createMemberRole`, `createGuestRole`, `createWorkspaceCustomApplicationRole`, `updateRole`, `deleteRole`, `deleteAgentOnlyRoleIfUnused`), одиночные, пакетные и первичные назначения ролей сотрудникам (`assignRoleToWorkspaceMember`, `assignRoleToManyUserWorkspace`), агентам (`assignRoleToAgent`, `removeRoleFromAgent`, встроенные привязки `AgentService.createOneAgent` / `updateOneAgent` / `deleteOneAgent` / `deleteManyAgents`) и API-ключам (`RoleTargetService.createMany`), смена роли по умолчанию рабочего пространства (`core.workspace."defaultRoleId"` в `WorkspaceService.updateWorkspaceById`, `WorkspaceManagerService.setupDefaultRoles`, `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace`) и приложения (`core.application."defaultRoleId"` в `ApplicationService.update`, `RoleService.createWorkspaceCustomApplicationRole`, `TwentyStandardApplicationService.setStandardApplicationDefaultRoleOrThrow`, `ApplicationManifestMigrationService.syncApplicationReferencesFromManifest`), upsert всех прав роли (`rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`), пакетные миграции ролей, прав и `roleTarget` при синхронизации манифеста, стандартного приложения и удалении приложений (`ApplicationManifestMigrationService.syncMetadataFromManifest`, `ApplicationSyncService.uninstallApplication`, `ApplicationService.delete`, `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`), каскадное удаление и обнуление прав при отдельном удалении объектов и полей (`ObjectMetadataService.deleteOneObject` / `deleteManyObjectMetadatas`, `FieldMetadataService.deleteOneField`, fail-closed барьер в `WorkspaceMigrationRunnerService.executeRun`) и полный жизненный цикл API-ключей (`apiKey` `create` + `roleTarget` `create`, `apiKey` `update` / `revoke`).
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG166 закрывает аудит каскадного удаления и обнуления записей прав (`core."objectPermission"`, `core."fieldPermission"`, `core."rowLevelPermissionPredicateGroup"`, `core."rowLevelPermissionPredicate"`) при отдельном удалении объектов (`ObjectMetadataService.deleteOneObject` / `deleteManyObjectMetadatas`, резолвер, контроллер, AI-инструмент) и полей (`FieldMetadataService.deleteOneField`, резолвер, контроллер, AI-инструмент) и расширяет fail-closed барьер в `WorkspaceMigrationRunnerService.executeRun` на неаудируемые удаления `objectMetadata`, `fieldMetadata`, `permissionFlag` и `agent`: через `captureApplicationMetadataAuditOperation`, `bindApplicationMetadataAuditOperation`, `reconcileApplicationRoleAndPermissionOperations` и `runAuditedApplicationMetadataMigration` (`mode: 'objectDelete' | 'fieldDelete'`) в `application-metadata-audit.ts` внутри `runInCoreAuditTransaction` захватываются блокировки `core.workspace` (`FOR NO KEY UPDATE`), `core.application` (`ORDER BY id FOR UPDATE`), 7 таблиц ролей/привязок/прав (`ORDER BY id FOR UPDATE`), `core."objectMetadata"` (`ORDER BY id FOR UPDATE`) и `core."fieldMetadata"` (`ORDER BY id FOR UPDATE`), согласуются парные обратные поля `RELATION` и все поля multi-target `MORPH_RELATION` (включая головное поле `morphId`), разрешается каскадное удаление прав на нередактируемых системных ролях только при удалении целевого объекта или поля, сверяется состояние 7 таблиц ролей/прав и таблиц `objectMetadata` / `fieldMetadata` до и после `audit.flush()`, инвалидируются кэши прав и `rolesPermissions` (включая `ON DELETE SET NULL` на `workspaceMemberFieldMetadataId`) и редактируется литеральный фильтр `value`.

3126 tests/111 suites PASS (688.35s). 208 targeted/13 PostgreSQL suites PASS (28.754s), 6 новых PostgreSQL случаев. 33 guard tests PASS, 10 migration checksums неизменны, 0 нарушений границы Enterprise. Types 475/476 roots, baseline 270 / current 270 diagnostics, 0 новых/changed-code. Совпали 14 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG166](implementation/log166/results.json) · [исходники и ревью](implementation/log166/README.md).

Контур сохранения, автосоздания контактов/компаний, долговечного post-save сопоставления, интеграции с общим runner/recovery отложенных действий, транзакционной свежести import policy/blocklist (`LOG143`-`LOG155`) и полного жизненного цикла ролей, назначений `roleTarget`, смены `core.workspace."defaultRoleId"` и `core.application."defaultRoleId"`, прав ролей, пакетных миграций метаданных приложений, каскадного удаления прав при удалении объектов/полей и API-ключей (`LOG111`-`LOG113`, `LOG156`-`LOG166`) закрыт. Оставшиеся native/core writers, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - закрытие следующих открытых границ ROB765.
[Следующая граница](implementation/log166/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–166 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
