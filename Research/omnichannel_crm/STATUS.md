# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG160:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI/system/bootstrap role CREATE/UPDATE/DELETE (`createAuditedRole`, `createRole`, `createMemberRole`, `createGuestRole`, `createWorkspaceCustomApplicationRole`, `updateRole`, `deleteRole`), одиночные, пакетные и первичные назначения ролей сотрудникам (`assignRoleToWorkspaceMember`, `assignRoleToManyUserWorkspace`), агентам и API-ключам (`RoleTargetService.createMany`), upsert всех прав роли (`rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`) и полный жизненный цикл API-ключей (`apiKey` `create` + `roleTarget` `create`, `apiKey` `update` / `revoke`).
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG160 закрывает атомарный аудит всех системных и bootstrap-путей создания ролей, прав и привязок `roleTarget` в `RoleService` (`createRole`, `createMemberRole`, `createGuestRole`, `createWorkspaceCustomApplicationRole`), `RoleTargetService.createMany`, `WorkspaceManagerService` (`init`, `setupDefaultRoles`) и `DevSeederPermissionsService` (`initPermissions`, `initMinimalPermissionsAndActivateWorkspace`, `createImpersonateOnlyRoleForSeedWorkspace`, `createLimitedRoleForSeedWorkspace`): в `withRoleCreateAudit` не-редактируемая роль (`isEditable: false`) разрешена строго только для `auth.type === 'system'` с `universalIdentifier === WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER`, во всех методах `RoleService` `auditIdentity` и отсутствие конфликтующих аудит-контекстов проверяются синхронно до первого `await`, а в `RoleTargetService.createMany` согласован `applicationUniversalIdentifier` для привязок с явным `applicationId`.

3079 tests/105 suites PASS (679.211s). 270 targeted/8 suites PASS (24.892s), 9 новых PostgreSQL случаев. 26 guard tests PASS, 10 migration checksums неизменны. Types 458/459 roots, baseline 237 / current 237 diagnostics, 0 новых/changed-code. Совпали 7 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG160](implementation/log160/results.json) · [исходники и ревью](implementation/log160/README.md).

Контур сохранения, автосоздания контактов/компаний, долговечного post-save сопоставления, интеграции с общим runner/recovery отложенных действий, транзакционной свежести import policy/blocklist (`LOG143`–`LOG155`) и полного жизненного цикла ролей, одиночных/пакетных/первичных/системных назначений `roleTarget`, прав ролей и API-ключей (`LOG111`–`LOG113`, `LOG156`–`LOG160`) закрыт. Операции ролей агентов в шагах workflow, оставшиеся metadata writers, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - аудит оставшихся операций ролей агентов в шагах workflow и core metadata writers.
[Следующая граница](implementation/log160/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–160 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
