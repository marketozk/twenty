# LOG172 - транзакционный аудит полного жизненного цикла и каскадных удалений `agentChatChannel` и `agentChatChannelRole`

Проверки доработки завершены. ROB765 остаётся In Progress.
[Дизайн](design.md), [ревью решения](design-review.md), [ревью кода](review.md), [план проверок](test-research.md).

LOG172 закрывает транзакционный аудит полного жизненного цикла (`create`, `update`, `delete`) и каскадных удалений каналов чата ИИ (`core."agentChatChannel"`) и их ролевых правил доступа (`core."agentChatChannelRole"`). В каталог `CrmAuditTransactionContext` добавлены `agentChatChannel` (`values: ['isCustom']`, `redacted: ['name', 'icon', 'color', 'position']`, действия `['create', 'update', 'delete']`) и `agentChatChannelRole` (`values: ['channelId', 'roleId']`, `redacted: []`, действия `['create', 'delete']` с fail-closed отказом на `update`).

Подключены прямые пути `AgentChatChannelResolver` -> `AgentChatChannelService` -> `AgentChatChannelMetadataService` (`createChannel`, `updateChannel`, `deleteChannel`) через режим `mode: 'channel'` в `navigation-menu-item-audit.ts` с синхронным захватом идентичности до первого `await`, поддержкой переименования и настройки ролей стандартного канала (`General`), постановкой в очередь `enqueueChannelGrantsRewrite` при `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError` и подпиской `AgentChatChannelRoleAccessListener` на `metadata.agentChatChannelRole.created` и `metadata.agentChatChannelRole.deleted`. Каскадное удаление `agentChatChannelRole` при удалении роли подключено в `RoleService.deleteManyRoles`, `runAuditedRoleDelete` и `runAuditedUnusedAgentRoleDelete` (`AiAgentRoleService.deleteAgentOnlyRoleIfUnused`). Пакетные миграции приложений, стандартного приложения и системные миграции (`isSystemBuild: true`, включая `AddAgentChatChannelsCommand`), а также проверка `assertNoRemainingApplicationRoleOrPermissionMetadata` и fail-closed барьер в `WorkspaceMigrationRunnerService.executeRun` расширены на `agentChatChannel` и `agentChatChannelRole`.

3160 tests/117 suites PASS (696.175s). 295 targeted/17 PostgreSQL suites PASS (35.453s), 4 новых PostgreSQL случая. 33 guard tests PASS, 10 migration checksums неизменны, 0 нарушений границы Enterprise. Types 482/483 roots, baseline 277 / current 277 diagnostics, 0 новых/changed-code. Совпали 14 local/remote source hashes.

[Результаты](results.json), [сверка исходников](source-snapshot.json),
[типы](typecheck-differential.json), [регрессия](regression.log).

Далее - [оставшиеся открытые критерии ROB765](next-boundary.md). Полный HTTP/JWT контроль и выкат остаются открытыми критериями. GitHub Actions не используется.
