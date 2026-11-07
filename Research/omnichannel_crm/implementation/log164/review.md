# LOG164 (`ROB-765`) - независимое ревью реализации и тестов CRM-аудита `core.application."defaultRoleId"`

## Вердикт

**ПРИНЯТО (APPROVED)**. Все замечания `R1`-`R5` из `design-review.md` полностью устранены в коде, тестах и документации. Все runtime-пути записи `core.application."defaultRoleId"` закрыты однотранзакционным CRM-аудитом с пессимистичными блокировками БД и двухфазной верификацией состояния. Дефектов корректности, гонок, TOCTOU, рассинхронизации кэша или обработки неопределённости коммита не обнаружено.

---

## 1. Проверка устранения замечаний `R1`-`R5` из `design-review.md`

1. **R1 (Сброс `defaultRoleId` в `null` и проверка `defaultRoleUniversalIdentifier` вне `manifest.roles` в `ApplicationManifestMigrationService.syncApplicationReferencesFromManifest`) - УСТРАНЕНО**:
   - В `packages/twenty-server/src/engine/core-modules/application/application-manifest/application-manifest-migration.service.ts:191-195` перед первым `await` фиксируется снимок `capturedOwnerFlatApplication` с `ownerApplicationId = ownerFlatApplication.id`.
   - В `syncApplicationReferencesFromManifest` (`application-manifest-migration.service.ts:389-418`) вызовы `resolveApplicationReferenceIdOrThrow` для ролей манифеста получают `ownerApplicationId`, а при `isDefined(manifest.application.defaultRoleUniversalIdentifier) && !isDefined(defaultRoleId)` выполняется явный вызов `resolveApplicationReferenceIdOrThrow` с `ownerApplicationId`, детерминированно отклоняющий ссылки на несуществующие или чужие роли с `ApplicationExceptionCode.ENTITY_NOT_FOUND`.
   - В вызове `this.applicationService.update` (`application-manifest-migration.service.ts:480-484`) условие передачи `defaultRoleId` включает `(inferDeletionFromMissingEntities && isDefined(ownerFlatApplication.defaultRoleId))`, что гарантирует передачу `{ defaultRoleId: null }` и запись `application:update` при удалении роли по умолчанию из манифеста без лишних вызовов ролевого аудита для манифестов, где `defaultRoleId` уже равен `null`.
2. **R2 (Защитная проверка в `ApplicationService.create`) - УСТРАНЕНО**:
   - В `packages/twenty-server/src/engine/core-modules/application/application.service.ts:787-791` в начале `ApplicationService.create` добавлена синхронная проверка `if (data.defaultRoleId !== undefined && data.defaultRoleId !== null) throw new Error('Application creation cannot assign defaultRoleId without audit')`, исключающая создание приложения с непустым `defaultRoleId` в обход `runAuditedApplicationDefaultRoleUpdate`.
3. **R3 (Точность именования в `design.md`) - УСТРАНЕНО**:
   - В `Research/omnichannel_crm/implementation/log164/design.md` (раздел 1 п. 2 и раздел 2.3 п. 2) указано точное имя метода `DevSeederWorkspaceService.seedDev`, совпадающее с реализацией в `packages/twenty-server/src/engine/workspace-manager/dev-seeder/services/dev-seeder.workspace-service.ts:139-150`.
4. **R4 (Требование `workspaceId` для явного `MembershipCleanupIdentity`) - УСТРАНЕНО**:
   - В `packages/twenty-server/src/engine/core-modules/crm-audit/application-default-role-audit.ts:80-82` внутри `resolveCapturedOperation` добавлена явная проверка `if ((identity as MembershipCleanupIdentity).workspaceId === undefined) throw new Error('CRM audit context requires scoped identity')`, блокирующая передачу unscoped `MembershipCleanupIdentity` (например, с `actor.kind === 'coreUser'` без `workspaceId`).
5. **R5 (Дополнение тестовых сценариев в `crm-audit-application-default-role.postgres-spec.ts`) - УСТРАНЕНО**:
   - В `packages/twenty-server/test/fork-migration/crm-audit-application-default-role.postgres-spec.ts:730-749, 787-801` добавлены проверки идемпотентного пропуска `setStandardApplicationDefaultRoleOrThrow` при уже установленном `defaultRoleId` и дефолтной системной атрибуции `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow({ workspaceId })` (`actor: { kind: 'system', id: 'twenty-standard-application:sync' }`).
   - В `crm-audit-application-default-role.postgres-spec.ts:912-924, 958-974` сброс `defaultRoleId` в `null` проверяется непосредственно через `applicationManifestMigrationService.syncMetadataFromManifest` с `defaultRoleUniversalIdentifier: undefined`, `inferDeletionFromMissingEntities: true` и `ownerFlatApplication.defaultRoleId = manifestRoleTwoId`.

---

## 2. Полнота покрытия runtime-записей `core.application."defaultRoleId"` и транзакционные инварианты

1. **Охват всех путей записи**:
   - В runtime (вне исторических upgrade-команд `2-19`, `2-43`, `2-51`) изменение `core.application."defaultRoleId"` происходит исключительно через `ApplicationService.update`:
     - `RoleService.createWorkspaceCustomApplicationRole` (`role.service.ts:641`);
     - `TwentyStandardApplicationService.setStandardApplicationDefaultRoleOrThrow` (`twenty-standard-application.service.ts:181`), вызываемый из `WorkspaceManagerService.init` (`workspace-manager.service.ts:70`) и `DevSeederWorkspaceService.seedDev` (`dev-seeder.workspace-service.ts:139`);
     - `ApplicationManifestMigrationService.syncApplicationReferencesFromManifest` (`application-manifest-migration.service.ts:464`).
   - `ApplicationService.create` блокирует передачу непустого `defaultRoleId`.
   - Прямые вызовы `applicationRepository.update` и `queryRunner.manager.update(ApplicationEntity, ...)` изменяют только файловые и технические поля (`packageJsonFileId`, `yarnLockFileId`, чексуммы, `uninstallHookCompletedForRequestedAt`).
2. **Блокировки БД и верификация в `runAuditedApplicationDefaultRoleUpdate` (`application-default-role-audit.ts:210-319`)**:
   - Выполняется внутри `runInCoreAuditTransaction(dataSource, ...)` с `SET LOCAL lock_timeout = '8s'`.
   - Блокировки берутся в каноническом порядке:
     1. `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE` (проверка существования и `deletedAt === null`);
     2. `SELECT id,"workspaceId","universalIdentifier",to_jsonb(a)->>'defaultRoleId' AS "defaultRoleId",to_jsonb(a)->>'deletedAt' AS "deletedAt" FROM core.application a WHERE a.id=$1 AND a."workspaceId"=$2 FOR UPDATE` (проверка существования и `deletedAt === null`);
     3. при `normalizedDefaultRoleId !== null`: `SELECT to_jsonb(r) AS row FROM core.role r WHERE id=$1 AND "workspaceId"=$2 FOR SHARE` с проверкой владения ролью (`uuid(targetRole.applicationId) === request.applicationId`).
   - Инициатор имперсонации разрешается внутри транзакции через `resolveRoleAuditInitiator`.
   - Двухфазная проверка `verifyState('update')` и `verifyState('flush')` подтверждает, что после `work(runner)` и после `audit.flush()` приложение активно, его `universalIdentifier` не изменился, `defaultRoleId` равен `normalizedDefaultRoleId`, а канонический снимок целевой роли (`canonicalAuditJson(targetRole)`) остался неизменным.
   - При реальном изменении (`beforeDefaultRoleId !== normalizedDefaultRoleId`) в `crm_audit."crmAuditEntry"` записывается событие `resourceKind: 'application'`, `action: 'update'`, `changedFields: ['defaultRoleId']`, `values: { defaultRoleId: { before, after } }`, `securityDescriptor: { resourceKind: 'application', resourceId: request.applicationId, metadataAccess: 'currentWorkspaceAdministration' }`.

---

## 3. Анализ гонок, TOCTOU, когерентности кэша и неопределённости коммита

1. **Защита от TOCTOU**:
   - В `ApplicationService.update` (`application.service.ts:824-832`) поверхностная копия `const capturedData = { ...data }` и захват `captureApplicationDefaultRoleAudit(...)()` выполняются синхронно до первого `await`.
   - В `RoleService.createWorkspaceCustomApplicationRole` (`role.service.ts:602-612`) и `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow` (`twenty-standard-application.service.ts:48-57`) захват и валидация `auditIdentity` также происходят синхронно до первого `await`.
   - Повторное использование токена `ApplicationDefaultRoleAuditRequest` и вложенные вызовы внутри активных metadata-аудит контекстов блокируются через `WeakSet` (`active`, `consumed`) и `registerMetadataAuditScopeCheck(getApplicationDefaultRoleAudit)`.
2. **Когерентность кэша и обработка `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`**:
   - В ветке с `defaultRoleId` пересчёт кэша `workspaceCacheService.invalidateAndRecompute(capturedData.workspaceId, ['flatApplicationMaps'])` и отправка события `broadcastApplicationEvent` выполняются только после успешного завершения `runAuditedApplicationDefaultRoleUpdate` (после подтверждённого `COMMIT`).
   - При `NativeTransactionOutcomeUnknownError` или `CoreAuditPostCommitError` (`application.service.ts:862-877`) `ROLLBACK` не отправляется, кэш `['flatApplicationMaps']` принудительно инвалидируется в защищённом `try / catch`, событие `broadcastApplicationEvent` не отправляется, а исходная ошибка пробрасывается вызывающему коду.
   - При откате транзакции до `COMMIT` ни пересчёт кэша, ни отправка события не выполняются.
3. **Статический анализ и границы зависимостей**:
   - Дифференциальный typecheck (`Research/omnichannel_crm/implementation/log164/typecheck-differential.json`) подтверждает `newDiagnostics: []`, `changedCodeDiagnostics: []`, `status: "pass-no-new-diagnostics"`.
   - Импорты в изменённых модулях не создают новых рёбер в сторону `@license Enterprise` и не содержат конструкций `opaque_dependencies`.
