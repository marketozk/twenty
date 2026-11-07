# Текущее состояние Twenty CRM

ROB764 завершена по [приёмке LOG088](implementation/rob764-acceptance.md).
ROB765 — In Progress: общий аудит действий ещё не принят.

Проверенное покрытие к LOG162:

- Covered native CRM create/update/FILES/soft-delete/restore и внутренний hard-delete с проверенными FK effects.
- Workspace sessions и refresh lifecycle; public/AI/system/bootstrap/workflow role CREATE/UPDATE/DELETE (`createAuditedRole`, `createRole`, `createMemberRole`, `createGuestRole`, `createWorkspaceCustomApplicationRole`, `updateRole`, `deleteRole`, `deleteAgentOnlyRoleIfUnused`), одиночные, пакетные и первичные назначения ролей сотрудникам (`assignRoleToWorkspaceMember`, `assignRoleToManyUserWorkspace`), агентам (`assignRoleToAgent`, `removeRoleFromAgent`, встроенные привязки `AgentService.createOneAgent` / `updateOneAgent` / `deleteOneAgent` / `deleteManyAgents`) и API-ключам (`RoleTargetService.createMany`), upsert всех прав роли (`rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`) и полный жизненный цикл API-ключей (`apiKey` `create` + `roleTarget` `create`, `apiKey` `update` / `revoke`).
- Core/native membership cleanup, core user deactivation и active-user checks.
- Connected-account transfer/disconnect/delete с actual effects, trusted identity и strict transaction outcome.
- OAuth/application attribution и отказ от automatic queue retry для распознанных unsafe outcomes.
- Очистка associations удалённого канала; общий orphan sweep с message/participant, target reconciliation и empty-thread audit. Реальные jobs/CLI подключены.

LOG162 закрывает последний сервис, менявший `core."roleTarget"` в обход CRM-аудита: встроенные привязки ролей в `AgentService` (`createOneAgent`, `updateOneAgent`, `deleteOneAgent`, `deleteManyAgents`) пишутся атомарно с изменением агента через `withAgentMetadataRoleTargetAudit` в `role-assignment-audit.ts`. Смена роли агента теперь `delete` + `create` под приложением миграции, повтор той же роли ничего не меняет. Внутри `runInCoreAuditTransaction` блокируются `core.workspace`, `core.application`, `core.agent`, `core."roleTarget"` и `core.role`, `before`-образ всех привязок удаляемых агентов снимается до `ON DELETE CASCADE`, а удаление агента всегда идёт через аудируемую транзакцию (агенты `FOR UPDATE`), поэтому устаревший кэш не приводит к неаудируемому каскаду. `auditIdentity` передают `AgentResolver`, `CreateAgentTool` / `UpdateAgentTool` / `DeleteAgentTool` и `WorkflowVersionStepOperationsWorkspaceService`.

3099 tests/107 suites PASS (678.24s). 181 targeted/9 PostgreSQL suites PASS (18.142s) и 18 unit/2 suites PASS, 12 новых PostgreSQL случаев. 33 guard tests PASS, 10 migration checksums неизменны, 0 нарушений границы Enterprise. Types 464/465 roots, baseline 237 / current 237 diagnostics, 0 новых/changed-code. Совпали 10 local/remote source hashes.
Это целевые проверки кода, не чистый full-server typecheck и не полный HTTP/JWT тест.
[Результаты LOG162](implementation/log162/results.json) · [исходники и ревью](implementation/log162/README.md).

Контур сохранения, автосоздания контактов/компаний, долговечного post-save сопоставления, интеграции с общим runner/recovery отложенных действий, транзакционной свежести import policy/blocklist (`LOG143`–`LOG155`) и полного жизненного цикла ролей, назначений `roleTarget` в `UserRoleService`/`AiAgentRoleService`/`ApiKeyRoleService`/`AgentService`, прав ролей и API-ключей (`LOG111`–`LOG113`, `LOG156`–`LOG162`) закрыт. Записи метаданных при установке, синхронизации и удалении приложений, `defaultRoleId`, полная HTTP/JWT приёмка и выкат остаются открытыми критериями ROB765.

Далее - аудит записей метаданных при установке, синхронизации и удалении приложений и `defaultRoleId`.
[Следующая граница](implementation/log162/next-boundary.md).
Остальные открытые критерии и ограничения находятся в единственной
[таблице приёмки ROB765](implementation/rob765-progress.md).

ROB762/763/764/772 — Done; ROB765 — In Progress; ROB766–771 — Backlog.
Собственные права, интерфейс чатов, коннекторы, ИИ и автоматизация ещё не приняты.

Демо остаётся прежним. Последний собранный изолированный кандидат — LOG088;
код LOG089–162 ожидает выката. Клиентские сообщения не отправлялись.
При будущем построении индекса migration10 writers останавливаются.
GitHub Actions не используется.

[Журнал разработки](DEVLOG.md) · [карта задач](linear.md).
