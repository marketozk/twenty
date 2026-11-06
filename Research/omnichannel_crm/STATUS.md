# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG161:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI/system/bootstrap/workflow role CREATE/UPDATE/DELETE (`createAuditedRole`, `createRole`, `createMemberRole`, `createGuestRole`, `createWorkspaceCustomApplicationRole`, `updateRole`, `deleteRole`, `deleteAgentOnlyRoleIfUnused`), одиночные, пакетные и первичные назначения ролей сотрудникам (`assignRoleToWorkspaceMember`, `assignRoleToManyUserWorkspace`), агентам (`assignRoleToAgent`, `removeRoleFromAgent`) и API-ключам (`RoleTargetService.createMany`), upsert всех прав роли (`rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`) и полный жизненный цикл API-ключей (`apiKey` `create` + `roleTarget` `create`, `apiKey` `update` / `revoke`).
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG161 закрывает атомарный аудит удаления неиспользуемых агентских ролей (`AiAgentRoleService.deleteAgentOnlyRoleIfUnused` / `runAuditedUnusedAgentRoleDelete` в `role-update-audit.ts`), делает `AiAgentRoleService.assignRoleToAgent` безусловно fail-closed до первого `await` (без неаудируемой резервной ветки) и подключает системный `auditIdentity` в `WorkflowVersionStepOperationsWorkspaceService` (`createDraftStep` и `runWorkflowVersionStepDeletionSideEffects`): внутри `runInCoreAuditTransaction` захватываются блокировки `core.workspace` (`FOR NO KEY UPDATE`), `core.role` (`FOR UPDATE`) и `core."roleTarget"` (`FOR UPDATE`), проверяется эксклюзивность агентской роли и отсутствие параллельных привязок, при наличии остаточного `roleTargetId` он явно удаляется и записывается в аудит до удаления `core.role`, после чего записывается событие `role` (`delete`) с единым `operationId` и инвалидируются `['flatRoleMaps', 'flatRolePermissionFlagMaps', 'rolesPermissions']`.

3087 tests/106 suites PASS (677.916s). 278 targeted/9 suites PASS (26.32s), 8 новых PostgreSQL случаев. 26 guard tests PASS, 10 migration checksums неизменны. Types 458/459 roots, baseline 240 / current 240 diagnostics, 0 новых/changed-code. Совпали 5 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG161](implementation/log161/results.json) · [исходники и ревью](implementation/log161/README.md).

Контур сохранения, автосоздания контактов/компаний, долговечного post-save сопоставления, интеграции с общим runner/recovery отложенных действий, транзакционной свежести import policy/blocklist (`LOG143`–`LOG155`) и полного жизненного цикла ролей, назначений `roleTarget` в `UserRoleService`/`AiAgentRoleService`/`ApiKeyRoleService`, прав ролей и API-ключей (`LOG111`–`LOG113`, `LOG156`–`LOG161`) закрыт. Встроенные мутации `roleTarget` в `AgentService`, остальные metadata writers, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - аудит встроенных мутаций `roleTarget` в `AgentService` и оставшихся core metadata writers.
[Следующая граница](implementation/log161/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–161 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
