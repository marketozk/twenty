# Независимое ревью реализации LOG165 (Linear ROB-765)

## Общий вердикт

**Статус: УТВЕРЖДЕНО (0 критических блокеров; замечания M1, M2, M3, T1 и T2 устранены в коде и тестах)**

Реализация `LOG165` закрывает все три целевых пути пакетной миграции метаданных приложений (`ApplicationManifestMigrationService.syncMetadataFromManifest`, `ApplicationSyncService.uninstallApplication` + `ApplicationService.delete`, `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`) транзакционным CRM-аудитом в едином контуре с `WorkspaceMigrationRunnerService.executeRun` и устанавливает fail-closed барьер на любые неаудируемые миграции, затрагивающие 7 таблиц ролей, привязок и прав (`role`, `roleTarget`, `rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`).

Все ключевые архитектурные требования из `design.md` и критические замечания из `design-review.md` учтены, включая защиту от потери `roleTarget` при порядке `role.delete` перед `roleTarget.update`, отсутствие новых рёбер в `@license Enterprise` (`scripts/omnichannel/check_enterprise_dependencies.py --verify-baseline` проходит со статусом `pass`), поддержку `ON DELETE SET NULL` на `workspaceMemberFieldMetadataId`, а также корректный проброс `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` без запуска rollback-хендлеров.

---

## 1. Линза 1: Архитектура и транзакционные границы

### 1.1. Покрытие всех путей миграций метаданных приложений и fail-closed барьера
1. **`ApplicationManifestMigrationService.syncMetadataFromManifest`** (`packages/twenty-server/src/engine/core-modules/application/application-manifest/application-manifest-migration.service.ts:178-389`):
   - Захватывает контекст аудита при `!dryRun` (`201-209`), вызывает `reconcileApplicationRoleAndPermissionOperations` (`298-304`) для согласования кросс-приложенческих привязок `roleTarget` и зависимых строк прав из `existingAllFlatEntityMaps`.
   - Оборачивает только боевой вызов `validateBuildAndRunOrThrow` (`!isDryRun`) в `withApplicationMetadataAudit` (`334-336`), завершая scope до вызова `syncApplicationReferencesFromManifest` (`369`), что исключает конфликт контекстов `applicationMetadataAudit` и `applicationDefaultRoleAudit`.
   - В `syncApplicationReferencesFromManifest` (`528-530`) при `inferDeletionFromMissingEntities === true` всегда передаёт `{ defaultRoleId }` в `applicationService.update`, гарантируя сброс `defaultRoleId` в `null` при удалении всех ролей из манифеста.
2. **`ApplicationSyncService.uninstallApplication` (`runUninstall`) и `ApplicationService.delete`** (`packages/twenty-server/src/engine/core-modules/application/application-manifest/application-sync.service.ts:374-529`, `packages/twenty-server/src/engine/core-modules/application/application.service.ts:932-997`):
   - В `uninstallApplication` (`402-407`) синхронно захватывает и валидирует `capturedAudit` (`captureApplicationMetadataAudit(...)()`) до вызова `runUninstall` и `runUninstallHookBestEffort`.
   - В `runUninstall` (`480-503`) расширяет `allFlatEntityOperationRecordByMetadataName` зависимыми агентскими `roleTarget` и строками 5 таблиц прав из других приложений (`fromAllFlatEntityMaps`) и выполняет миграцию внутри `withApplicationMetadataAudit(capturedAudit, ...)`.
   - В `ApplicationService.delete` (`951-965`) внутри транзакции берёт блокировки `core.workspace FOR NO KEY UPDATE` и `core.application FOR UPDATE` и вызывает `assertNoRemainingApplicationRoleOrPermissionMetadata` до удаления строки `core.application`.
3. **`TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`** (`packages/twenty-server/src/engine/workspace-manager/twenty-standard-application/services/twenty-standard-application.service.ts:45-168`):
   - Синхронно захватывает и валидирует `capturedAuditIdentity` (по умолчанию `systemActorId: 'twenty-standard-application:sync'`) до первого `await` (`52-61`).
   - Выполняет `validateBuildAndRunWorkspaceMigrationFromTo` внутри `withApplicationMetadataAudit` (`124-144`), после завершения которого вызывает `setStandardApplicationDefaultRoleOrThrow` (`153-159`) во второй транзакции с тем же `capturedAuditIdentity`.
4. **`WorkspaceMigrationRunnerService.executeRun`** (`packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service.ts:399-728`):
   - Проверяет взаимное исключение владельцев аудита (`404-413`).
   - В ветке `applicationMetadataAudit` (`557-718`) сохраняет поддержку смешанных миграций (инвалидация `searchFieldMetadatasByTsVectorFieldIdAccessor`, сохранение `deferredActions` внутри транзакции, передача `hasSchemaMetadataChanged` и `hasMorphRelationFieldChanged` в `invalidateCache`, вызов `dispatchAfterCommit` после коммита).
   - В неаудируемой ветке (`720-728`) до создания `QueryRunner` блокирует любые действия над 7 аудируемыми таблицами с ошибкой `'Workspace migration touching role or permission metadata requires an active CRM audit scope'`.

### 1.2. Порядок блокировок и обработка `role.delete` перед `roleTarget.update`
- В `runAuditedApplicationMetadataMigration` (`application-metadata-audit.ts:573-628`) соблюдён канонический порядок блокировок внутри `runInCoreAuditTransaction`: `SET LOCAL lock_timeout = '8s'` -> `core.workspace FOR NO KEY UPDATE` -> `core.application ORDER BY id FOR UPDATE` -> `before`-снимки всех 7 таблиц с `ORDER BY id FOR UPDATE`.
- Краевой случай из `design-review.md` (п. 2.2), когда `role.delete` в `computeOrderedMigrationActions` выполняется раньше `roleTarget.update` и каскадно удаляет строку `core."roleTarget"` в PostgreSQL, обработан в `application-metadata-audit.ts:758-765` и `986-1023`:
  - пред-проверка допускает нахождение `targetId` в `plannedTargetUpdates`;
  - после `work(runner)` для `roleTarget.update`, чей `beforeRow.roleId` входил в `plannedRoleDeletes`, выполняется `INSERT INTO core."roleTarget" ... ON CONFLICT ("id") DO UPDATE SET "roleId"=EXCLUDED."roleId","updatedAt"=now()`, восстанавливающий строку с исходными `id`, `universalIdentifier`, `applicationId`, `createdAt` и новым `roleId`, после чего пост-проверка верифицирует целевую роль (`canBeAssignedToAgents === true`) и записывает пару событий `roleTarget:delete` и `roleTarget:create`.

### 1.3. Обработка `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError`
- В `WorkspaceMigrationRunnerService.executeRun` (`workspace-migration-runner.service.ts:641-687`) при `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError`:
  - `executeActionRollbackHandler` и `dispatchAfterCommit` не вызываются;
  - выполняется защищённый `this.invalidateCache(...)`;
  - исходный экземпляр ошибки пробрасывается без обёртки в `WorkspaceMigrationRunnerException`.

### 1.4. Выявленные неблокирующие замечания по Архитектуре и транзакционным границам

- **[M1 - Средний приоритет] Отложенная проверка `capturedMetadataAudit` в `syncMetadataFromManifest` при `shouldDeleteConnectedAccounts === true`**:
  - В `application-manifest-migration.service.ts:201-209` `captureApplicationMetadataAudit({...})` вызывается без немедленного вызова возвращаемого thunk `()`, а сам `capturedMetadataAudit!()` вызывается только на строке 336 при `isDryRun === false`.
  - Поскольку `captureApplicationMetadataAudit` (`application-metadata-audit.ts:212-230`) перехватывает ошибку отсутствия/невалидности `auditIdentity` и возвращает `() => { throw error; }`, при вызове `syncMetadataFromManifest` без валидного субъекта аудита сначала выполняются чтения кэша (`214`), а если `shouldDeleteConnectedAccounts === true` (`340-355`), то сначала проходит `validateBuildAndRunMigration(true)` (`isDryRun = true`), затем выполняется боевое удаление `connectedAccountMetadataService.deleteManyByConnectionProviderIds` (`346`), и только на `validateBuildAndRunMigration(false)` (`354`) выбрасывается ошибка аудита.
  - **Рекомендация**: вызывать thunk сразу в начале `syncMetadataFromManifest` (когда `!dryRun`), аналогично `uninstallApplication` (`application-sync.service.ts:407`) и `synchronizeTwentyStandardApplicationOrThrow` (`twenty-standard-application.service.ts:122`).

- **[M2 - Средний приоритет] Отсутствие проверки `workspaceMemberFieldMetadataId` в `assertNoRemainingApplicationRoleOrPermissionMetadata` и `lock_timeout` в `ApplicationService.delete`**:
  - В `ApplicationService.delete` (`application.service.ts:951-965`) внутри транзакции не вызывается `SET LOCAL lock_timeout = '8s'`.
  - В `assertNoRemainingApplicationRoleOrPermissionMetadata` (`application-metadata-audit.ts:1607-1623`) при проверке зависимостей от `core."fieldMetadata"` удаляемого приложения проверяется только `p."fieldMetadataId" = f.id`, но не проверяется `p."workspaceMemberFieldMetadataId" = f.id` в `core."rowLevelPermissionPredicate"`. Если у удаляемого приложения нет собственных ролей и прав, но есть поле в `core."fieldMetadata"`, на которое ссылается `workspaceMemberFieldMetadataId` предиката другого приложения (`workspaceCustomFlatApplication`), прямой вызов `ApplicationService.delete` не заблокируется и каскадное удаление `core.application -> core."fieldMetadata"` выполнит неаудируемый `ON DELETE SET NULL` на `workspaceMemberFieldMetadataId`.
  - **Рекомендация**: добавить `SET LOCAL lock_timeout = '8s'` в `ApplicationService.delete` и условие `(p."fieldMetadataId"=f.id OR p."workspaceMemberFieldMetadataId"=f.id)` для `rowLevelPermissionPredicate` в `assertNoRemainingApplicationRoleOrPermissionMetadata`.

- **[M3 - Средний приоритет] Отсутствие транзитивного замыкания по `parentRowLevelPermissionPredicateGroupId` внутри `runAuditedApplicationMetadataMigration`**:
  - В `reconcileApplicationRoleAndPermissionOperations` (`application-metadata-audit.ts:1858-1891`) транзитивное замыкание удаляемых групп предикатов вычисляется корректно. Однако внутри самого `runAuditedApplicationMetadataMigration` на пред-проверке soft-deleted строк (`913-959`) и пост-проверке (`1367-1384`) проверяется только прямое вхождение `parentGroupId` в `plannedGroupDeletes` без вычисления транзитивного замыкания по `before.predicateGroups` (при том что `before.predicateGroups` отсортирован по `ORDER BY id`, а не топологически, и soft-deleted группы не попадают в `existingAllFlatEntityMaps`).
  - **Рекомендация**: перед проверками на строках `913` и `1367` вычислить транзитивное замыкание `allCascadedGroupDeletes` по `before.predicateGroups` (от `plannedRoleDeletes`, `plannedObjectDeletes` и `plannedGroupDeletes`) и использовать его в пред- и пост-проверке.

---

## 2. Линза 2: Безопасность, редактирование секретов/фильтрации и соблюдение Enterprise-границ

1. **Редактирование секретов и значений фильтрации**:
   - Все записи аудита формируются через `CrmAuditTransactionContext` (`application-metadata-audit.ts:1040-1051`). Для `rowLevelPermissionPredicate` поле `value` проходит через штатное редактирование каталога `CrmAuditTransactionContext`, поэтому чувствительные литералы фильтрации (`value`) не попадают в открытом виде в `crm_audit."crmAuditEntry".redactedDiff`.
   - Во всех 7 таблицах записывается `securityDescriptor` с `metadataAccess: 'currentWorkspaceAdministration'`.
2. **Инварианты изоляции привилегий**:
   - Создание, изменение и удаление ролей строго ограничено целевым `applicationId` (`499-505, 672, 687, 1081, 1098`).
   - Создание и модификация ролей с `isEditable: false` разрешены исключительно для `TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER` при системном акторе (`654-681`).
   - Миграции приложений могут управлять только агентскими `roleTarget` (`agentId !== null`, `userWorkspaceId === null`, `apiKeyId === null`) и только для ролей с `canBeAssignedToAgents === true` (`778-806, 1144-1186`).
   - Запрещено удаление роли, назначенной участнику пространства (`userWorkspaceId !== null`), API-ключу (`apiKeyId !== null`) или являющейся `defaultRoleId` пространства либо другого активного приложения (`694-698, 752-757`).
   - Действие `rolePermissionFlag.update` блокируется fail-closed (`821-831`).
3. **Отсутствие Enterprise-зависимостей**:
   - Проверка `python -I -X utf8 scripts/omnichannel/check_enterprise_dependencies.py --verify-baseline` выполнена в рамках ревью и завершилась со статусом `"status": "pass"`, `"violations": {}`.
   - Модуль `application-metadata-audit.ts` не импортирует файлы из `reaches_enterprise`.

---

## 3. Линза 3: Полнота тестов и fail-closed инвариантов

### 3.1. Покрытие в `crm-audit-application-metadata.postgres-spec.ts`
Интеграционный тест `packages/twenty-server/test/fork-migration/crm-audit-application-metadata.postgres-spec.ts` проверяет реальную запись в PostgreSQL (`core` + `crm_audit."crmAuditEntry"`) под ограниченной ролью БД (`NOSUPERUSER`, только `SELECT, INSERT` на `crm_audit."crmAuditEntry"`):
1. Синхронизация `twenty-standard` (`Admin` role create/update + `application.defaultRoleId` update).
2. Первичная установка и обновление манифеста по всем 7 таблицам (`role`, `roleTarget`, `objectPermission`, `fieldPermission`, `rolePermissionFlag`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`) и `application:update` под пользовательским контекстом с имперсонацией (`withCrmAuditRequest`) и контекстом фоновой джобы (`withCrmAuditIdentity`), включая проверку отсутствия `secret-filter-v1`/`v2` в `redactedDiff`.
3. Согласование кросс-приложенческого `roleTarget` (созданного под `customAppId`) при синхронизации манифеста без конфликта `IDX_ROLE_TARGET_UNIQUE_AGENT`, а также перепривязка агента при одновременном удалении старой роли манифеста (`role.delete` перед `roleTarget.update`).
4. Каскадное удаление кросс-приложенческих записей во всех зависимых таблицах при `ApplicationSyncService.uninstallApplication` и блокировка прямого `ApplicationService.delete` при наличии неочищенных строк.
5. Fail-closed отклонение и откат при запуске без контекста аудита, удалении `workspace.defaultRoleId`, удалении роли участника/API-ключа, неплановом каскаде `roleTarget` и каскаде soft-deleted `rowLevelPermissionPredicateGroup`.
6. Поведение `WorkspaceMigrationRunnerService` при `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` (пропуск rollback-хендлеров и вызов `invalidateCache`).

### 3.2. Выявленные неблокирующие замечания по тестам

- **[T1 - Низкий приоритет] Отсутствует тестовый ассерт на `ON DELETE SET NULL` для `workspaceMemberFieldMetadataId`**:
  - В `application-metadata-audit.ts:1464-1492` реализована обработка `isPlannedMemberFieldSetNull` при `fieldMetadata.delete`, а в тестовом харнесе (`crm-audit-application-metadata.postgres-spec.ts:1080-1090, 1828-1839`) подготовлены `memberFieldId` и SQL-ветка `fieldMetadata.delete`, но в самих `it(...)` тестах нет сценария, удаляющего `memberFieldId` и проверяющего запись `rowLevelPermissionPredicate:update` (`workspaceMemberFieldMetadataId: memberFieldId -> null`).
- **[T2 - Низкий приоритет] Переопределение `applicationService.delete` в тестовом харнесе**:
  - В `crm-audit-application-metadata.postgres-spec.ts:1443-1480` метод `applicationService.delete` собран вручную вокруг `assertNoRemainingApplicationRoleOrPermissionMetadata` вместо делегирования в `ApplicationService.prototype.delete`.
