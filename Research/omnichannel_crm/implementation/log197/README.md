# LOG-197: транзакционный аудит полного жизненного цикла `coreView` (`core.view`)

## Объём изменений
- `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`: расширены `CATALOG.coreView` (`values`: `applicationId`, `objectMetadataId`, `type`, `key`, `isCustom`, `isActive`, `isSystemSideEffect`, `createdByUserWorkspaceId`, `visibility`; `redacted`: `name`, `icon`, `position`, `anyFieldFilterValue`, `overrides`) и `ADMINISTRATIVE_ACTIONS.coreView` (`['create', 'update', 'delete']`).
- `packages/twenty-server/src/engine/core-modules/crm-audit/core-workflow-and-view-audit.ts`: добавлены `projectCoreView`, `resolveEffectiveViewIsActive`, `resolveEffectiveViewVisibility`, stateful `isAuditedCoreViewAction` (с учётом legacy и authored `overrides`/`universalOverrides` включая `*UniversalIdentifier` ключи), `captureCoreViewCreateAudit`, расширенный `captureCoreViewUpdateAudit` (`expectDeactivate`, `defaultSystemActorId` с `operationId`, `RequestLikeAuditIdentity`), `withCoreViewAudit`, `getCoreViewAudit` и `runAuditedCoreViewMutation` (с workspace-wide блокировкой `core.view FOR UPDATE OF v`, блокировкой `core.application FOR KEY SHARE`, проверкой `createdByUserWorkspaceId === (request.userWorkspaceId ?? null)` и пост-flush сверкой).
- `packages/twenty-server/src/engine/metadata-modules/view/resolvers/view.resolver.ts`, `controllers/view.controller.ts`, `services/view.service.ts`, `tools/services/complete-view-upsert.service.ts`, `tools/create-view.tool.ts`, `tools/update-view.tool.ts`, `tools/delete-view.tool.ts`, `tools/upsert-complete-view.tool.ts`: подключён синхронный захват аудита для `createOne`, `updateOne` (эффективные `visibility`/`isActive`/`createdByUserWorkspaceId`), `deleteOne` / `destroyOne` (жёсткое удаление и мягкая деактивация overridden views через `shouldDeactivate === true`) и `upsertCompleteView`, а также условный проброс `auditIdentity` и `userWorkspaceId` из AI tools.
- `packages/twenty-server/src/engine/core-modules/crm-audit/navigation-menu-item-audit.ts`: в режиме `cascade` добавлен транзакционный аудит `coreView:create` (при `expectedCreatedObjectId`) и `coreView:delete` (при `ViewService.destroyOne` / `deleteOne`, `ObjectMetadataService.delete*` и `FieldMetadataService.update/delete*` включая `kanbanAggregateOperationFieldMetadataId`), запрет security-значимых `view:update`, проверка `deletedAt`/`applicationId`/`objectMetadataId` и пост-flush сверка.
- `packages/twenty-server/src/engine/core-modules/crm-audit/application-metadata-audit.ts`: добавлены `plannedViewCreatesByUniversalId`, stateful `isAuditedCoreViewAction` для `manifest` обновлений `isActive`/`overrides`, аудит `coreView:create`/`update`/`delete` (с различением прямого удаления и FK-каскада чужих views включая `kanbanAggregateOperationFieldMetadataId`), проверка `deletedAt`/`applicationId`/`objectMetadataId`, пост-flush сверка с `projectCoreView` и проверка остатков `core.view` (прямых и зависимых через `objectMetadata` / `fieldMetadata` с `to_jsonb(v)->>'kanbanAggregateOperationFieldMetadataId'`) в `assertNoRemainingApplicationRoleOrPermissionMetadata`.
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service.ts` и `services/workspace-migration-validate-build-and-run-service.ts`: подключены `getCoreViewAudit` / `runAuditedCoreViewMutation` и stateful fail-closed барьер `isAuditedCoreViewAction`.
- `packages/twenty-server/test/fork-migration/crm-audit-core-view-lifecycle.postgres-spec.ts`: 4 реальных PostgreSQL-теста жизненного цикла `coreView`, fail-closed барьера (включая legacy `universalOverrides` и `universalOverrides: null`), пакетных/каскадных миграций и rollback при сбое flush / post-flush drift.
- `packages/twenty-server/test/fork-migration/crm-audit-navigation-menu-item.postgres-spec.ts`: дополнен мок `actionHandlerRegistry` обработкой `view:create` для `ObjectMetadataService.createOneObject`.

## Артефакты
- [design.md](design.md)
- [design-review.md](design-review.md)
- [test-research.md](test-research.md)
- [review.md](review.md)
- [results.json](results.json)
- [source-snapshot.json](source-snapshot.json)
- [typecheck-differential.json](typecheck-differential.json)
- [regression.log](regression.log)
- [next-boundary.md](next-boundary.md)
