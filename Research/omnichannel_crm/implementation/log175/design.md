# LOG175 - Дизайн транзакционного аудита полного жизненного цикла (`create`, `update`, `delete`) и каскадных удалений `webhook` (`core.webhook`)

## 1. Контекст и постановка задачи

В рамках этапа 2a (`ROB-765` - сбор аудита действий) после закрытия `LOG156`-`LOG174` остаётся непокрытым транзакционный аудит исходящих вебхуков рабочего пространства (`core.webhook`, сущность `WebhookEntity`, метаданные `webhook`).

Факты из кодовой базы:
1. **Схема таблицы `core.webhook` (`WebhookEntity`)**:
   - Расширяет `SyncableEntity` (`workspaceId`, `applicationId` с `ON DELETE CASCADE` на `core.application(id)`, `universalIdentifier` с уникальным индексом `(workspaceId, universalIdentifier)`).
   - Колонки: `id` (`uuid`), `workspaceId` (`uuid`), `applicationId` (`uuid`), `universalIdentifier` (`uuid`), `targetUrl` (`varchar`, `NOT NULL`), `operations` (`text[]`, `default ['*.*']`), `description` (`varchar`, `NULL`), `secret` (`varchar`, `NOT NULL`), `createdAt` (`timestamptz`), `updatedAt` (`timestamptz`), `deletedAt` (`timestamptz`, `NULL`).
   - Исходящие вебхуки доставляют события записей и метаданных рабочего пространства внешним HTTP/HTTPS получателям и подписывают нагрузку секретом `secret`. Создание, перенаправление `targetUrl`, расширение `operations`, смена `secret` или удаление вебхука являются критичными административными действиями (`PermissionFlagType.API_KEYS_AND_WEBHOOKS`).
2. **Точки мутации `core.webhook`**:
   - `WebhookService` (`packages/twenty-server/src/engine/metadata-modules/webhook/webhook.service.ts`):
     - `create(input, workspaceId)`: нормализует `targetUrl`, находит `workspaceCustomFlatApplication`, формирует `flatWebhookToCreate` и вызывает `workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration` с `webhook.flatEntityToCreate = [flatWebhookToCreate]`.
     - `update(input, workspaceId)`: нормализует `input.update.targetUrl`, находит существующий `flatWebhook` в `flatWebhookMaps`, формирует `flatWebhookToUpdate` и вызывает `validateBuildAndRunWorkspaceMigration` с `webhook.flatEntityToUpdate = [flatWebhookToUpdate]`.
     - `delete(id, workspaceId)`: находит существующий `flatWebhook` в `flatWebhookMaps` и вызывает `validateBuildAndRunWorkspaceMigration` с `webhook.flatEntityToDelete = [flatWebhookToDelete]`.
   - Вызывающие стороны `WebhookService`:
     - `WebhookResolver` (`createWebhook`, `updateWebhook`, `deleteWebhook`) - GraphQL-мутации под `AuthPrincipalGuard` и `SettingsPermissionGuard(PermissionFlagType.API_KEYS_AND_WEBHOOKS)`.
     - `WebhookController` (`create`, `update`, `remove`) - REST-эндпоинты `/rest/webhooks` и `/rest/metadata/webhooks` под `JwtAuthGuard`, `AuthPrincipalGuard` и `SettingsPermissionGuard(PermissionFlagType.API_KEYS_AND_WEBHOOKS)`.
     - AI-инструменты `CreateWebhookTool`, `UpdateWebhookTool`, `DeleteWebhookTool` (`packages/twenty-server/src/engine/metadata-modules/webhook/tools/`).
   - Пакетные миграции приложений и удаление приложений (`ApplicationSyncService.uninstallApplication`, `ApplicationManifestMigrationService.syncMetadataFromManifest`, `WorkspaceMigrationValidateBuildAndRunService`, `ApplicationService.delete`):
     - В `ApplicationSyncService.uninstallApplication` строится запись удаления по всем `ALL_METADATA_NAME` (включая `webhook`) для удаляемого приложения и выполняется внутри `withApplicationMetadataAudit` (`runAuditedApplicationMetadataMigration`), после чего вызывается `applicationService.delete` (`runAuditedApplicationDelete` -> `assertNoRemainingApplicationRoleOrPermissionMetadata`).
     - До `LOG175` `'webhook'` не входил в `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES`, не проверялся и не записывался в `runAuditedNavigationMenuItemMigration` и `runAuditedApplicationMetadataMigration`, и не проверялся в `assertNoRemainingApplicationRoleOrPermissionMetadata` перед `DELETE FROM core.application`.

## 2. Рассмотренные варианты архитектуры (ADR-175)

### Вариант A: Отдельный `AsyncLocalStorage`-модуль `webhook-audit.ts`
- **Плюсы**: изолированный файл для `WebhookService`.
- **Минусы**: дублирует инфраструктуру захвата субъекта (`userWorkspaceId` / `coreUser` / `workspaceMember` / `apiKey` / `application` / `agent` / `impersonatorUserWorkspaceId`), проверки таблиц субъектов и интеграцию с `WorkspaceMigrationRunnerService.executeRun` (`navigationMenuItemAudit`), увеличивая число проверяемых контекстов в `executeRun`.

### Вариант B (Рекомендуемый): Расширение каталога аудита ресурсом `webhook`, режим `mode: 'webhook'` в `navigation-menu-item-audit.ts` и поддержка `webhook` в `application-metadata-audit.ts` и `WorkspaceMigrationRunnerService`
- **Описание**:
  1. **Каталог аудита (`crm-audit.types.ts`, `crm-audit-transaction-context.ts`)**:
     - В `CrmAuditResourceKind` добавить `'webhook'`.
     - В `CATALOG` добавить:
       ```ts
       webhook: {
         values: ['applicationId'],
         redacted: ['targetUrl', 'operations', 'description', 'secret'],
       },
       ```
       Поле `applicationId` фиксируется в открытом виде в `redactedDiff.values.applicationId`, а чувствительные и текстовые поля (`targetUrl`, `operations`, `description`, `secret`) редактируются в `redactedDiff.changedFields` по SHA-256 хешам канонического JSON без сохранения секрета, URL или описания в открытом виде.
     - В `ADMINISTRATIVE_ACTIONS` добавить `webhook: ['create', 'update', 'delete']`.
  2. **Расширение `navigation-menu-item-audit.ts` режимом `mode: 'webhook'`**:
     - Добавить `'webhook'` в `NavigationMenuItemAuditMode`.
     - Добавить `expectedWebhookCreateIds`, `expectedWebhookUpdateIds`, `expectedWebhookDeleteIds` в `NavigationMenuItemAuditRequest` и `NavigationMenuItemAuditExpectedScope`, а также `webhooks?: Record<string, { id: string } | undefined>` в `NavigationMenuItemAuditMappings`.
     - Добавить `assertWebhookRowInvariants(row, workspaceId)` (проверка UUID `id`, `workspaceId`, `applicationId`, `universalIdentifier`, `deletedAt === null`, валидного `http:`/`https:` `targetUrl`, массива строк `operations`, `description: string | null`, `secret: string`) и `projectWebhook(row)`.
     - В `runAuditedNavigationMenuItemMigration`:
       - При `request.mode === 'webhook'` разрешать только действия с `action.metadataName === 'webhook'` и требовать явного ожидаемого скоупа (`expectedWebhookCreateIds`, `expectedWebhookUpdateIds` или `expectedWebhookDeleteIds`), не блокируя без необходимости таблицу `core."navigationMenuItem"`.
       - Блокировать все строки `core.webhook` рабочего пространства (`WHERE "workspaceId"=$1 ORDER BY id FOR UPDATE`) до выполнения действий, проверять инварианты всех существующих строк и принадлежность обновляемых/удаляемых строк активным приложениям рабочего пространства.
       - После выполнения `execute(runner)` повторно считывать снимок `core.webhook`, проверять инварианты и точное соответствие созданных, обновлённых и удалённых строк плану миграции (включая неизменность `applicationId` и `universalIdentifier` при `update` и поэлементное сравнение `operations` через `canonicalAuditJson`), записывать `webhook:create`, `webhook:update` (только при фактическом изменении проекции) и `webhook:delete` в `CrmAuditTransactionContext`, вызывать `audit.flush()` и повторно сверять снимок `core.webhook` после `audit.flush()`.
  3. **Подключение `WebhookService`, `WebhookResolver`, `WebhookController` и AI-инструментов**:
     - В `WebhookService.create`, `WebhookService.update`, `WebhookService.delete` добавить необязательный параметр `options?: WebhookAuditOptions` (`auditIdentity`, `authUserWorkspaceId`, `authApiKeyId`, `authApplicationId`, `authAgentId`, `capturedAudit`).
     - До первого `await` синхронно снимать копию входных данных (защита от TOCTOU) и вызывать `captureNavigationMenuItemAudit({ workspaceId, mode: 'webhook', ... })` (fail-closed без `defaultSystemActorId`: вызов без аутентифицированного субъекта или ambient-операции отклоняется).
     - Оборачивать `validateBuildAndRunWorkspaceMigration` в `withNavigationMenuItemAudit(getWebhookAudit({ expectedWebhookCreateIds / expectedWebhookUpdateIds / expectedWebhookDeleteIds }), ...)`.
     - В `WebhookResolver` (`createWebhook`, `updateWebhook`, `deleteWebhook`), `WebhookController` (`create`, `update`, `remove`) и AI-инструментах (`CreateWebhookTool`, `UpdateWebhookTool`, `DeleteWebhookTool`) передавать атрибуцию вызывающего субъекта в `WebhookService` с использованием структурных типов без добавления новых импортов `@license Enterprise`.
  4. **Пакетные миграции приложений, удаление приложений и fail-closed барьер (`application-metadata-audit.ts`, `workspace-migration-runner.service.ts`)**:
     - Добавить `'webhook'` в `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES` (любая миграция в `WorkspaceMigrationRunnerService.executeRun`, затрагивающая `webhook` без активного контекста аудита, отклоняется fail-closed).
     - В `WorkspaceMigrationRunnerService.executeRun` передавать `webhooks: allFlatEntityMaps.flatWebhookMaps?.byUniversalIdentifier ?? {}` в `mappings` как для `navigationMenuItemAudit`, так и для `applicationMetadataAudit`.
     - В `runAuditedApplicationMetadataMigration` (`application-metadata-audit.ts`):
       - Снимать снимок `core.webhook` под `ORDER BY id FOR UPDATE` (если таблица существует), проверять инварианты строк, запрещать действия `webhook` в режимах `objectDelete` и `fieldDelete`, проверять и записывать `webhook` (`create`, `update`, `delete`) для целевого `applicationId` и повторно сверять снимок `core.webhook` после `audit.flush()`.
     - В `assertNoRemainingApplicationRoleOrPermissionMetadata`:
       - Проверять отсутствие оставшихся строк в `core.webhook` для удаляемого `applicationId` (включая проверку по `applicationId` без фильтра `deletedAt`, чтобы исключить тихое каскадное удаление `ON DELETE CASCADE` при `DELETE FROM core.application`).

**Решение**: Принят **Вариант B**.

## 3. Безопасность, изоляция от `@license Enterprise` и отказоустойчивость

1. **Граница Enterprise**:
   - В `webhook.resolver.ts`, `webhook.controller.ts`, `webhook.service.ts`, `create-webhook.tool.ts`, `update-webhook.tool.ts`, `delete-webhook.tool.ts`, `navigation-menu-item-audit.ts` и `application-metadata-audit.ts` не добавляется ни одного нового импорта модулей, транзитивно достигающих `@license Enterprise`.
2. **Редактирование секретов и URL**:
   - `targetUrl`, `operations`, `description` и `secret` входят в `CATALOG.webhook.redacted` и никогда не сохраняются в `redactedDiff.values`.
3. **Обработка `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError`**:
   - В `WorkspaceMigrationRunnerService.executeRun` блок `finally` безусловно инвалидирует `flatWebhookMaps`, а при `mayHaveCommitted` не запускает `executeActionRollbackHandler` и пробрасывает ошибку вызывающему коду без потери классификации.
