# LOG165 - дизайн аудита записей метаданных ролей, прав и `roleTarget` при установке, синхронизации и удалении приложений

## 1. Контекст и постановка задачи

После `LOG111`-`LOG164` все прямые сервисные операции над `core.role`, `core."roleTarget"`, пятью таблицами прав ролей (`core."rolePermissionFlag"`, `core."objectPermission"`, `core."fieldPermission"`, `core."rowLevelPermissionPredicateGroup"`, `core."rowLevelPermissionPredicate"`), `core."apiKey"`, `core.workspace."defaultRoleId"` и `core.application."defaultRoleId"` закрыты транзакционным CRM-аудитом.

Оставались три пути пакетной синхронизации метаданных приложений, вызывающие `WorkspaceMigrationValidateBuildAndRunService` (`validateBuildAndRunWorkspaceMigrationFromTo` / `validateBuildAndRunWorkspaceMigrationFromRecord`) и `WorkspaceMigrationRunnerService.run` без активного контекста CRM-аудита:

1. **`ApplicationManifestMigrationService.syncMetadataFromManifest`** (`application-manifest-migration.service.ts:172`):
   - создаёт, обновляет и (при `inferDeletionFromMissingEntities: true`) удаляет роли приложения (`manifest.roles`), их права (`objectPermissions`, `fieldPermissions`, `permissionFlagUniversalIdentifiers`, `rowLevelPermissionPredicateGroups`, `rowLevelPermissionPredicates`) и привязки `roleTarget` для агентов приложения (`manifest.agents[].roleUniversalIdentifier`);
   - если роль агента приложения ранее была заменена через `AgentService.updateOneAgent` или `AiAgentRoleService.assignRoleToAgent`, новая строка `core."roleTarget"` получила случайный `universalIdentifier` и `applicationId = workspaceCustomFlatApplication.id`. При последующей синхронизации манифеста `getApplicationSubAllFlatEntityMaps({ applicationIds: [ownerFlatApplication.id] })` не включал эту привязку в `fromAllFlatEntityMaps.flatRoleTargetMaps`, что приводило либо к конфликту уникального индекса `IDX_ROLE_TARGET_UNIQUE_AGENT` при повторном создании привязки из манифеста, либо к неаудируемому `ON DELETE CASCADE` при удалении агента.
2. **`ApplicationSyncService.uninstallApplication` (`runUninstall`) и `ApplicationService.delete`** (`application-sync.service.ts:368`, `application.service.ts:847`):
   - `runUninstall` формирует матрицу удаления метаданных приложения (`allFlatEntityOperationRecordByMetadataName`) только по `applicationIds: [application.id]`. Если к агенту, роли, объекту, полю или флагу прав удаляемого приложения были привязаны `roleTarget` или строки прав, созданные под `workspaceCustomFlatApplication`, они не попадали в `flatEntityToDelete` и удалялись каскадно (`ON DELETE CASCADE`) без записей в `crm_audit."crmAuditEntry"`;
   - `ApplicationService.delete` выполняет `DELETE FROM core.application`, который при прямом вызове или при появлении новых строк между миграцией и удалением приложения мог каскадно удалить строки `core.role`, `core."roleTarget"` и таблиц прав без аудита.
3. **`TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`** (`twenty-standard-application.service.ts:36`):
   - синхронизирует стандартные метаданные `twenty-standard` (включая стандартную роль `Admin` в `core.role` и стандартного агента `Helper`) через `validateBuildAndRunWorkspaceMigrationFromTo` без контекста аудита на этапе миграции.

## 2. Архитектура решения

### 2.1. Модуль `application-metadata-audit.ts`

Создать `packages/twenty-server/src/engine/core-modules/crm-audit/application-metadata-audit.ts`:

1. **Регистрация и взаимное исключение контекстов**:
   - регистрирует `getApplicationMetadataAudit` в `registerMetadataAuditScopeCheck`;
   - блокирует вложенные вызовы внутри `roleAudit`, `assignmentAudit`, `permissionAudit`, `apiKeyCreateAudit`, `workspaceDefaultRoleAudit`, `applicationDefaultRoleAudit` или другого `applicationMetadataAudit`, а также повторное использование одного токена `ApplicationMetadataAuditRequest` (`WeakSet`).
2. **Синхронный захват атрибуции до первого `await` (`captureApplicationMetadataAudit`)**:
   - принимает `{ workspaceId, applicationId, applicationUniversalIdentifier, auditIdentity }`;
   - поддерживает явный `RoleUpdateAuditIdentity` или scoped `MembershipCleanupIdentity` (требуя наличия `identity.workspaceId`), а при отсутствии явного параметра захватывает текущий контекст `withCrmAuditRequest` / `withCrmAuditIdentity` через синхронный `captureCurrentCrmAuditOperation(workspaceId)`;
   - возвращает thunk `() => ApplicationMetadataAuditRequest`, который при отсутствии или невалидности субъекта выбрасывает ошибку синхронно до обращения к БД.
3. **Однотранзакционный исполнитель `runAuditedApplicationMetadataMigration`**:
   - выполняется внутри `runInCoreAuditTransaction(dataSource, async (runner) => ...)`;
   - устанавливает `SET LOCAL lock_timeout = '8s'`;
   - захватывает блокировки в каноническом порядке:
     1. `core.workspace WHERE id = $1 FOR NO KEY UPDATE` (проверка `deletedAt IS NULL`, чтение `defaultRoleId`);
     2. `core.application WHERE "workspaceId" = $1 ORDER BY id FOR UPDATE` (проверка существования целевого приложения, `deletedAt IS NULL`, совпадения `universalIdentifier` и чтение `defaultRoleId` всех приложений пространства);
     3. блокировка и снятие `before`-снимков всех 7 аудируемых таблиц ролей, привязок и прав в `core` (`WHERE "workspaceId" = $1 ORDER BY id FOR UPDATE`):
        - `core.role`
        - `core."roleTarget"`
        - `core."rolePermissionFlag"`
        - `core."objectPermission"`
        - `core."fieldPermission"`
        - `core."rowLevelPermissionPredicateGroup"`
        - `core."rowLevelPermissionPredicate"`
   - **Проверка плана миграции (`actions`) до выполнения SQL**:
     - все действия над `role` должны принадлежать целевому приложению (`applicationId`); `isEditable: false` допускается только для `TWENTY_STANDARD_APPLICATION.universalIdentifier` при `operation.actor.kind === 'system'`;
     - запрещено удаление роли, являющейся `core.workspace."defaultRoleId"` или `core.application."defaultRoleId"` другого приложения, а также роли, назначенной участнику пространства (`userWorkspaceId IS NOT NULL`) или API-ключу (`apiKeyId IS NOT NULL`);
     - все действия `roleTarget` в миграции приложения могут относиться только к агентам (`agentId IS NOT NULL`, `userWorkspaceId IS NULL`, `apiKeyId IS NULL`), а целевая роль должна иметь `canBeAssignedToAgents === true`;
     - **защита от скрытого каскада `roleTarget`**: каждая существующая строка `core."roleTarget"`, у которой `roleId` входит в удаляемые роли или `agentId` входит в удаляемых агентов, обязана присутствовать в запланированных действиях `roleTarget.delete`; иначе транзакция отклоняется до выполнения SQL (`'Application metadata audit detected unplanned roleTarget cascade'`);
     - **защита от каскадного удаления soft-deleted предикатов**: если в `core."rowLevelPermissionPredicateGroup"` или `core."rowLevelPermissionPredicate"` есть строки с `deletedAt IS NOT NULL`, которые были бы каскадно удалены при удалении роли, объекта, поля или родительской группы без явного действия `delete`, транзакция отклоняется.
   - **Выполнение `work(runner)` и двухфазная верификация после записи и после `audit.flush()`**:
     - после `work(runner)` повторно считываются все 7 таблиц и сверяются с планом миграции:
       - в `core.role` и `core."roleTarget"` каждое создание, изменение и удаление обязано точно соответствовать запланированным действиям;
       - в 5 таблицах прав каждое создание и изменение обязано соответствовать запланированным действиям (с учётом штатного `ON DELETE SET NULL` на `workspaceMemberFieldMetadataId` при запланированном `fieldMetadata.delete`), а каждое удаление - либо явному действию `delete` соответствующей таблицы прав, либо запланированному удалению родительской сущности (`role`, `objectMetadata`, `fieldMetadata`, `permissionFlag`, `rowLevelPermissionPredicateGroup`);
     - все изменения по всем 7 таблицам записываются в `CrmAuditTransactionContext`:
       - для `role`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate` - `create`, `update`, `delete`;
       - для `rolePermissionFlag` - `create`, `delete`;
       - для `roleTarget` - `create`, `delete`, а при in-place обновлении `roleId` через `UpdateRoleTargetActionHandlerService` (`before.roleId !== after.roleId`) записываются пара событий `delete` (`before`) и `create` (`after`) для `resourceId = roleTarget.id` в соответствии с `ADMINISTRATIVE_ACTIONS.roleTarget = ['create', 'delete']`;
     - при наличии хотя бы одной записи вызывается `await audit.flush()`, после чего повторно сверяется неизменность состояния `core.workspace`, `core.application` и всех 7 таблиц.

### 2.2. Согласование кросс-приложенческих привязок `roleTarget` и прав при синхронизации и удалении приложений

Создать утилиту `packages/twenty-server/src/engine/core-modules/application/application-manifest/utils/reconcile-application-role-and-permission-operations.util.ts`:

1. **В `ApplicationManifestMigrationService.syncMetadataFromManifest`**:
   - после `buildAllFlatEntityOperationRecordByMetadataNameFromFromTo` для всех агентов приложения (`fromAllFlatEntityMaps.flatAgentMaps` и `toAllUniversalFlatEntityMaps.flatAgentMaps`) проверяет `existingAllFlatEntityMaps.flatRoleTargetMaps`:
     - если у агента приложения в БД существует `roleTarget` с другим `universalIdentifier` (например, созданный под `workspaceCustomFlatApplication` через `AgentService.updateOneAgent` или `AiAgentRoleService.assignRoleToAgent`), и манифест задаёт `roleUniversalIdentifier` для этого агента либо удаляет агента / его роль при `inferDeletionFromMissingEntities: true`, эта существующая привязка добавляется в `allFlatEntityOperationRecordByMetadataName.roleTarget.flatEntityToDelete`;
   - для удаляемых в манифесте `role`, `agent`, `objectMetadata`, `fieldMetadata`, `permissionFlag` добавляет в `flatEntityToDelete` зависимые агентские `roleTarget` и строки 5 таблиц прав из `existingAllFlatEntityMaps`, принадлежащие другим приложениям (например, `workspaceCustomFlatApplication`), чтобы они удалялись явно и проходили через валидатор и аудит.
2. **В `ApplicationSyncService.runUninstall`**:
   - расширяет `allFlatEntityOperationRecordByMetadataName` зависимыми агентскими `roleTarget` и строками 5 таблиц прав из `fromAllFlatEntityMaps`, ссылающимися на удаляемые `role`, `agent`, `objectMetadata`, `fieldMetadata`, `permissionFlag` удаляемого приложения.
3. **В `ApplicationService.delete`**:
   - захватывает блокировки `core.workspace FOR NO KEY UPDATE` и `core.application FOR UPDATE` внутри транзакции удаления приложения и проверяет, что в `core.role`, `core."roleTarget"` и 5 таблицах прав не осталось строк, принадлежащих удаляемому приложению или ссылающихся на его `role`, `agent`, `objectMetadata`, `fieldMetadata`, `permissionFlag`; при обнаружении остаточных строк выбрасывает `'Application delete requires prior audited removal of role and permission metadata'` и откатывает транзакцию.

### 2.3. Защита `WorkspaceMigrationRunnerService.executeRun`

В `WorkspaceMigrationRunnerService.executeRun` (`workspace-migration-runner.service.ts`):
- подключить `getApplicationMetadataAudit(workspaceId)` и `runAuditedApplicationMetadataMigration`:
  - при обычной ошибке до `COMMIT` сохраняется штатный вызов `executeActionRollbackHandler`, инвалидация кэша и обёртка в `WorkspaceMigrationRunnerException`;
  - при `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` пропускается `executeActionRollbackHandler`, выполняется защищённая инвалидация кэша (`this.invalidateCache`) и ошибка пробрасывается без потери типа;
- в неаудируемой ветке `executeRun` добавить fail-closed проверку: если `actions` содержит любое действие над `role`, `roleTarget`, `rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup` или `rowLevelPermissionPredicate` без активного контекста CRM-аудита, выбрасывать `'Workspace migration touching role or permission metadata requires an active CRM audit scope'` до открытия соединения с БД.

## 3. Затронутые файлы

1. `packages/twenty-server/src/engine/core-modules/crm-audit/application-metadata-audit.ts` (новый)
2. `packages/twenty-server/src/engine/core-modules/application/application-manifest/utils/reconcile-application-role-and-permission-operations.util.ts` (новый)
3. `packages/twenty-server/src/engine/core-modules/application/application-manifest/application-manifest-migration.service.ts`
4. `packages/twenty-server/src/engine/core-modules/application/application-manifest/application-sync.service.ts`
5. `packages/twenty-server/src/engine/core-modules/application/application.service.ts`
6. `packages/twenty-server/src/engine/workspace-manager/twenty-standard-application/services/twenty-standard-application.service.ts`
7. `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service.ts`
8. `packages/twenty-server/test/fork-migration/crm-audit-application-metadata.postgres-spec.ts` (новый)
