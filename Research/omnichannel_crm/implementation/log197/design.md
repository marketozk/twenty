# Design LOG-197: транзакционный аудит полного жизненного цикла `coreView` (`core.view`)

## Цель и граница
Закрыть транзакционный аудит создания, деактивации и жёсткого удаления представлений (`coreView` в `core.view`), дополнив аудит смены владельца и видимости из `LOG169` и каскадов `navigationMenuItem` из `LOG170`:
1. `CATALOG.coreView` и `ADMINISTRATIVE_ACTIONS.coreView` в `crm-audit-transaction-context.ts`:
   - `ADMINISTRATIVE_ACTIONS.coreView`: `['create', 'update', 'delete']`.
   - `CATALOG.coreView`:
     - `values`: `['applicationId', 'objectMetadataId', 'type', 'key', 'isCustom', 'isActive', 'isSystemSideEffect', 'createdByUserWorkspaceId', 'visibility']`
     - `redacted`: `['name', 'icon', 'position', 'anyFieldFilterValue', 'overrides']`
   - Проекция `projectCoreView(row)`:
     - `isActive` вычисляется с учётом `overrides` (legacy плоский объект `{ isActive }` или authored map `{ [authorUid]: { isActive } }` с приоритетом non-owner entry над owner и fallback на `row.isActive ?? true`).
     - При смене только `visibility`/`createdByUserWorkspaceId` (`LOG169`) все остальные поля неизменны, поэтому `redactedDiff.changedFields` остаётся точно `['createdByUserWorkspaceId', 'visibility']` / `['visibility']`.
     - Обычные UI-обновления (`name`, `icon`, `position`, и т.д. без смены `visibility`, `createdByUserWorkspaceId`, `isActive` и без `overrides.isActive`/`overrides.visibility`) по-прежнему не генерируют шумный аудит (`ViewService.updateOne`).

2. `core-workflow-and-view-audit.ts`:
   - Расширяем `CoreViewAuditRequest`:
     - `CoreViewCreateAuditRequest` (`kind: 'coreViewCreate'`, `workspaceId`, `viewId`, `userWorkspaceId?`, `operation`, `impersonatorUserWorkspaceId?`)
     - `CoreViewUpdateAuditRequest` (`kind: 'coreViewUpdate'`, `workspaceId`, `viewId`, `userWorkspaceId?`, `expectDeactivate?: boolean`, `operation`, `impersonatorUserWorkspaceId?`)
   - Хелперы:
     - `projectCoreView(row)` и `resolveEffectiveViewIsActive(row)`
     - `isAuditedCoreViewAction(action)`: возвращает `true` для `action.metadataName === 'view'` если:
       - `action.type === 'create'`
       - `action.type === 'delete'`
       - `action.type === 'update'` и `action.update` затрагивает `visibility`, `createdByUserWorkspaceId`, `isActive`, либо `overrides` / `universalOverrides` содержат изменение `isActive` или `visibility`
     - `captureCoreViewCreateAudit({ workspaceId, userWorkspaceId, auditIdentity })` -> синхронная фабрика `(viewId: string) => CoreViewCreateAuditRequest` (захватывает и валидирует `operation` синхронно до первого `await`, а `viewId` подставляется после `fromCreateViewInputToFlatViewToCreate`).
     - `captureCoreViewUpdateAudit({ workspaceId, viewId, userWorkspaceId, expectDeactivate, auditIdentity })` -> существующая фабрика, расширенная `expectDeactivate?: boolean`.
     - `withCoreViewAudit` (и алиас `withCoreViewUpdateAudit`), `getCoreViewAudit` (и алиас `getCoreViewUpdateAudit`).
     - `runAuditedCoreViewMutation` (и алиас `runAuditedCoreViewUpdate`):
       - Разрешает `view` (для `coreViewCreate` - ровно 1 `create` с совпадающим `id`; для `coreViewUpdate` - только `update` на `request.viewId`) + дочерние `viewGroup`, `viewField`, `viewFilter`, `viewSort`.
       - Для `coreViewCreate`:
         - Блокирует `core.workspace` `FOR KEY SHARE`, проверяет активное членство `userWorkspaceId` (если задан).
         - Проверяет отсутствие существующей строки с `id = request.viewId`.
         - Выполняет `work(runner)`.
         - Читает созданную строку `core.view` `FOR NO KEY UPDATE`, проверяет `deletedAt === null`, `workspaceId`, `applicationId === mappings.application.id`, и инвариант `UNLISTED => createdByUserWorkspaceId !== null && createdByUserWorkspaceId === request.userWorkspaceId`.
         - Записывает `coreView:create` с `after: projectCoreView(afterView)` и `securityDescriptor: { resourceKind: 'coreView', resourceId: request.viewId, metadataAccess: 'currentWorkspaceAdministration' }`.
         - `await audit.flush()` и пост-flush сверка `canonicalAuditJson(postFlushView.row) === canonicalAuditJson(afterView.row)`.
       - Для `coreViewUpdate`:
         - Сохраняет все проверки `LOG169` (`visibility`, `createdByUserWorkspaceId`, защита `UNLISTED`).
         - При `expectDeactivate: true`: проверяет, что `beforeView` активен (или изменяется), `afterView` имеет эффективный `isActive === false` и `beforeView -> afterView` действительно изменился, и если `beforeVisibility === 'UNLISTED'`, допускает деактивацию только его создателем (при наличии `userWorkspaceId` или запрещает при `userWorkspaceId === undefined`).
         - При изменении `visibility`, `createdByUserWorkspaceId` или эффективного `isActive` (или при `expectDeactivate: true` и изменении проекции) записывает `coreView:update` с `before: projectCoreView(beforeView)`, `after: projectCoreView(afterView)`, `await audit.flush()` и пост-flush сверкой.

3. Подключение callers:
   - `ViewResolver`:
     - `createView`: добавить `@Context() context?: { req?: CoreWorkflowAndViewAuditIdentity }` и передать `auditIdentity: context?.req`.
     - `deleteView` / `destroyView`: добавить `@AuthUserWorkspaceId({ allowUndefined: true }) userWorkspaceId?: string` и передать `userWorkspaceId` вместе с `auditIdentity: context?.req`.
   - `ViewController`:
     - `create`: добавить `@Req() request?: AuthenticatedRequest` (и `@AuthUserWorkspaceId({ allowUndefined: true })` не меняем, чтобы не менять бизнес-контракт REST create) и передать `auditIdentity: request as never`.
     - `delete`: добавить `@AuthUserWorkspaceId({ allowUndefined: true }) userWorkspaceId?: string` (опциональный в конце списка параметров или с дефолтом, проверив вызовы) — лучше `@AuthUserWorkspaceId({ allowUndefined: true })` передать в `deleteOne`, причём сохранить порядок существующих параметров `(id, workspace, request, userWorkspaceId)` чтобы не сломать ни один прямой вызов контроллера в тестах!
   - `ViewService`:
     - `createOne`: добавить опциональный `auditIdentity?: CoreWorkflowAndViewAuditIdentity`; синхронно вызвать `captureCoreViewCreateAudit(...)` до первого `await`; обернуть `validateBuildAndRunWorkspaceMigration` в `withCoreViewAudit(getCreateAudit(flatViewToCreate.id), ...)`.
     - `deleteOne` / `destroyOne`: добавить опциональный `userWorkspaceId?: string`; синхронно захватить ДО первого `await` оба возможных аудита (`getCascadeAudit` для физического удаления и `getDeactivateAudit` для `shouldDeactivate === true`); при `shouldDeactivate === true` обернуть `runMigration` в `withCoreViewAudit(getDeactivateAudit(), runMigration)`, при `shouldDeactivate === false` оставить `withNavigationMenuItemAudit(getCascadeAudit({ expectedParentViewDeleteIds: [existingFlatView.id] }), runMigration)`.
   - `CompleteViewUpsertService.upsertCompleteView`:
     - Добавить опциональный `auditIdentity?: CoreWorkflowAndViewAuditIdentity`.
     - Синхронно захватить до первого `await` аудит (`captureCoreViewCreateAudit` при `!existingViewId`, или `captureCoreViewUpdateAudit` при `existingViewId` если передан `visibility` или `auditIdentity`).
     - Обернуть `validateBuildAndRunWorkspaceMigration` в `withCoreViewAudit(...)` при создании `view` или при security-значимом обновлении `view`.

4. `navigation-menu-item-audit.ts`:
   - В `runAuditedNavigationMenuItemMigration` для режима `cascade`:
     - Учитываем `plannedViewCreates` (для `ObjectMetadataService.createOneObject`, когда создаётся `flatInitialViewToCreate` или системный `view` вместе с новым объектом) и `plannedViewDeletes` (для `ViewService.destroyOne`/`deleteOne`, `FieldMetadataService.updateOneField`/`deleteOneField`).
     - Блокируем и читаем `beforeViews` (`SELECT to_jsonb(v) AS row FROM core.view v WHERE v."workspaceId"=$1 ORDER BY v.id FOR UPDATE`), если `reg?.hasViewTable === true && (plannedViewCreates.size > 0 || plannedViewDeletes.size > 0 || plannedObjectDeletes.size > 0 || plannedFieldDeletes.size > 0 || request.expectedCreatedObjectId !== undefined)`.
     - После `await execute(runner)` читаем `afterViews` (если `tracksViews`), проверяем:
       - Все `plannedViewDeletes` удалены;
       - Каждая удалённая строка `core.view` либо в `plannedViewDeletes`, либо каскадно привязана к `plannedObjectDeletes` / `plannedFieldDeletes`;
       - Для каждой удалённой строки записываем `coreView:delete` с `before: projectCoreView(beforeRow)` в том же `CrmAuditTransactionContext` (тот же `operationId`, что и каскадный `navigationMenuItem:delete`!);
       - Каждая новая строка `core.view` (при `plannedViewCreates.size > 0` или `request.expectedCreatedObjectId !== undefined`) проверена на `workspaceId` и `applicationId` и записана как `coreView:create` с `after: projectCoreView(afterRow)`;
       - Ни одна оставшаяся строка `core.view` не изменила `visibility`, `createdByUserWorkspaceId` или эффективный `isActive` незапланированно;
       - После `audit.flush()` делаем пост-flush проверку `core.view` (`canonicalAuditJson` по `afterViews` == `postFlushViews`)!

5. `application-metadata-audit.ts`:
   - В `runAuditedApplicationMetadataMigration` (блок 9):
     - Записываем `coreView:create` для новых строк `core.view` (сохраняя существующую проверку `visibility === 'WORKSPACE' && createdByUserWorkspaceId === null` и `applicationId === applicationId`).
     - Записываем `coreView:delete` для удалённых строк `core.view` (с проверкой, что удаление запланировано в `plannedViewDeletes` или каскадно от `plannedObjectDeletes` / `plannedFieldDeletes`).
     - Записываем `coreView:update` при изменении `visibility`, `createdByUserWorkspaceId` или эффективного `isActive` (проверяя `plannedAuditedViewUpdates`, с `projectCoreView(beforeVw)` / `projectCoreView(afterVw)`).
     - Пост-flush проверка использует `projectCoreView` для `core.view`.
   - В `assertNoRemainingApplicationRoleOrPermissionMetadata`:
     - Добавить `'view'` в список проверяемых таблиц (`SELECT id FROM core."view" WHERE "workspaceId"=$1 AND "applicationId"=$2 LIMIT 1`), а также проверить каскадные остатки `core.view` по `objectMetadataId` и по `calendarFieldMetadataId` / `mainGroupByFieldMetadataId` / `kanbanAggregateOperationFieldMetadataId` для удаляемого `applicationId`.

6. Fail-closed барьер в `WorkspaceMigrationRunnerService.executeRun` и `WorkspaceMigrationValidateBuildAndRunService`:
   - Добавить `isAuditedCoreViewAction(action as never)` (заменяя/расширяя проверку для `view` рядом с `isAuditedWorkflowOrViewUpdateAction`) в:
     - `WorkspaceMigrationRunnerService.executeRun` fail-closed barrier (строка ~1051)
     - `WorkspaceMigrationValidateBuildAndRunService.needsSystemApplicationAudit` (строка ~217)
   - В `WorkspaceMigrationRunnerService.executeRun`:
     - При активном `coreViewAudit` (`getCoreViewAudit(workspaceId)`): вызывать `runAuditedCoreViewMutation(...)`.

## Оценка рисков и совместимость
- `crm-audit-core-workflow-and-view.postgres-spec.ts` (`LOG169`):
  - При `updateView` меняющем только `visibility` -> дифф содержит ровно `['createdByUserWorkspaceId', 'visibility']` / `['visibility']`.
  - При `updateView` меняющем только `name`/`icon` -> не аудируется (`requiresViewAudit === false`).
  - При `application-metadata-audit` меняющем `visibility`/`createdByUserWorkspaceId` -> дифф ровно `['createdByUserWorkspaceId', 'visibility']`.
- `crm-audit-navigation-menu-item.postgres-spec.ts` (`LOG170`):
  - Фильтрует `WHERE "resourceKind"='navigationMenuItem'`, не ломается от добавления записей `coreView:delete` / `coreView:create`.
- `view-tools.spec.ts`:
  - `CreateViewTool` и `DeleteViewTool` не меняют аргументы вызова `viewService.createOne` / `viewService.deleteOne`; `ViewService` подхватывает ambient `captureCurrentCrmAuditOperation` когда `auditIdentity` не передан.
- Enterprise boundary:
  - Все новые зависимости остаются внутри `core-modules/crm-audit` и `metadata-modules/view`; не импортируются `@license Enterprise` модули.
