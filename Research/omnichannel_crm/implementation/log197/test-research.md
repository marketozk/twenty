# Test Research LOG-197

## Целевой новый PostgreSQL-спек
`packages/twenty-server/test/fork-migration/crm-audit-core-view-lifecycle.postgres-spec.ts` (4 сценария):
1. Жизненный цикл `coreView` через `ViewResolver`, `ViewController`, `ViewService` и `CompleteViewUpsertService`:
   - `ViewResolver.createView` (`WORKSPACE` и `UNLISTED` с имперсонацией и редактированием `name`, `icon`, `position`, `anyFieldFilterValue`, `overrides`).
   - `ViewController.create` (REST `WORKSPACE` и `UNLISTED` с `userWorkspaceId` и `auditIdentity`).
   - `CompleteViewUpsertService.upsertCompleteView` (`create` с `coreView:create`, и children-only update без ложного аудита).
   - `ViewResolver.deleteView` / `ViewService.destroyOne` (жёсткое удаление кастомного `view` с каскадным `navigationMenuItem:delete` под одним `operationId`, и мягкая деактивация overridden стандартного `view` через `shouldDeactivate === true` -> `coreView:update` с `isActive: true -> false` и `redactedFields: ['overrides']`).
2. Fail-closed барьер и инварианты в `WorkspaceMigrationRunnerService.executeRun`:
   - Отказ на `view:create`, `view:delete` и `view:update` с `universalOverrides: null` (реактивация / раскрытие `UNLISTED`) без audit scope.
   - Разрешение обычного non-security UI `view:update` (`name`/`icon` и `universalOverrides` с неизменными `isActive`/`visibility`) без audit scope.
   - Отказ при попытке создать `UNLISTED` view без `userWorkspaceId` и при подмене `createdByUserWorkspaceId`.
3. Пакетные миграции и каскады:
   - `runAuditedApplicationMetadataMigration` (`manifest` `create` / `update` (`isActive`/`overrides`) / `delete` и отказ при незапланированном `INSERT`/`DELETE` в `core.view`).
   - Каскадное удаление чужого `core.view` (в т.ч. через `kanbanAggregateOperationFieldMetadataId` `ON DELETE CASCADE`) при `objectDelete` / `fieldDelete`.
   - `navigation-menu-item-audit` (`cascade` с `expectedCreatedObjectId` -> `coreView:create`, и отказ при неразрешённом security-значимом `view:update`).
   - `assertNoRemainingApplicationRoleOrPermissionMetadata` (блокировка удаления `core.application` при остатке `core.view` напрямую, по `objectMetadataId` или по `fieldMetadata` включая `kanbanAggregateOperationFieldMetadataId`).
4. Атомарность и откат:
   - Сбой `audit.flush()` (триггер на `crm_audit."crmAuditEntry"`) откатывает `coreView:create`, `coreView:update` (deactivation) и `coreView:delete`.
   - Post-flush row drift в `core.view` откатывает транзакцию целиком.

## Связанные существующие регрессионные спеки для таргетного прогона
- `packages/twenty-server/test/fork-migration/crm-audit-core-view-lifecycle.postgres-spec.ts` (новый)
- `packages/twenty-server/test/fork-migration/crm-audit-core-workflow-and-view.postgres-spec.ts` (`LOG169`)
- `packages/twenty-server/test/fork-migration/crm-audit-navigation-menu-item.postgres-spec.ts` (`LOG170`)
- `packages/twenty-server/test/fork-migration/crm-audit-page-layout.postgres-spec.ts` (`LOG183`)
- `packages/twenty-server/test/fork-migration/crm-audit-index-metadata.postgres-spec.ts` (`LOG196`)
- `packages/twenty-server/src/engine/metadata-modules/view/tools/__tests__/view-tools.spec.ts`
