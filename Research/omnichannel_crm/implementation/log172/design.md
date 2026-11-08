# LOG172 - Дизайн транзакционного аудита полного жизненного цикла (`create`, `update`, `delete`) и каскадных удалений `agentChatChannel` и `agentChatChannelRole`

## 1. Контекст и проблема

В этапе 2a (`ROB-765` - сбор аудита действий) после закрытия `LOG156`-`LOG171` (роли, привязки `roleTarget`, `defaultRoleId` пространства и приложения, права ролей, миграции приложений, каскады удаления объектов/полей, `applicationAuthorization`, `userApplicationVariableValue`, `twoFactorAuthenticationMethod`, `coreWorkflow`/`coreView`, `navigationMenuItem`, смена/сброс пароля и пакетный отзыв `refreshToken`) остаётся непокрытым жизненный цикл общих каналов чата ИИ (`core."agentChatChannel"`) и их ролевых правил доступа (`core."agentChatChannelRole"`).

Факты из кодовой базы:
1. **Схема БД и влияние на права доступа**:
   - `core."agentChatChannel"` (`packages/twenty-server/src/engine/metadata-modules/agent-chat-channel/entities/agent-chat-channel.entity.ts`): хранит идентификатор канала (`id`), `workspaceId`, `applicationId`, `universalIdentifier`, `name`, `icon`, `color`, `position`, `isCustom`, `createdAt`, `updatedAt`.
   - `core."agentChatChannelRole"` (`packages/twenty-server/src/engine/metadata-modules/agent-chat-channel/entities/agent-chat-channel-role.entity.ts`): связующая таблица доступа между каналом и ролью (`id`, `workspaceId`, `applicationId`, `universalIdentifier`, `channelId`, `roleId`, `createdAt`, `updatedAt`) с `ON DELETE CASCADE` на `core."agentChatChannel"(id)`, `core.role(id)`, `core.application(id)` и `core.workspace(id)`.
   - Таблица `core."agentChatChannelRole"` непосредственно определяет доступ участников рабочего пространства к потокам чатов ИИ (`buildAgentChatChannelAccessQuery` в `AgentChatChannelGrantService` вычисляет права `recordShare` с `rowCause = 'RULE'` и `accessLevel = 'READ_WRITE'` на основе `core."agentChatChannelRole"` и `core.role."canAccessAllAgentChatChannels"`).
2. **Точки мутации `core."agentChatChannel"` и `core."agentChatChannelRole"`**:
   - `AgentChatChannelResolver` (`createAgentChatChannel`, `updateAgentChatChannel`, `deleteAgentChatChannel`) -> `AgentChatChannelService` (`createChannel`, `updateChannel`, `deleteChannel`) -> `AgentChatChannelMetadataService` (`createChannel`, `updateChannel`, `deleteChannel`).
     - Сейчас только `deleteChannel` оборачивает миграцию в `withNavigationMenuItemAudit` (`mode: 'cascade'`), причём записывает в `crm_audit."crmAuditEntry"` только каскадно удалённые `navigationMenuItem`, но **не записывает** удаление самой строки `agentChatChannel` и её ролевых привязок `agentChatChannelRole`.
     - Методы `createChannel` и `updateChannel` в `AgentChatChannelResolver`, `AgentChatChannelService` и `AgentChatChannelMetadataService` вообще не захватывают `auditIdentity` и выполняют `create`/`update` для `agentChatChannel` и `create`/`delete` для `agentChatChannelRole` через неаудируемую ветку `WorkspaceMigrationRunnerService.executeRun`.
   - **Каскад при удалении роли (`core.role` -> `core."agentChatChannelRole"`)**:
     - `RoleService.deleteRole` (`deleteManyRoles` -> `runAuditedRoleMutation` / `runAuditedRoleDelete` в `role-update-audit.ts`): сейчас проверяет и перепривязывает только `core."roleTarget"`. Если удаляемая роль была привязана к каналу в `core."agentChatChannelRole"`, при `DELETE FROM core.role` СУБД молча удаляет строки `core."agentChatChannelRole"` по `ON DELETE CASCADE` без записи `agentChatChannelRole:delete` в журнал аудита и без инвалидации `flatAgentChatChannelMaps` / `flatAgentChatChannelRoleMaps`.
     - `AiAgentRoleService.deleteAgentOnlyRoleIfUnused` (`runAuditedUnusedAgentRoleDelete` в `role-update-audit.ts`): выполняет прямой `DELETE FROM core.role`, который также может молча каскадно удалить строки `core."agentChatChannelRole"`, если на роль ссылались каналы.
   - **Пакетные миграции манифеста, стандартного приложения и удаление приложений (`application-metadata-audit.ts`)**:
     - `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow` создаёт стандартный канал `General` (`STANDARD_AGENT_CHAT_CHANNEL.general`, `isCustom: false`).
     - `ApplicationManifestMigrationService.syncMetadataFromManifest` и `ApplicationSyncService.uninstallApplication` могут создавать, обновлять и удалять `agentChatChannel` и `agentChatChannelRole`, а также удалять роли `core.role`, на которые ссылаются `agentChatChannelRole` (включая кросс-приложенческие привязки пользовательских каналов к роли приложения).
     - `ApplicationService.delete` (`assertNoRemainingApplicationRoleOrPermissionMetadata`) проверяет отсутствие оставшихся метаданных перед удалением `core.application`, но ещё не проверяет `core."agentChatChannel"` и `core."agentChatChannelRole"`.
   - **Команда обновления `AddAgentChatChannelsCommand` (`2-51-workspace-command-1792686629823-add-agent-chat-channels.command.ts`)**:
     - Вызывает `validateBuildAndRunLegacyWorkspaceMigration` с `agentChatChannel` (`up` создаёт стандартный канал `General`, `down` удаляет его). Согласно правилам репозитория (`CLAUDE.md`), закоммиченную логику upgrade-команды переписывать нельзя; значит, при вызове `validateBuildAndRunLegacyWorkspaceMigration` с `isSystemBuild: true` без внешнего контекста аудита должен автоматически связываться системный контекст аудита.

## 2. Варианты решения (ADR-172)

### Вариант A: Отдельный модуль `agent-chat-channel-audit.ts` + дублирование проверок в `role-update-audit.ts`, `navigation-menu-item-audit.ts` и `application-metadata-audit.ts`
- **Плюсы**: отдельный файл для `AgentChatChannelMetadataService`.
- **Минусы**: `AgentChatChannelMetadataService.deleteChannel` уже использует `navigation-menu-item-audit.ts` (`mode: 'cascade'`), потому что удаление канала атомарно удаляет `agentChatChannel`, `agentChatChannelRole` и `navigationMenuItem` в одной миграции `WorkspaceMigrationRunnerService.executeRun`. Создание ещё одного `AsyncLocalStorage`-контекста приведёт к конфликту владельцев аудита в `deleteChannel`.

### Вариант B (Рекомендуемый): Расширение каталога аудита (`agentChatChannel`, `agentChatChannelRole`), единый контур в `navigation-menu-item-audit.ts` для канальных миграций и каскадный учёт в `role-update-audit.ts` и `application-metadata-audit.ts`
- **Описание**:
  1. **Каталог аудита (`crm-audit.types.ts`, `crm-audit-transaction-context.ts`)**:
     - Добавить виды ресурсов `'agentChatChannel'` и `'agentChatChannelRole'` в `CrmAuditResourceKind`:
       - `CATALOG.agentChatChannel = { values: ['isCustom'], redacted: ['name', 'icon', 'color', 'position'] }` (отображаемые поля канала редактируются в `redactedDiff.changedFields` + SHA-256 хэшах без утечки пользовательских названий каналов, по аналогии с `navigationMenuItem` и `role`).
       - `CATALOG.agentChatChannelRole = { values: ['channelId', 'roleId'], redacted: [] }`.
     - В `ADMINISTRATIVE_ACTIONS`:
       - `agentChatChannel: ['create', 'update', 'delete']`,
       - `agentChatChannelRole: ['create', 'delete']` (связь канал-роль создаётся и удаляется; `update` на `agentChatChannelRole` запрещён fail-closed, как и на `rolePermissionFlag`).
  2. **Прямые операции каналов (`AgentChatChannelResolver` -> `AgentChatChannelService` -> `AgentChatChannelMetadataService` -> `navigation-menu-item-audit.ts`)**:
     - В `AgentChatChannelResolver` (`createAgentChatChannel`, `updateAgentChatChannel`, `deleteAgentChatChannel`) передавать `@AuthUserWorkspaceId() userWorkspaceId: string`, `@AuthWorkspaceMemberId() workspaceMemberId: string`, `@AuthApplication({ allowUndefined: true }) callingApplication: FlatApplication | undefined` и `@Context() context: { req?: Request }` (или явно формировать `auditIdentity` из `context?.req` / декораторов) в `AgentChatChannelService` и далее в `AgentChatChannelMetadataService`.
     - В `AgentChatChannelMetadataService` (`createChannel`, `updateChannel`, `deleteChannel`) синхронно до первого `await` вызывать `captureNavigationMenuItemAudit({ workspaceId, mode: 'channel', auditIdentity, authUserWorkspaceId, defaultSystemActorId: ... })` и оборачивать `this.runMigration(...)` в `withNavigationMenuItemAudit(...)` с передачей ожидаемых ID (`expectedChannelCreateIds`, `expectedChannelUpdateIds`, `expectedParentChannelDeleteIds`, `expectedChannelRoleCreateKeys`, `expectedChannelRoleDeleteIds`, `expectedDeletedIds`).
     - При `updateChannel` захватывать глубокую копию `changes` и `roleIds` до первого `await` для защиты от TOCTOU. Если `updateChannel` меняет состав ролей (`channelRolesToCreate.length > 0 || channelRolesToDelete.length > 0`), либо выбрасывает `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError` при наличии `roleIds`, гарантировать пересчёт/постановку в очередь `rewriteChannelGrants` / `enqueueChannelGrantsRewrite`.
     - В `navigation-menu-item-audit.ts` и `WorkspaceMigrationRunnerService`:
       - Добавить поддержку режима `'channel'` (и сохранить поддержку `'cascade'`), блокировать `core."agentChatChannel"` и `core."agentChatChannelRole"` (`ORDER BY id FOR UPDATE`) и `core.role` (`FOR SHARE` при создании `agentChatChannelRole`), проверять инварианты строк (`assertAgentChatChannelRowInvariants`, `assertAgentChatChannelRoleRowInvariants`), сверять созданные/обновлённые/удалённые строки `agentChatChannel` и `agentChatChannelRole` с планом миграции, записывать события `agentChatChannel` (`create`/`update`/`delete`) и `agentChatChannelRole` (`create`/`delete`) в `CrmAuditTransactionContext` и повторно сверять снимки после `audit.flush()`.
       - Запретить удаление стандартного канала (`isCustom === false`) в несистемных миграциях (`!request.isSystemBuild`).
  3. **Каскад удаления ролей (`RoleService.deleteRole` / `deleteManyRoles`, `AiAgentRoleService.deleteAgentOnlyRoleIfUnused`, `role-update-audit.ts`)**:
     - В `RoleService.deleteManyRoles` загружать `flatAgentChatChannelRoleMaps` и включать все `agentChatChannelRole` удаляемых ролей в `allFlatEntityOperationByMetadataName.agentChatChannelRole.flatEntityToDelete` (чтобы кэш `flatAgentChatChannelRoleMaps` и `flatAgentChatChannelMaps` инвалидировался штатно и миграция явно удаляла привязки до удаления роли).
     - В `runAuditedRoleDelete` (`role-update-audit.ts`):
       - Разрешить действия `agentChatChannelRole` (`type: 'delete'`) наряду с `role` (`delete`) и `roleTarget` (`delete`/`create`).
       - Если таблица `core."agentChatChannelRole"` существует (`to_regclass('core."agentChatChannelRole"') IS NOT NULL`), блокировать все строки `core."agentChatChannelRole"` для удаляемой роли (`WHERE "workspaceId"=$1 AND ("roleId"=$2 OR id=ANY($3::uuid[])) ORDER BY id FOR UPDATE`), сверять точное совпадение с планом `plannedChannelRoleDeletes` (отклоняя несогласованные/незапланированные строки fail-closed), проверять отсутствие оставшихся строк после `work(runner)`, записывать `agentChatChannelRole` (`delete`) в `CrmAuditTransactionContext` и проверять отсутствие повторного появления после `audit.flush()`.
       - Если у удаляемой роли было `beforeRole.canAccessAllAgentChatChannels === true` или были удалены строки `agentChatChannelRole`, то при ошибке `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError` в `RoleService.deleteRole` ставить в очередь пересчёт грантов каналов (`enqueueChannelGrantsRewrite` или через `AgentChatChannelRoleAccessListener` / инжектируемый сервис, без нарушения границы Enterprise).
     - В `runAuditedUnusedAgentRoleDelete` (`role-update-audit.ts`):
       - Поскольку агентская роль имеет `canBeAssignedToUsers = false`, в норме у неё нет `agentChatChannelRole`, но если в БД есть строки `core."agentChatChannelRole"` для `roleId`, блокировать их `ORDER BY id FOR UPDATE`, явно удалять `DELETE FROM core."agentChatChannelRole" WHERE id=ANY(...)` до `DELETE FROM core.role`, записывать `agentChatChannelRole:delete` в `CrmAuditTransactionContext` и проверять их удаление до и после `audit.flush()`. В `AiAgentRoleService.deleteAgentOnlyRoleIfUnused` инвалидировать также `flatAgentChatChannelRoleMaps` и `flatAgentChatChannelMaps`, если такие строки существовали или при `NativeTransactionOutcomeUnknownError`.
  4. **Пакетные миграции приложений и удаление приложений (`application-metadata-audit.ts`, `WorkspaceMigrationRunnerService`, `WorkspaceMigrationValidateBuildAndRunService`)**:
     - Добавить `'agentChatChannel'` и `'agentChatChannelRole'` в `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES` (так что любая миграция, затрагивающая `agentChatChannel` или `agentChatChannelRole` без активного контекста аудита, отклоняется fail-closed).
     - В `reconcileApplicationRoleAndPermissionOperations`:
       - Согласовывать каскадные удаления `agentChatChannelRole`, когда удаляется родительский `agentChatChannel` или целевая роль `role` (включая кросс-приложенческие привязки), добавляя их в `record.agentChatChannelRole.flatEntityToDelete`.
     - В `runAuditedApplicationMetadataMigration`:
       - Снимать снимки `core."agentChatChannel"` и `core."agentChatChannelRole"` под `ORDER BY id FOR UPDATE`.
       - Проверять и записывать `agentChatChannel` (`create`, `update`, `delete`) и `agentChatChannelRole` (`create`, `delete`, включая каскады от удаления `role` или `agentChatChannel`), запрещать `agentChatChannelRole:update` и запрещать несистемное удаление стандартных каналов (`isCustom === false` при `!isStandardApplication`).
       - Повторно сверять снимки `agentChatChannel` и `agentChatChannelRole` после `audit.flush()`.
     - В `assertNoRemainingApplicationRoleOrPermissionMetadata`:
       - Проверять отсутствие оставшихся строк `core."agentChatChannel"` и `core."agentChatChannelRole"` для удаляемого `applicationId`, а также кросс-приложенческих строк `core."agentChatChannelRole"`, ссылающихся на `core."agentChatChannel"` или `core.role` удаляемого приложения.
     - В `WorkspaceMigrationValidateBuildAndRunService.validateBuildAndRunLegacyWorkspaceMigration`:
       - Если `isSystemBuild === true`, миграция затрагивает аудируемые метаданные (`AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES` / каскады) и ни один контекст метаданных аудита ещё не активен (`!hasConflictingMetadataAuditScope`), автоматически оборачивать запуск в `withApplicationMetadataAudit` с системным актором `'workspace-migration:legacy-system-build'` (это прозрачно поддерживает `AddAgentChatChannelsCommand` без изменения закоммиченного файла команды обновления).
- **Плюсы**: Полное покрытие всех точек создания, обновления, удаления и каскадного удаления `agentChatChannel` и `agentChatChannelRole`; отсутствие конфликтов `AsyncLocalStorage`; соблюдение границы Enterprise (`0` новых рёбер).

**Решение**: Принят **Вариант B**.

## 3. Детали реализации и защита от гонок / сбоев

1. **Изоляция от `@license Enterprise`**:
   - Ни один файл в `crm-audit/*`, `agent-chat-channel/*`, `ai-chat/*` или `role/*` не импортирует модули с `@license Enterprise`. Проверка `check_enterprise_dependencies.py` должна показать `0` нарушений.
2. **Порядок блокировок в БД**:
   - В `runAuditedNavigationMenuItemMigration` и `runAuditedApplicationMetadataMigration`: `core.workspace` (`FOR NO KEY UPDATE`) -> `core."userWorkspace"` / `core.application` (`FOR NO KEY UPDATE` / `FOR UPDATE`) -> таблицы метаданных (`role`, `agentChatChannel`, `agentChatChannelRole`, `navigationMenuItem` под `ORDER BY id FOR UPDATE`).
   - В `runAuditedRoleDelete` и `runAuditedUnusedAgentRoleDelete`: `core.workspace` (`FOR NO KEY UPDATE`) -> `core.application` (`FOR SHARE`) -> `core.role` (`ORDER BY id FOR UPDATE`) -> `core."roleTarget"` (`ORDER BY id FOR UPDATE`) -> `core."agentChatChannelRole"` (`ORDER BY id FOR UPDATE`).
3. **Обработка `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError`**:
   - В `WorkspaceMigrationRunnerService.executeRun` блок `finally` всегда инвалидирует кэши затронутых карт (`flatAgentChatChannelMaps`, `flatAgentChatChannelRoleMaps`, `flatNavigationMenuItemMaps`, `flatRoleMaps` и др.), а при `mayHaveCommitted` не запускает `executeActionRollbackHandler`.
   - В `AgentChatChannelService.updateChannel`: если переданы `roleIds` и миграция завершилась ошибкой `NativeTransactionOutcomeUnknownError` или `CoreAuditPostCommitError` (транзакция могла закоммититься), вызывается `enqueueChannelGrantsRewrite({ workspaceId, channelId })` в `catch` (best-effort), после чего ошибка пробрасывается дальше.

## 4. Стратегия тестирования (`crm-audit-agent-chat-channel.postgres-spec.ts`)

1. **Полный жизненный цикл `agentChatChannel` и `agentChatChannelRole` через `AgentChatChannelResolver` / `AgentChatChannelService` / `AgentChatChannelMetadataService`**:
   - Создание канала с начальным списком ролей (`agentChatChannel:create` + `agentChatChannelRole:create`), проверка редактирования `['name', 'icon', 'color', 'position']` и записи `isCustom: true`, `channelId`, `roleId`.
   - Обновление канала: переименование, смена иконки/цвета/позиции и замена набора ролей (`agentChatChannel:update` + `agentChatChannelRole:delete` + `agentChatChannelRole:create`), вызов `rewriteChannelGrants`.
   - Идемпотентный повтор `updateChannel` без фактических изменений: `0` лишних записей аудита.
   - Удаление канала с привязанными ролями и пунктами меню (`navigationMenuItem` типа `AGENT_CHAT_CHANNEL` внутри папки): в одной транзакции записываются `agentChatChannel:delete`, `agentChatChannelRole:delete` и каскадные `navigationMenuItem:delete`.
2. **Каскадное удаление `agentChatChannelRole` при удалении роли (`RoleService.deleteRole`, `DeleteRoleTool`, `AiAgentRoleService.deleteAgentOnlyRoleIfUnused`)**:
   - Удаление пользовательской роли, привязанной к каналу в `core."agentChatChannelRole"` и к участнику в `core."roleTarget"`: атомарная запись `agentChatChannelRole:delete`, `roleTarget:delete`, `roleTarget:create` и `role:delete`.
   - Отказ fail-closed при наличии незапланированной строки `core."agentChatChannelRole"` в БД (защита от устаревшего кэша).
   - Удаление неиспользуемой агентской роли в `AiAgentRoleService.deleteAgentOnlyRoleIfUnused` при наличии остаточной строки в `core."agentChatChannelRole"`: атомарное удаление и запись `agentChatChannelRole:delete` + `role:delete`.
3. **Пакетные миграции манифеста, синхронизация стандартного приложения, legacy system build и удаление приложения (`application-metadata-audit.ts`, `ApplicationService.delete`)**:
   - Синхронизация стандартного приложения / манифеста: создание стандартного канала `General` (`isCustom: false`), обновление и удаление каналов и ролевых привязок `agentChatChannelRole` (включая каскад при удалении роли в манифесте).
   - Проверка `assertNoRemainingApplicationRoleOrPermissionMetadata` при `ApplicationService.delete`: отказ при оставшихся `agentChatChannel` или `agentChatChannelRole` (включая кросс-приложенческие ссылки).
4. **Отказоустойчивость, fail-closed барьер и `NativeTransactionOutcomeUnknownError`**:
   - Прямой вызов `WorkspaceMigrationRunnerService.run` с `agentChatChannel` или `agentChatChannelRole` без контекста аудита отклоняется fail-closed.
   - Отказ при попытке удалить стандартный канал (`isCustom: false`) в несистемной миграции или создать `agentChatChannelRole` для несуществующей/чужой роли.
   - Откат транзакции при ошибке записи в `crm_audit."crmAuditEntry"` или ошибке триггера после `audit.flush()`.
   - При потере подтверждения коммита (`NativeTransactionOutcomeUnknownError`) в `AgentChatChannelService.updateChannel` коммит сохраняется, кэш инвалидируется и вызывается `enqueueChannelGrantsRewrite`.
