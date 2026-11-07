# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG165:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI/system/bootstrap/workflow role CREATE/UPDATE/DELETE (`createAuditedRole`, `createRole`, `createMemberRole`, `createGuestRole`, `createWorkspaceCustomApplicationRole`, `updateRole`, `deleteRole`, `deleteAgentOnlyRoleIfUnused`), одиночные, пакетные и первичные назначения ролей сотрудникам (`assignRoleToWorkspaceMember`, `assignRoleToManyUserWorkspace`), агентам (`assignRoleToAgent`, `removeRoleFromAgent`, встроенные привязки `AgentService.createOneAgent` / `updateOneAgent` / `deleteOneAgent` / `deleteManyAgents`) и API-ключам (`RoleTargetService.createMany`), смена роли по умолчанию рабочего пространства (`core.workspace."defaultRoleId"` в `WorkspaceService.updateWorkspaceById`, `WorkspaceManagerService.setupDefaultRoles`, `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace`) и приложения (`core.application."defaultRoleId"` в `ApplicationService.update`, `RoleService.createWorkspaceCustomApplicationRole`, `TwentyStandardApplicationService.setStandardApplicationDefaultRoleOrThrow`, `ApplicationManifestMigrationService.syncApplicationReferencesFromManifest`), upsert всех прав роли (`rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`), пакетные миграции ролей, прав и `roleTarget` при синхронизации манифеста, стандартного приложения и удалении приложений (`ApplicationManifestMigrationService.syncMetadataFromManifest`, `ApplicationSyncService.uninstallApplication`, `ApplicationService.delete`, `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`, fail-closed барьер в `WorkspaceMigrationRunnerService.executeRun`) и полный жизненный цикл API-ключей (`apiKey` `create` + `roleTarget` `create`, `apiKey` `update` / `revoke`).
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG165 закрывает все пакетные пути записи метаданных ролей (`core.role`), привязок агентов (`core."roleTarget"`) и 5 таблиц прав (`core."rolePermissionFlag"`, `core."objectPermission"`, `core."fieldPermission"`, `core."rowLevelPermissionPredicateGroup"`, `core."rowLevelPermissionPredicate"`) при операциях над приложениями (`ApplicationManifestMigrationService.syncMetadataFromManifest`, `ApplicationSyncService.uninstallApplication` + `ApplicationService.delete`, `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`) и устанавливает fail-closed барьер в `WorkspaceMigrationRunnerService.executeRun`: через `captureApplicationMetadataAudit`, `withApplicationMetadataAudit`, `runAuditedApplicationMetadataMigration`, `assertNoRemainingApplicationRoleOrPermissionMetadata` и `reconcileApplicationRoleAndPermissionOperations` в `application-metadata-audit.ts` внутри `runInCoreAuditTransaction` захватываются блокировки `core.workspace` (`FOR NO KEY UPDATE`), `core.application` (`ORDER BY id FOR UPDATE`) и всех 7 таблиц ролей/привязок/прав (`ORDER BY id FOR UPDATE`), согласуются кросс-приложенческие привязки `roleTarget` и зависимые права при удалении, сохраняется `roleTarget` при одновременном `role.delete` и `roleTarget.update`, сверяется состояние 7 таблиц до и после `audit.flush()` и редактируется литеральный фильтр `value`.

3120 tests/110 suites PASS (682.085s). 202 targeted/12 PostgreSQL suites PASS (22.704s), 6 новых PostgreSQL случаев. 33 guard tests PASS, 10 migration checksums неизменны, 0 нарушений границы Enterprise. Types 466/468 roots, baseline 236 / current 234 diagnostics, 0 новых/changed-code. Совпали 7 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG165](implementation/log165/results.json) · [исходники и ревью](implementation/log165/README.md).

Контур сохранения, автосоздания контактов/компаний, долговечного post-save сопоставления, интеграции с общим runner/recovery отложенных действий, транзакционной свежести import policy/blocklist (`LOG143`–`LOG155`) и полного жизненного цикла ролей, назначений `roleTarget`, смены `core.workspace."defaultRoleId"` и `core.application."defaultRoleId"`, прав ролей, пакетных миграций метаданных приложений и API-ключей (`LOG111`–`LOG113`, `LOG156`–`LOG165`) закрыт. Оставшиеся native/core writers, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - закрытие следующих открытых границ ROB765.
[Следующая граница](implementation/log165/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–165 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
