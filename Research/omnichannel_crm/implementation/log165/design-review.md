# Независимое ревью дизайна и плана тестирования LOG165 (ROB-765)

## Общий вердикт

Архитектура `LOG165`, представленная в `design.md` и `test-research.md`, корректно закрывает оставшиеся пути пакетной синхронизации и удаления метаданных приложений (`ApplicationManifestMigrationService.syncMetadataFromManifest`, `ApplicationSyncService.uninstallApplication` + `ApplicationService.delete`, `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`) транзакционным CRM-аудитом в едином контуре с `WorkspaceMigrationRunnerService.executeRun`.

В ходе прямой сверки с исходным кодом выявлен ряд критических технических нюансов и граничных случаев, которые необходимо учесть при реализации, чтобы избежать:
1. падения `scripts/omnichannel/check_enterprise_dependencies.py --verify-baseline` из-за скрытых транзитивных рёбер в `@license Enterprise`;
2. конфликта контекстов аудита (`hasConflictingMetadataAuditScope`) между миграцией метаданных и последующим обновлением `core.application."defaultRoleId"`;
3. потери строки `core."roleTarget"` из-за порядка действий в `computeOrderedMigrationActions` (`role.delete` перед `roleTarget.update`) при одновременном удалении роли манифеста и перепривязке агента;
4. отказа валидаторов удаления прав (`ROLE_NOT_EDITABLE`) при удалении объектов/полей/флагов приложения, на которые ссылаются не-редактируемые роли (`isEditable: false`);
5. ошибки разрешения связей до `work(runner)` для сущностей, создаваемых в той же миграции (`objectMetadata`, `fieldMetadata`, `permissionFlag`, `agent`, `role`, `rowLevelPermissionPredicateGroup`).

Ниже приведён детальный разбор по всем пяти вопросам ревью.

---

## 1. Полнота покрытия путей миграции метаданных приложений

### 1.1. Три основных пути из `design.md`
Дизайн охватывает все три пути пакетной миграции метаданных приложений, которые могут изменять `core.role`, `core."roleTarget"` и 5 таблиц прав:
1. `ApplicationManifestMigrationService.syncMetadataFromManifest` (`packages/twenty-server/src/engine/core-modules/application/application-manifest/application-manifest-migration.service.ts:173`) - вызывается при первичной установке, обновлении и dev-синхронизации манифеста (`ApplicationSyncService.synchronizeFromManifest`, `ApplicationManifestApplyService.applyManifestToWorkspace`, `ApplicationDevelopmentService.syncApplication`, `ApplicationInstallService.installApplication`).
2. `ApplicationSyncService.uninstallApplication` (`runUninstall`, `packages/twenty-server/src/engine/core-modules/application/application-manifest/application-sync.service.ts:368, 403`) и `ApplicationService.delete` (`packages/twenty-server/src/engine/core-modules/application/application.service.ts:931`) - вызываются при штатном удалении приложения (`ApplicationUninstallRunnerService`) и при откате неудавшейся первичной установки в `ApplicationInstallService.installApplication` (`application-install.service.ts:601`).
3. `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow` (`packages/twenty-server/src/engine/workspace-manager/twenty-standard-application/services/twenty-standard-application.service.ts:41`) - вызывается из `WorkspaceManagerService.init` и `DevSeederWorkspaceService`.

### 1.2. Проверка остальных вызовов `WorkspaceMigrationValidateBuildAndRunService` в модулях приложений
- `ApplicationManifestMigrationService.syncPreInstallLogicFunctionFromManifest` (`application-manifest-migration.service.ts:46`) строит `preInstallOnlyManifest` со строго пустыми `roles: []`, `agents: []`, `permissionFlags: []`, `objects: []`, `fields: []` и без `inferDeletionFromMissingEntities`. Он никогда не затрагивает 7 аудируемых таблиц и безопасно проходит через неаудируемую ветку `WorkspaceMigrationRunnerService.executeRun`.
- `TwentyStandardApplicationService.seedStandardObjectInitialViewsOrThrow` (`twenty-standard-application.service.ts:193`) создаёт только `view` и `viewField` и также не затрагивает 7 таблиц.

### 1.3. Обязательные требования к точкам входа и границам scope
1. **Не оборачивать `syncApplicationReferencesFromManifest` и `setStandardApplicationDefaultRoleOrThrow` в активный `AsyncLocalStorage` контекста `applicationMetadataAudit`**:
   - В `ApplicationManifestMigrationService.syncMetadataFromManifest` после завершения миграции вызывается `this.syncApplicationReferencesFromManifest` (`application-manifest-migration.service.ts:321`), который вызывает `this.applicationService.update(..., { defaultRoleId })` -> `captureApplicationDefaultRoleAudit`.
   - В `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow` после `validateBuildAndRunWorkspaceMigrationFromTo` вызывается `this.setStandardApplicationDefaultRoleOrThrow` (`twenty-standard-application.service.ts:139`) -> `this.applicationService.update(..., { defaultRoleId: adminFlatRole.id })` -> `captureApplicationDefaultRoleAudit`.
   - Поскольку `getApplicationMetadataAudit` и `getApplicationDefaultRoleAudit` оба регистрируются в `registerMetadataAuditScopeCheck`, активный контекст `withApplicationMetadataAudit` должен оборачивать **только** вызов `validateBuildAndRunMigration(false)` / `validateBuildAndRunWorkspaceMigrationFromTo` и завершаться до вызова `applicationService.update`. Иначе `captureApplicationDefaultRoleAudit` выбросит `'Nested application default role audit is unsupported'`.
2. **Не оборачивать `connectedAccountMetadataService.deleteManyByConnectionProviderIds` в `withApplicationMetadataAudit`**:
   - В `syncMetadataFromManifest` (`application-manifest-migration.service.ts:292-307`) при `shouldDeleteConnectedAccounts === true` сначала выполняется `validateBuildAndRunMigration(true)` (`dryRun: true`), затем `connectedAccountMetadataService.deleteManyByConnectionProviderIds(...)`, и только затем боевой `validateBuildAndRunMigration(false)`.
   - Захват атрибуции (`captureApplicationMetadataAudit`) должен выполняться синхронно в самом начале `syncMetadataFromManifest` (когда `!dryRun`), но вход в `withApplicationMetadataAudit` должен происходить только вокруг боевого `validateBuildAndRunMigration(false)`.
3. **Режим `dryRun: true` и миграции с `actions.length === 0`**:
   - При `dryRun === true` в `ApplicationSyncService.synchronizeFromManifest` `ownerFlatApplication` может быть виртуальным (`buildVirtualDryRunFlatApplication`, отсутствует в `core.application`), а `WorkspaceMigrationRunnerService.run` не вызывается (`workspace-migration-validate-build-and-run-service.ts:160`). При `dryRun === true` контекст `applicationMetadataAudit` открывать не нужно.
   - При `dryRun === false`, если план миграции пуст (`workspaceMigration.actions.length === 0`), `WorkspaceMigrationValidateBuildAndRunService` возвращает успех без вызова `workspaceMigrationRunnerService.run`. Поэтому `withApplicationMetadataAudit` должен валидировать субъект аудита синхронно при входе, но корректно завершаться в `finally`, если токен не был потреблён раннером из-за отсутствия действий.
4. **Синхронный захват атрибуции в `ApplicationSyncService.uninstallApplication` до `runUninstallHookBestEffort`**:
   - В `ApplicationSyncService.uninstallApplication` (`application-sync.service.ts:368, 417`) перед миграцией вызывается `applicationUninstallService.runUninstallHookBestEffort`. Захват и проверка атрибуции (`captureApplicationMetadataAudit`) должны выполняться до запуска uninstall-хука, чтобы при отсутствии валидного субъекта аудита вызов отклонялся без внешних побочных эффектов.

---

## 2. Блокировки БД, проверка плана, кросс-приложенческое согласование и верификация 7 таблиц

### 2.1. Порядок блокировок и отсутствие гонок
Предложенный в `design.md` (п. 2.1) канонический порядок блокировок внутри `runInCoreAuditTransaction` с `SET LOCAL lock_timeout = '8s'`:
1. `core.workspace WHERE id = $1 FOR NO KEY UPDATE`
2. `core.application WHERE "workspaceId" = $1 ORDER BY id FOR UPDATE`
3. `core.role`, `core."roleTarget"`, `core."rolePermissionFlag"`, `core."objectPermission"`, `core."fieldPermission"`, `core."rowLevelPermissionPredicateGroup"`, `core."rowLevelPermissionPredicate"` (`WHERE "workspaceId" = $1 ORDER BY id FOR UPDATE`)

полностью согласован с `role-update-audit.ts`, `role-assignment-audit.ts`, `role-permission-audit.ts`, `api-key-audit.ts`, `workspace-default-role-audit.ts` и `application-default-role-audit.ts`. Поскольку все эти модули первым шагом берут `FOR NO KEY UPDATE` (или `FOR UPDATE`) на строке `core.workspace WHERE id = $1`, любые конкурентные операции над ролями, привязками, правами и приложениями одного `workspaceId` сериализуются на первой же блокировке `core.workspace` без риска взаимных блокировок (deadlocks).

Дополнительно в `runAuditedApplicationMetadataMigration` рекомендуется захватывать `FOR SHARE` (или проверять под блокировкой `core.workspace`) существующие в БД строки `core.agent`, `core."permissionFlag"`, `core."objectMetadata"`, `core."fieldMetadata"` данного `workspaceId`, чтобы исключить гонки с параллельным удалением объектов/полей вне контекста ролей.

### 2.2. Критический краевой случай: `role.delete` перед `roleTarget.update` в `computeOrderedMigrationActions`
В `fromAgentManifestToUniversalFlatRoleTarget` (`from-agent-manifest-to-universal-flat-role-target.util.ts:17`) `universalIdentifier` привязки `roleTarget` вычисляется как `getRoleTargetUniversalIdentifier({ applicationUniversalIdentifier, agentUniversalIdentifier })` и **не зависит** от `roleUniversalIdentifier`.
Следствие:
- Если агент приложения был привязан к роли `roleA` из манифеста (привязка принадлежала самому приложению), а в новой версии манифеста роль `roleA` удаляется (`inferDeletionFromMissingEntities: true`) и агент перепривязывается на роль `roleB`, то `buildAllFlatEntityOperationRecordByMetadataNameFromFromTo` и `flatEntityDeletedCreatedUpdatedMatrixDispatcher` формируют для этой привязки действие **`roleTarget.update`** (так как `universalIdentifier` привязки в `from` и `to` совпадает).
- Однако в `computeOrderedMigrationActions` (`compute-ordered-migration-actions.util.ts:57-69`) порядок действий следующий:
  1. `role.delete` (строка 57) -> выполняет `DELETE FROM core.role WHERE id = roleA.id`;
  2. `role.create` (строка 58);
  3. `roleTarget.delete` (строка 62);
  4. `roleTarget.create` (строка 68);
  5. `roleTarget.update` (строка 69) -> выполняет `UPDATE core."roleTarget" SET "roleId" = roleB.id WHERE id = ...`.
- Поскольку в `core."roleTarget"` на колонке `"roleId"` установлен внешний ключ `ON DELETE CASCADE` (`role-target.entity.ts:43`), выполнение `role.delete` на шаге 1 **каскадно удалит** строку `core."roleTarget"` в PostgreSQL до того, как на шаге 5 выполнится `roleTarget.update`! В результате `roleTarget.update` обновит 0 строк, а привязка агента исчезнет.
- Кроме того, в `design.md` (п. 2.1, строка 49) указано требование: каждая существующая строка `core."roleTarget"`, у которой `roleId` входит в удаляемые роли, обязана присутствовать в `roleTarget.delete`. При `roleTarget.update` эта пред-проверка отклонит миграцию с `'Application metadata audit detected unplanned roleTarget cascade'`.

**Как решить при реализации**:
- В `WorkspaceMigrationRunnerService.executeRun` (внутри аудируемого запуска миграции приложения) или в `reconcile-application-role-and-permission-operations.util.ts`:
  - Либо в `reconcile-application-role-and-permission-operations.util.ts`, если `roleTarget` из `flatEntityToUpdate` в `fromAllFlatEntityMaps` ссылался на удаляемую роль (`roleUniversalIdentifier` в `flatEntityToDelete.role`), учитывать, что `WorkspaceMigrationFlatEntityMapsService` всё равно строит `from` и `to` по `universalIdentifier`, поэтому `flatEntityDeletedCreatedUpdatedMatrixDispatcher` выдаст `roleTarget.update`.
  - Следовательно, в `runAuditedApplicationMetadataMigration` и `WorkspaceMigrationRunnerService.executeRun`:
    1. Разрешать в пред-проверке `roleTarget` ситуацию, когда строка `core."roleTarget"` с `before.roleId` в `deletedRoleIds` присутствует в `roleTarget.update` (перепривязываясь на неудаляемую роль с `canBeAssignedToAgents === true` и неудаляемого агента).
    2. В `WorkspaceMigrationRunnerService.executeRun` при выполнении действий внутри `applicationMetadataAudit` выполнять `roleTarget.update` (после `role.create` и `agent.create`, но **до** `role.delete`), либо если `role.delete` обязан идти до `role.create` из-за совпадения `label` (`IDX_ROLE_LABEL_WORKSPACE_ID_UNIQUE`), то в `executeRun` переупорядочивать `role.delete` после `roleTarget.update` во всех случаях, когда `role.create` не конфликтует по `label`, или перевставлять строку `roleTarget` с тем же `id`, `universalIdentifier`, `createdAt` и новым `roleId`, если `role.delete` каскадно удалил её перед `roleTarget.update`.

### 2.3. Разрешение ссылок для сущностей, создаваемых в той же миграции
В `role-permission-audit.ts` и `role-assignment-audit.ts` проверяемые родительские сущности (`role`, `agent`, `permissionFlag`, `objectMetadata`, `fieldMetadata`) уже существуют в БД до начала транзакции.
В пакетной миграции приложения (`syncMetadataFromManifest`, `synchronizeTwentyStandardApplicationOrThrow`) в **одной и той же** миграции создаются:
- `objectMetadata.create` (включая системные поля в `action.universalFlatFieldMetadatas` с предвыделенными ID в `action.fieldIdByUniversalIdentifier`);
- `fieldMetadata.create` (включая парное поле морф/реляции в `action.relatedUniversalFlatFieldMetadata` с ID в `action.relatedFieldId`);
- `permissionFlag.create` (`action.id`);
- `agent.create` (`action.id`);
- `role.create` (`action.id`);
- `rowLevelPermissionPredicateGroup.create` (`action.id`);
и одновременно создаются зависимые от них `roleTarget.create`, `rolePermissionFlag.create`, `objectPermission.create`, `fieldPermission.create`, `rowLevelPermissionPredicateGroup.create` (дочерние группы) и `rowLevelPermissionPredicate.create`.

**Требование к реализации `application-metadata-audit.ts`**:
- Таблицы сопоставления `universalIdentifier -> id` в `runAuditedApplicationMetadataMigration` должны объединять:
  1. существующие записи из `allFlatEntityMaps` / `before`-снимков БД (за вычетом удаляемых в этой же миграции);
  2. создаваемые в этой же миграции записи из `actions` (включая `action.fieldIdByUniversalIdentifier` из `objectMetadata.create` и `action.relatedFieldId` из `fieldMetadata.create`, как это делает `buildPreallocatedIdByUniversalIdentifierFromActions`).
- После выполнения `work(runner)` необходимо верифицировать по БД, что все referenced строки в `core.role`, `core.agent`, `core."permissionFlag"`, `core."objectMetadata"`, `core."fieldMetadata"` действительно существуют в `core` и принадлежат данному `workspaceId`.

### 2.4. Согласование кросс-приложенческих привязок (`reconcile-application-role-and-permission-operations.util.ts`)
1. **Замена `roleTarget` агента при `inferDeletionFromMissingEntities: false`**:
   - В `design.md` (п. 2.2.1, строка 67) сказано: «если у агента приложения в БД существует `roleTarget` с другим `universalIdentifier` ..., и манифест задаёт `roleUniversalIdentifier` для этого агента либо удаляет агента / его роль при `inferDeletionFromMissingEntities: true`, эта существующая привязка добавляется в `allFlatEntityOperationRecordByMetadataName.roleTarget.flatEntityToDelete`».
   - Важно: когда манифест явно задаёт `roleUniversalIdentifier` для своего агента (`toAllUniversalFlatEntityMaps.flatRoleTargetMaps` содержит целевой `roleTarget`), существующий в `existingAllFlatEntityMaps.flatRoleTargetMaps` `roleTarget` этого же агента с другим `universalIdentifier` должен добавляться в `flatEntityToDelete` **даже при `inferDeletionFromMissingEntities === false`**! Иначе `roleTarget.create` упадёт на уникальном индексе `IDX_ROLE_TARGET_UNIQUE_AGENT ("workspaceId", "agentId")`. (При этом `WorkspaceMigrationFlatEntityMapsService.computeFromToAllFlatEntityMapsAndBuildOptions` на строке 173 автоматически выставит `inferDeletionFromMissingEntities.roleTarget = true`, когда `flatEntityToDelete` не пуст).
   - Также, если `inferDeletionFromMissingEntities === true` и агент остаётся в манифесте, но у него в манифесте убран `roleUniversalIdentifier` (`undefined`), существующий кастомный `roleTarget` этого агента также следует включать в `flatEntityToDelete` (либо явно зафиксировать, сохраняется ли ручное назначение роли, если манифест вообще не декларирует роль для агента; безопаснее удалять только если манифест задаёт `roleUniversalIdentifier`, либо удаляется агент, либо удаляется назначенная ему роль).
2. **Валидация удаления прав, принадлежащих ролям с `isEditable: false` или другим приложениям**:
   - В `FlatObjectPermissionValidatorService.validateFlatObjectPermissionDeletion` (`flat-object-permission-validator.service.ts:262`), `FlatFieldPermissionValidatorService.validateFlatFieldPermissionDeletion` (`flat-field-permission-validator.service.ts:300`) и `FlatRolePermissionFlagValidatorService.validateFlatRolePermissionFlagDeletion` (`flat-role-permission-flag-validator.service.ts:264`) есть проверка:
     `if (isDefined(referencedRole) && !referencedRole.isEditable) { validationResult.errors.push({ code: PermissionsExceptionCode.ROLE_NOT_EDITABLE, ... }); }`
   - Если удаляется сама роль (`role.delete`), то в `WorkspaceMigrationBuildOrchestratorService` билдер `role` запускается на шаге 13 (строка 224) и удаляет роль из `optimisticAllFlatEntityMaps.flatRoleMaps` **до** запуска билдеров `objectPermission` (шаг 16), `fieldPermission` (шаг 17) и `rolePermissionFlag` (шаг 19), поэтому `referencedRole` уже равен `undefined` и ошибка не возникает.
   - Но если удаляется `objectMetadata`, `fieldMetadata` или `permissionFlag` приложения, а на него ссылается `objectPermission` / `fieldPermission` / `rolePermissionFlag` **остающейся** роли другого приложения с `isEditable: true` (например, кастомной роли в `workspaceCustomFlatApplication`), то `referencedRole.isEditable === true`, и валидатор удаления пропускает её без ошибок (в `validateFlat*PermissionDeletion` **нет** проверки `validateRoleBelongsToCallerApplication`!).
   - А если в БД на удаляемый `objectMetadata` / `fieldMetadata` / `permissionFlag` ссылается строка прав не-редактируемой роли (`isEditable: false`), то:
     - для `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`: в `design.md` (п. 2.1, строка 54) уже предусмотрено, что удаление в 5 таблицах прав при пост-проверке в `runAuditedApplicationMetadataMigration` допускается как по явному действию `delete` таблицы прав, так и по запланированному удалению родительской сущности (`role`, `objectMetadata`, `fieldMetadata`, `permissionFlag`, `rowLevelPermissionPredicateGroup`), причём каждое такое каскадное удаление всё равно записывается в `CrmAuditTransactionContext` по разнице `before` и `after` снимков!
     - поэтому в `reconcile-application-role-and-permission-operations.util.ts` при добавлении в `flatEntityToDelete` зависимых `objectPermission`, `fieldPermission`, `rolePermissionFlag`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate` от других приложений следует добавлять в `flatEntityToDelete` строки тех ролей, которые либо сами удаляются, либо имеют `isEditable === true` (а для `rolePermissionFlag` при `isSystemBuild: true` в `runUninstall` или при удалении `permissionFlag` учитывать `validatePermissionFlagNotInUseCrossEntity`).
3. **Иерархия `rowLevelPermissionPredicateGroup` и `ON DELETE SET NULL` на `workspaceMemberFieldMetadataId`**:
   - В `RowLevelPermissionPredicateEntity` (`row-level-permission-predicate.entity.ts:86-90`) колонка `workspaceMemberFieldMetadataId` имеет `onDelete: 'SET NULL'` (в отличие от `fieldMetadataId`, у которого `onDelete: 'CASCADE'`).
   - Поэтому в `reconcile-application-role-and-permission-operations.util.ts` удаление поля `fieldMetadata` **не должно** добавлять предикат в `flatEntityToDelete`, если это поле фигурирует только в `workspaceMemberFieldMetadataUniversalIdentifier` (а не в `fieldMetadataUniversalIdentifier`).
   - В `runAuditedApplicationMetadataMigration` при `fieldMetadata.delete`, если у выжившего предиката `before.workspaceMemberFieldMetadataId` входил в удаляемые `fieldMetadata`, а `after.workspaceMemberFieldMetadataId === null`, это изменение должно не только проходить пост-проверку, но и **обязательно записываться в `CrmAuditTransactionContext` как событие `rowLevelPermissionPredicate` с `action: 'update'`** (так как `workspaceMemberFieldMetadataId` входит в `CATALOG.rowLevelPermissionPredicate.values`).
   - При проверке каскадного удаления `rowLevelPermissionPredicateGroup` и `rowLevelPermissionPredicate` (включая проверку отсутствия скрытого каскада soft-deleted строк с `deletedAt IS NOT NULL`) необходимо вычислять **транзитивное замыкание** удаляемых групп по `parentRowLevelPermissionPredicateGroupId`.
4. **Запрет `rolePermissionFlag.update`**:
   - В `crm-audit-transaction-context.ts:482` `ADMINISTRATIVE_ACTIONS.rolePermissionFlag = ['create', 'delete']`. Хотя в раннере существует `UpdateRolePermissionFlagActionHandlerService`, в `runAuditedApplicationMetadataMigration` любое действие `rolePermissionFlag.update` должно отклоняться fail-closed на пред-проверке плана.

### 2.5. Проверка `ApplicationService.delete`
- В `ApplicationService.delete` (`application.service.ts:931`) внутри транзакции перед обнулением `packageJsonFileId`/`yarnLockFileId` и удалением `core.application` необходимо:
  1. выполнить `SET LOCAL lock_timeout = '8s'`;
  2. заблокировать `core.workspace WHERE id = $1 FOR NO KEY UPDATE` и `core.application WHERE "workspaceId" = $1 ORDER BY id FOR UPDATE`;
  3. проверить, что в `core.role`, `core."roleTarget"` и всех 5 таблицах прав (`core."rolePermissionFlag"`, `core."objectPermission"`, `core."fieldPermission"`, `core."rowLevelPermissionPredicateGroup"`, `core."rowLevelPermissionPredicate"`) нет ни одной строки (включая soft-deleted строки с `deletedAt IS NOT NULL` в таблицах предикатов), которая имеет `"applicationId" = application.id` либо ссылается на `core.role`, `core.agent`, `core."objectMetadata"`, `core."fieldMetadata"` (включая `"workspaceMemberFieldMetadataId"`) или `core."permissionFlag"` удаляемого приложения;
  4. также проверить, что `core.workspace."defaultRoleId"` и `core.application."defaultRoleId"` других приложений не указывают на удаляемое приложение;
  5. при наличии любых остаточных строк выбросить `'Application delete requires prior audited removal of role and permission metadata'` и откатить транзакцию.

---

## 3. Безопасность `WorkspaceMigrationRunnerService.executeRun` при смешанных миграциях, `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError`

1. **Поддержка смешанных миграций (DDL/схема + отложенные действия + роли/права)**:
   - В существующей ветке `executeRun` (`workspace-migration-runner.service.ts:401-542`) для одиночных мутаций ролей/прав отключены `searchFieldMetadatasByTsVectorFieldIdAccessor`, `deferredWorkspaceMigrationActionRunnerService.persist`, `dispatchAfterCommit` и `hasSchemaMetadataChanged` жёстко установлен в `false`.
   - Для `applicationMetadataAudit` (`getApplicationMetadataAudit(workspaceId)`) миграция приложения может одновременно менять схему (`objectMetadata`, `fieldMetadata`, `index`, `searchFieldMetadata`) и порождать `deferredActions`.
   - Поэтому ветка `applicationMetadataAudit` в `executeRun` должна:
     - использовать полноценный `searchFieldMetadatasByTsVectorFieldIdAccessor` с инвалидацией при `action.metadataName === 'searchFieldMetadata'`;
     - собирать `allDeferredActions` и при `shouldPersistDeferredActions === true` вызывать `await this.deferredWorkspaceMigrationActionRunnerService.persist({ deferredActions: allDeferredActions, workspaceId, applicationUniversalIdentifier, queryRunner })` **внутри** `work(queryRunner)` (в той же транзакции до `audit.flush()` и `COMMIT`);
     - после успешного коммита вызывать `this.invalidateCache({ allFlatEntityMapsKeys, workspaceId, hasSchemaMetadataChanged, hasMorphRelationFieldChanged })` и `await this.deferredWorkspaceMigrationActionRunnerService.dispatchAfterCommit(...)`;
     - возвращать реальный `hasSchemaMetadataChanged`.
2. **Обработка `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError`**:
   - При `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError`:
     - `executeActionRollbackHandler` **не вызывается** (так как транзакция БД уже могла закоммититься или закоммитилась);
     - `dispatchAfterCommit` **не вызывается**;
     - обязательно выполняется защищённый `try { await this.invalidateCache({ allFlatEntityMapsKeys, workspaceId, hasSchemaMetadataChanged, hasMorphRelationFieldChanged }); } catch (cacheError) { ... }` (включающий инвалидацию `'rolesPermissions'` при наличии ролей/прав в `allFlatEntityMapsKeys`);
     - ошибка пробрасывается **без обёртки** в `WorkspaceMigrationRunnerException`, чтобы вызывающий код (`isTransactionUnsafeToRetry` в `ApplicationInstallService.installApplication:593`) распознал её тип и не запускал компенсирующий `uninstallApplication`.
   - Проверить также `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`, `ApplicationManifestMigrationService.syncMetadataFromManifest` и `ApplicationSyncService.synchronizeFromManifest`:
     - `enrichApplicationManifestSyncError` (`enrich-application-manifest-sync-error.util.ts:19`) проверяет `getFlatEntityMapsExceptionContext(error)` и для `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError` возвращает исходный экземпляр ошибки без изменений.
     - Однако в `WorkspaceMigrationValidateBuildAndRunService` (`workspace-migration-validate-build-and-run-service.ts:190`) вызов `this.workspaceMigrationRunnerService.run` не оборачивается в `try/catch`, поэтому `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` пробрасываются наружу напрямую без потери типа.
3. **Fail-closed барьер в неаудируемой ветке `executeRun`**:
   - Если ни один из контекстов (`roleAudit`, `assignmentAudit`, `permissionAudit`, `apiKeyCreateAudit`, `applicationMetadataAudit`) не активен, а `actions` содержит хотя бы одно действие с `metadataName` из 7 аудируемых таблиц (`role`, `roleTarget`, `rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`), `executeRun` обязан выбросить `new Error('Workspace migration touching role or permission metadata requires an active CRM audit scope')` **до** вызова `this.coreDataSource.createQueryRunner()`.

---

## 4. Соблюдение `scripts/omnichannel/check_enterprise_dependencies.py`

Это **самый важный инфраструктурный барьер** при реализации `LOG165`:
В `check_enterprise_dependencies.py` (`scripts/omnichannel/check_enterprise_dependencies.py:230-253`) вычисляется обратное транзитивное замыкание `reaches_enterprise = closure(protected, reverse)` по всем импортам (включая `import type`). Любой **новый** файл в `packages/*/src/`, который прямо или транзитивно импортирует файл из `reaches_enterprise`, попадает в `runtime_enterprise_reachable` и создаёт новые рёбра в `enterprise_edges`, что немедленно приводит к падению `check_enterprise_dependencies.py --verify-baseline`.

При прямой проверке графа импортов обнаружены две скрытые ловушки:
1. **Ловушка 1 - `twenty-standard-applications.ts` находится в `reaches_enterprise`**:
   - Файл `src/engine/workspace-manager/twenty-standard-application/constants/twenty-standard-applications.ts` импортирует `type ApplicationEntity` из `application.entity.ts` -> `ObjectMetadataEntity` -> `ObjectPermissionEntity` -> `RoleEntity` -> `RowLevelPermissionPredicateEntity` (`/* @license Enterprise */`).
   - Следовательно, в новом файле `packages/twenty-server/src/engine/core-modules/crm-audit/application-metadata-audit.ts` **нельзя** импортировать `TWENTY_STANDARD_APPLICATION` из `src/engine/workspace-manager/twenty-standard-application/constants/twenty-standard-applications`!
   - Вместо этого константу `TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER` нужно импортировать напрямую из `'twenty-shared/application'` (пакет `twenty-shared` не содержит `@license Enterprise`), а `STANDARD_ROLE` - из `'src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant'` (у него 0 импортов).
2. **Ловушка 2 - `all-flat-entity-maps.type.ts` и `all-flat-entity-operation-record-by-metadata-name.type.ts` находятся в `reaches_enterprise`**:
   - Оба файла импортируют `all-flat-entity-types-by-metadata-name.type.ts`, который импортирует `metadata-entity.type.ts` -> `all-metadata-entity-by-metadata-name.constant.ts` -> `RowLevelPermissionPredicateEntity` (`/* @license Enterprise */`).
   - Следовательно, ни в `application-metadata-audit.ts`, ни в новом файле `packages/twenty-server/src/engine/core-modules/application/application-manifest/utils/reconcile-application-role-and-permission-operations.util.ts` **нельзя** импортировать (даже через `import type`) `AllFlatEntityMaps`, `AllFlatEntityOperationRecordByMetadataName`, `WorkspaceMigration`, `FlatApplication` или любые сущности/типы из `src/engine/metadata-modules/flat-entity/types/*` и `src/engine/metadata-modules/row-level-permission-predicate/*`!
   - Оба новых файла должны использовать только собственные минимальные структурные типы и чистые импорты из `'twenty-shared/application'`, `'twenty-shared/metadata'`, `'twenty-shared/utils'`, `'class-validator'`, `'typeorm'` и `'src/engine/core-modules/crm-audit/*'`.
3. **Ловушка 3 - рёбра между существующими файлами**:
   - Поскольку новые файлы `application-metadata-audit.ts` и `reconcile-application-role-and-permission-operations.util.ts` при соблюдении правил выше **не входят** в `reaches_enterprise`, их импорт из `application-manifest-migration.service.ts`, `application-sync.service.ts`, `twenty-standard-application.service.ts` и `workspace-migration-runner.service.ts` не добавит ни одного нового узла в `runtime_enterprise_reachable` и ни одного нового ребра в `enterprise_edges`.

---

## 5. Дополнительные замечания к реализации и `test-research.md`

1. **Уточнение формулировки сценария 1 в `test-research.md`**:
   - В п. 1 `test-research.md` написано: «атомарно создаёт/обновляет строку в `core.role` и записывает событие `role` (`create` / `update`) в `crm_audit."crmAuditEntry"` в одной транзакции с назначением `core.application."defaultRoleId"`».
   - В `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow` сначала выполняется миграция (`validateBuildAndRunWorkspaceMigrationFromTo`), которая в одной транзакции создаёт/обновляет `core.role` (`Admin`) и записывает событие `role` (`create`/`update`), а затем вызывается `setStandardApplicationDefaultRoleOrThrow` (`applicationService.update`), который во второй транзакции обновляет `core.application."defaultRoleId"` и записывает событие `application:update`. Оба шага используют одну и ту же захваченную в начале метода `capturedAuditIdentity`, но выполняются в двух последовательных транзакциях с разными `operationId`. В тесте следует проверять атомарность каждой из этих двух транзакций и совпадение их `actor` / `initiator`.
2. **Сброс `core.application."defaultRoleId"` при удалении всех ролей из манифеста (`syncApplicationReferencesFromManifest`)**:
   - В `ApplicationManifestMigrationService.syncApplicationReferencesFromManifest` (`application-manifest-migration.service.ts:480-484`) условие передачи `{ defaultRoleId }` сейчас опирается на `isDefined(ownerFlatApplication.defaultRoleId)`. Если в переданном в `syncMetadataFromManifest` объекте `ownerFlatApplication` поле `defaultRoleId` было устаревшим (`null`), а в БД `core.application."defaultRoleId"` было не `null`, то при удалении роли из манифеста `defaultRoleId` не сбросится.
   - Рекомендуется при `inferDeletionFromMissingEntities === true` всегда передавать `{ defaultRoleId }` в `this.applicationService.update(...)` (так как `runAuditedApplicationDefaultRoleUpdate` сам проверяет `beforeDefaultRoleId !== normalizedDefaultRoleId` под блокировкой `FOR UPDATE` и не пишет лишний аудит, если было `null` и осталось `null`), а также добавить проверку: если `defaultRoleId` удаляется в `runAuditedApplicationMetadataMigration`, а `inferDeletionFromMissingEntities === false`, отклонять удаление роли, являющейся `defaultRoleId` собственного приложения.
3. **Покрытие в `crm-audit-application-metadata.postgres-spec.ts`**:
   Рекомендуется включить в тестовый набор следующие граничные проверки:
   - синхронизация манифеста, в которой старая роль приложения удаляется, а агент приложения перепривязывается на другую роль (проверка отсутствия потери `roleTarget` из-за каскада `role.delete` перед `roleTarget.update`);
   - синхронизация манифеста после ручной смены роли агента через `AgentService`/`AiAgentRoleService` (привязка под `workspaceCustomFlatApplication`) как с `inferDeletionFromMissingEntities: true`, так и с `inferDeletionFromMissingEntities: false`;
   - удаление поля `workspaceMember` (`fieldMetadata.delete`), на которое ссылался `rowLevelPermissionPredicate.workspaceMemberFieldMetadataId`, с проверкой записи `rowLevelPermissionPredicate:update` (`workspaceMemberFieldMetadataId: <id> -> null`) в `crm_audit."crmAuditEntry"`;
   - каскадное удаление `objectPermission`, `fieldPermission`, `rolePermissionFlag`, `rowLevelPermissionPredicateGroup` и `rowLevelPermissionPredicate` (включая созданные под `workspaceCustomFlatApplication`) при удалении объекта/поля/флага/роли приложения и при `uninstallApplication`.
