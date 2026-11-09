# LOG-178 - Дизайн транзакционного аудита полного жизненного цикла ИИ-навыков (`skill`, `core.skill`)

## 1. Контекст и постановка задачи

После закрытия `LOG-177` (`connectionProvider` и `reportAppConnectionAuthFailure`) в контуре безопасности, ИИ-агентов и метаданных приложений остаётся открытой поверхность управления ИИ-навыками (`core.skill`, `SkillEntity`):
1. **Роль `core.skill` в безопасности и поведении ИИ**:
   - Таблица `core.skill` (`SkillEntity`, наследует `SyncableEntity` с `workspaceId`, `applicationId` и `ON DELETE CASCADE` на `core.application(id)`, `universalIdentifier`) хранит инструкции и промпты ИИ-навыков (`name`, `label`, `icon`, `description`, `content`, `isCustom`, `isSystem`, `isActive`), которые загружаются в системный промпт чатов (`SystemPromptBuilderService`, `ChatExecutionService`), в набор инструментов агентов (`AgentToolsetService`, `load-skill.tool.ts`) и в MCP-сервер (`McpInstructionBuilderService`, `ListSkillsTool`).
   - Любое создание, изменение текста инструкции (`content`), переименование, активация/деактивация (`isActive`) или удаление навыка напрямую меняет инструкции ИИ-агентов в рабочем пространстве.
2. **Точки мутации `core.skill`**:
   - Пользовательские и прикладные GraphQL-мутации в `SkillResolver` (`createSkill`, `updateSkill`, `deleteSkill`, `activateSkill`, `deactivateSkill`, защищены `SettingsPermissionGuard(PermissionFlagType.AI_SETTINGS)`) и методы `SkillService` (`create`, `update`, `delete`, `activate`, `deactivate`), вызывающие `WorkspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration` с операциями `skill`.
   - Пакетная синхронизация манифестов приложений (`ApplicationManifestMigrationService.syncMetadataFromManifest`), синхронизация стандартного приложения (`TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`) и системные миграции (`isSystemBuild: true`, включая команды обновления стандартного каталога навыков), проходящие через `WorkspaceMigrationRunnerService.executeRun` (`CreateSkillActionHandlerService`, `UpdateSkillActionHandlerService`, `DeleteSkillActionHandlerService`).
   - Каскадное удаление `ON DELETE CASCADE` при прямом удалении `core.application` (`ApplicationService.delete`), если в `assertNoRemainingApplicationRoleOrPermissionMetadata` не проверяется отсутствие строк `core.skill`.

## 2. Рассмотренные варианты

### Вариант A (Рекомендуемый)
1. **Каталог ресурсов и административных действий (`crm-audit.types.ts`, `crm-audit-transaction-context.ts`)**:
   - Добавить `'skill'` в `CrmAuditResourceKind`.
   - В `CATALOG` добавить:
     - `skill`:
       - `values: ['applicationId', 'isCustom', 'isSystem', 'isActive']`
       - `redacted: ['name', 'label', 'icon', 'description', 'content']`
   - В `ADMINISTRATIVE_ACTIONS` установить:
     - `skill: ['create', 'update', 'delete']`.
2. **Точечный аудит `SkillService` и `SkillResolver` (`navigation-menu-item-audit.ts`, `skill.service.ts`, `skill.resolver.ts`, `workspace-migration-runner.service.ts`)**:
   - Расширить `NavigationMenuItemAuditMode` режимом `'skill'`, добавить `expectedSkillCreateIds`, `expectedSkillUpdateIds`, `expectedSkillDeleteIds` в `NavigationMenuItemAuditRequest` и `captureNavigationMenuItemAudit`, а также `skills?: Record<string, { id: string } | undefined>` в `NavigationMenuItemAuditMappings`.
   - В `runAuditedNavigationMenuItemMigration` (`mode: 'skill'`):
     - Разрешать только действия с `metadataName === 'skill'` и требовать явно заданный ожидаемый объём (`expectedSkillCreateIds` / `expectedSkillUpdateIds` / `expectedSkillDeleteIds`).
     - Под блокировкой `ORDER BY id FOR UPDATE` считывать снимок `core.skill` до выполнения миграции и проверять инварианты всех строк (`assertSkillRowInvariants`: UUID `id`, `workspaceId`, `applicationId`, `universalIdentifier`, отсутствие `deletedAt`, непустые строки `name`, `label`, `content`, nullable строки `icon`, `description`, булевы `isCustom`, `isSystem`, `isActive`).
     - Для удаления (`delete`) требовать `beforeRow.isCustom === true` и принадлежность `applicationId` целевому приложению миграции (`workspaceCustomFlatApplication`).
     - Для обновления (`update`) запрещать изменение `isCustom` и `isSystem` в режиме `mode: 'skill'`; если обновляется стандартный или принадлежащий другому приложению навык (`beforeRow.isCustom === false` или `uuid(beforeRow.applicationId) !== applicationId`), разрешать изменение только поля `isActive` (`activate` / `deactivate`) и проверять под `FOR NO KEY UPDATE`, что приложение-владелец навыка активно в `core.application`.
     - После выполнения миграции сверять созданные, обновлённые и удалённые строки `core.skill` с планом, записывать `skill:create`, `skill:update` (при изменении проекции) и `skill:delete` с `metadataAccess: 'currentWorkspaceAdministration'`, а после `audit.flush()` повторно проверять сериализованный снимок `core.skill`.
   - В `SkillService` (`create`, `update`, `delete`, `activate`, `deactivate`) захватывать входные параметры и контекст аудита синхронно до первого `await` и оборачивать вызов `validateBuildAndRunWorkspaceMigration` в `withNavigationMenuItemAudit`.
   - В `SkillResolver` (`createSkill`, `updateSkill`, `deleteSkill`, `activateSkill`, `deactivateSkill`) пробрасывать `authUserWorkspaceId`, `authApiKeyId`, `authApplicationId` и `auditIdentity: context?.req` в `SkillService`.
3. **Пакетные миграции приложений и барьер удаления `core.application` (`application-metadata-audit.ts`, `workspace-migration-runner.service.ts`)**:
   - Добавить `'skill'` в `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES` (fail-closed барьер на неаудируемые миграции `skill` в `WorkspaceMigrationRunnerService.executeRun` и автоматическая обёртка `withApplicationMetadataAudit` при `isSystemBuild: true` в `WorkspaceMigrationValidateBuildAndRunService`).
   - Добавить `skills?: Record<string, { id: string } | undefined>` в `ApplicationMetadataAuditMappings` и передавать `allFlatEntityMaps.flatSkillMaps?.byUniversalIdentifier ?? {}` в `WorkspaceMigrationRunnerService.executeRun`.
   - В `runAuditedApplicationMetadataMigration` добавить блокировку и чтение `core.skill` (`beforeSkills` / `afterSkills`), проверку инвариантов, запрет действий `skill` в `mode === 'objectDelete'` и `mode === 'fieldDelete'`, сверку `create`/`update`/`delete` с планом миграции, запись `skill:create`, `skill:update`, `skill:delete` и post-flush сверку снимка `core.skill`.
   - В `assertNoRemainingApplicationRoleOrPermissionMetadata` добавить `'skill'` в перечень таблиц, проверяемых перед удалением `core.application`.

### Вариант B (Отклонён)
- Аудировать только пользовательские вызовы `SkillService` без включения `'skill'` в `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES` и `application-metadata-audit.ts`.
- **Причина отклонения**: навыки также создаются, обновляются и удаляются через синхронизацию манифестов приложений (`ApplicationManifestMigrationService`), стандартного приложения (`TwentyStandardApplicationService`) и системных миграций (`isSystemBuild: true`), а при `DELETE FROM core.application` могли бы удаляться каскадно без записи в журнал аудита.

## 3. Стратегия тестирования

- Новый PostgreSQL-спецификационный файл `packages/twenty-server/test/fork-migration/crm-audit-skill.postgres-spec.ts`:
  1. Полный жизненный цикл через `SkillService` и `SkillResolver` (`createSkill`, идемпотентный `updateSkill` без фактических изменений, `updateSkill` с изменением `name`/`label`/`icon`/`description`/`content`, `deactivateSkill` и `activateSkill` как на пользовательском, так и на стандартном навыке `twenty-standard`, `deleteSkill`), проверка сохранения `values: { applicationId, isCustom, isSystem, isActive }` и редактирования `name`, `label`, `icon`, `description`, `content` (без утечки промпта в открытые `values`), а также атрибуции `workspaceMember` (с `impersonatorUserWorkspaceId`), `apiKey` и `application`.
  2. Пакетная синхронизация `skill` (`create`, идемпотентный повтор, `update`, `delete`) в `runAuditedApplicationMetadataMigration` и при `isSystemBuild: true`, блокировка `assertNoRemainingApplicationRoleOrPermissionMetadata` / `runAuditedApplicationDelete` при наличии оставшихся строк `core.skill` у приложения и fail-closed отказ `WorkspaceMigrationRunnerService.executeRun` на неаудируемой миграции `skill`.
  3. Откат транзакции при срабатывании post-flush триггера на `core.skill` и корректный проброс `NativeTransactionOutcomeUnknownError` без `ROLLBACK` при потере подтверждения `COMMIT`.
