# LOG172 - План проверок и исследований тестов

## 1. Целевые сценарии в `crm-audit-agent-chat-channel.postgres-spec.ts`

1. **Жизненный цикл `agentChatChannel` и `agentChatChannelRole` через `AgentChatChannelResolver`, `AgentChatChannelService` и `AgentChatChannelMetadataService`**:
   - `createAgentChatChannel` создаёт `core."agentChatChannel"` (`isCustom: true`) и привязки `core."agentChatChannelRole"`, записывая `agentChatChannel:create` (с редактированием `name`, `icon`, `color`, `position` и значением `isCustom: true`) и `agentChatChannelRole:create` (`channelId`, `roleId`) под одной `operationId` с проверкой `actor` и `initiator` (включая имперсонацию).
   - `updateAgentChatChannel` обновляет свойства канала и заменяет список `roleIds`, записывая `agentChatChannel:update`, `agentChatChannelRole:delete` и `agentChatChannelRole:create`, и запускает `rewriteChannelGrants`. Повторный вызов без изменений не создаёт записей аудита.
   - `deleteAgentChatChannel` переносит треды в другой канал и атомарно удаляет `agentChatChannel`, `agentChatChannelRole` и связанные `navigationMenuItem` (включая вложенные в папки элементы), фиксируя все удаления в `crm_audit."crmAuditEntry"`.
2. **Каскадное удаление `agentChatChannelRole` при удалении роли (`RoleService.deleteRole`, `DeleteRoleTool`, `AiAgentRoleService.deleteAgentOnlyRoleIfUnused`)**:
   - `RoleService.deleteRole` / `DeleteRoleTool.execute` удаляет роль, которая одновременно привязана к участнику (`roleTarget`) и к каналу (`agentChatChannelRole`): в одной транзакции перепривязывается `roleTarget` на `defaultRoleId`, удаляется `agentChatChannelRole` и удаляется `role`, с записью всех событий (`roleTarget:delete`, `roleTarget:create`, `agentChatChannelRole:delete`, `role:delete`).
   - Если в БД параллельно появилась привязка `core."agentChatChannelRole"`, отсутствовавшая в плане миграции, `runAuditedRoleDelete` откатывает транзакцию fail-closed (`persisted agentChatChannelRole set changed`).
   - `AiAgentRoleService.deleteAgentOnlyRoleIfUnused` атомарно удаляет и аудирует остаточные строки `core."agentChatChannelRole"` перед удалением `core.role`.
3. **Пакетные миграции приложений, legacy system build и барьер `ApplicationService.delete`**:
   - `runAuditedApplicationMetadataMigration` и `reconcileApplicationRoleAndPermissionOperations` аудируют создание, обновление и удаление `agentChatChannel` (включая стандартный канал `isCustom: false` для `twenty-standard`) и `agentChatChannelRole` (включая каскадное удаление `agentChatChannelRole` при удалении роли или канала и каскадное удаление `navigationMenuItem`).
   - `validateBuildAndRunLegacyWorkspaceMigration` с `isSystemBuild: true` (используемый в `AddAgentChatChannelsCommand`) автоматически создаёт системный контекст аудита, если внешний контекст не задан.
   - `ApplicationService.delete` (`assertNoRemainingApplicationRoleOrPermissionMetadata`) отклоняет удаление приложения, если в БД остались строки `core."agentChatChannel"` или `core."agentChatChannelRole"` (собственные или ссылающиеся на роли/каналы приложения).
4. **Защита от неаудируемых мутаций, ошибок журнала аудита и `NativeTransactionOutcomeUnknownError`**:
   - Неаудируемый вызов `WorkspaceMigrationRunnerService.run` с `agentChatChannel` или `agentChatChannelRole`, попытка `agentChatChannelRole:update` или попытка несистемного удаления стандартного канала (`isCustom: false`) отклоняются fail-closed.
   - Ошибка `INSERT` в `crm_audit."crmAuditEntry"` откатывает изменения в `core."agentChatChannel"`, `core."agentChatChannelRole"` и `core."navigationMenuItem"`.
   - Потеря подтверждения `COMMIT` (`NativeTransactionOutcomeUnknownError`) при `AgentChatChannelService.updateChannel` с `roleIds` сохраняет коммит в БД, инвалидирует кэш в `finally`, ставит в очередь `enqueueChannelGrantsRewrite` и пробрасывает ошибку.

## 2. Регрессионные и защитные проверки на Schrodinger

- Новый PostgreSQL-сьют: `packages/twenty-server/test/fork-migration/crm-audit-agent-chat-channel.postgres-spec.ts`.
- Целевые PostgreSQL-сьюты: `crm-audit-agent-chat-channel.postgres-spec.ts`, `crm-audit-navigation-menu-item.postgres-spec.ts`, `crm-audit-role-delete-and-targets.postgres-spec.ts`, `crm-audit-agent-role-lifecycle.postgres-spec.ts`, `crm-audit-application-metadata.postgres-spec.ts`, `crm-audit-application-authorization-and-variable.postgres-spec.ts`, `crm-audit-password-update.postgres-spec.ts` и связанные сьюты.
- Полный прогон всех 117 `fork-migration` сьютов на Schrodinger.
- Guard-проверки: `check_enterprise_dependencies.py`, `test_enterprise_dependencies.py`, `check_migration_Modifying.py`.
- Дифференциальный typecheck (`tsgo` / TypeScript) по изменённым и связанным файлам (`0` новых/changed-code диагностик).
