# LOG167 - аудит жизненного цикла и каскадного удаления `applicationAuthorization` и `userApplicationVariableValue`

Дата: 08.11.2026
Задача: ROB-765 (Этап 2a - сбор и достоверность аудита действий)
Статус: Design

## 1. Контекст и проблема

В каталоге транзакционного аудита (`packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`) уже определены виды ресурсов `applicationAuthorization` (`core."applicationAuthorization"`) и `userApplicationVariableValue` (`core."userApplicationVariableValue"`). Однако ранее (`LOG114` / `membership-cleanup-audit.ts`) для них записывалось только каскадное удаление (`action: 'delete'`) при удалении `core."userWorkspace"`.

При этом все прямые операции жизненного цикла и каскадные удаления со стороны приложений и переменных приложений оставались вне транзакционного аудита:

1. **Прямые операции над `core."applicationAuthorization"` (`ApplicationAuthorizationService`, `ApplicationAuthorizationResolver`, `OAuthService`)**:
   - `ApplicationAuthorizationService.recordAuthorization` (`OAuthService.exchangeAuthorizationCode`) выполняет `upsert` по `("userId", "applicationId")` с установкой `scopes`, `lastAuthorizedAt`, `lastUsedAt` и сбросом `revokedAt = null` без записи `applicationAuthorization:create` или `applicationAuthorization:update`.
   - `ApplicationAuthorizationService.backfillAuthorizationFromRefreshToken` (`OAuthService.consumeUserAuthorization` при `refreshTokenGrant` и `OAuthService.revokeUserAuthorization` при `revokeToken`) вставляет строку `INSERT ... ON CONFLICT DO NOTHING` для refresh-токенов, выпущенных до появления таблицы, без записи `applicationAuthorization:create`.
   - `ApplicationAuthorizationService.revokeAuthorizationByIdForUserWorkspace` (`ApplicationAuthorizationResolver.revokeApplicationAuthorization`) и `ApplicationAuthorizationService.revokeAuthorizationForApplication` (`OAuthService.revokeUserAuthorization` при `/oauth/revoke`) устанавливают `revokedAt = now()` на активных грантах без записи `applicationAuthorization:update`.
   - Кроме того, в `OAuthService.refreshTokenGrant` и `OAuthService.revokeToken` широкие блоки `try/catch` перехватывают любые исключения и превращают их в `invalid_grant` / `{ success: true }`, что скрывает `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError`.

2. **Каскадное удаление `core."applicationAuthorization"` при удалении приложения (`ApplicationService.delete`, `ApplicationSyncService.uninstallApplication`)**:
   - В `ApplicationAuthorizationEntity` внешний ключ `FK_APPLICATION_AUTHORIZATION_APPLICATION_ID` на `core.application(id)` имеет `ON DELETE CASCADE`.
   - Когда `ApplicationService.delete` удаляет строку `core.application`, PostgreSQL каскадно удаляет все строки `core."applicationAuthorization"` данного приложения без записи `applicationAuthorization:delete` в `crm_audit."crmAuditEntry"`, а сам метод `ApplicationService.delete` использует обычный `coreDataSource.createQueryRunner()` вместо `runInCoreAuditTransaction`.

3. **Прямые операции над `core."userApplicationVariableValue"` (`UserApplicationVariableValueService.updateMyUserApplicationVariable`, `UserApplicationVariableValueResolver.updateMyUserApplicationVariable`)**:
   - При непустом `plainTextValue` метод выполняет `upsert` зашифрованного значения (`enc:v2:...`) по `("applicationVariableId", "userWorkspaceId")` без записи `userApplicationVariableValue:create` или `userApplicationVariableValue:update`.
   - При пустом `plainTextValue` метод удаляет строку `core."userApplicationVariableValue"` без записи `userApplicationVariableValue:delete`.

4. **Каскадное удаление `core."userApplicationVariableValue"` при удалении `core."applicationVariable"` (`ApplicationManifestMigrationService.syncMetadataFromManifest`, `ApplicationSyncService.uninstallApplication`, `WorkspaceMigrationRunnerService.executeRun`)**:
   - В `UserApplicationVariableValueEntity` составной внешний ключ `("applicationVariableId", "scope")` на `core."applicationVariable"(id, scope)` имеет `ON DELETE CASCADE ON UPDATE NO ACTION`.
   - При удалении `applicationVariable` через `DeleteApplicationVariableActionHandlerService` в ходе синхронизации манифеста или удаления приложения PostgreSQL каскадно удаляет все строки `core."userApplicationVariableValue"` этой переменной без записи `userApplicationVariableValue:delete` и без инвалидации кэша `'userApplicationVariableValueMaps'` при `syncMetadataFromManifest`.
   - Кроме того, неаудируемый запуск `WorkspaceMigrationRunnerService.executeRun` с удалением `applicationVariable` не блокировался барьером `AUDITED_ROLE_AND_PERMISSION_CASCADE_DELETE_METADATA_NAMES`.

## 2. Варианты решения

### Вариант 1 (Рекомендуемый): Единый модуль `application-authorization-and-variable-audit.ts` + расширение `application-metadata-audit.ts`, `ApplicationService.delete` и `CrmAuditTransactionContext`
- Расширить `ADMINISTRATIVE_ACTIONS` в `CrmAuditTransactionContext`:
  - `applicationAuthorization: ['create', 'update', 'delete']`
  - `userApplicationVariableValue: ['create', 'update', 'delete']`
  - В `CATALOG.userApplicationVariableValue.redacted` добавить `'value'` (шифротекст / секрет хешируется в `changedFields: ['value']`, никогда не попадает в `redactedDiff.values`; при этом `membership-cleanup-audit.ts` вырезает `'value'` через `to_jsonb(r) - $1::text[]`, поэтому `Object.hasOwn(snapshot, 'value') === false` и поведение `membership-cleanup-audit.ts` не меняется).
- Создать `packages/twenty-server/src/engine/core-modules/crm-audit/application-authorization-and-variable-audit.ts`:
  - Синхронный захват контекста аудита до первого `await` (`captureApplicationAuthorizationAudit`, `captureUserApplicationVariableValueAudit`, `captureApplicationDeleteAuthorizationCascadeAudit`), регистрация в `registerMetadataAuditScopeCheck`.
  - Транзакционные обёртки на базе `runInCoreAuditTransaction`:
    1. `runAuditedApplicationAuthorizationUpsert`: блокирует `core.workspace FOR NO KEY UPDATE`, `core.application FOR NO KEY UPDATE`, `core."userWorkspace" FOR NO KEY UPDATE` и строку `core."applicationAuthorization" WHERE "userId"=$1 AND "applicationId"=$2 FOR UPDATE`; выполняет `INSERT ... ON CONFLICT ("userId", "applicationId") DO UPDATE` (для `recordAuthorization`) или `DO NOTHING` (для `backfillAuthorizationFromRefreshToken`); записывает `applicationAuthorization:create` или `applicationAuthorization:update` (с редактированием `scopes`, `revokedAt`, `lastAuthorizedAt`, `lastUsedAt`), вызывает `audit.flush()` и сверяет снимок строки после flush.
    2. `runAuditedApplicationAuthorizationRevoke`: блокирует целевую строку `core."applicationAuthorization" FOR UPDATE` (и `core.workspace FOR NO KEY UPDATE`); если строка активна (`revokedAt IS NULL`), обновляет `revokedAt = now()`, записывает `applicationAuthorization:update`, вызывает `audit.flush()` и сверяет снимок строки после flush; если строка не найдена или уже отозвана, возвращает `false` без ложных записей аудита.
    3. `runAuditedUserApplicationVariableValueMutation`: блокирует `core.workspace FOR NO KEY UPDATE`, `core."userWorkspace" FOR NO KEY UPDATE`, `core."applicationVariable" FOR NO KEY UPDATE` (проверяя `scope = 'USER'` и принадлежность `applicationId`) и строку `core."userApplicationVariableValue" WHERE "applicationVariableId"=$1 AND "userWorkspaceId"=$2 AND "workspaceId"=$3 FOR UPDATE`; при непустом значении выполняет `INSERT` / `UPDATE` и записывает `userApplicationVariableValue:create` или `userApplicationVariableValue:update` (если зашифрованное/логическое значение или поля изменились, с хешированием `value`); при пустом значении удаляет существующую строку и записывает `userApplicationVariableValue:delete`; сверяет состояние после `audit.flush()`.
    4. `runAuditedApplicationDelete`: используется в `ApplicationService.delete`; выполняет удаление приложения внутри `runInCoreAuditTransaction`, блокирует `core.workspace FOR NO KEY UPDATE`, `core.application FOR UPDATE`, проверяет `assertNoRemainingApplicationRoleOrPermissionMetadata` (включая отсутствие оставшихся `core."userApplicationVariableValue"` для переменных этого приложения), блокирует все строки `core."applicationAuthorization" WHERE "workspaceId"=$1 AND "applicationId"=$2 ORDER BY id FOR UPDATE`, после удаления `core.application` проверяет каскадное удаление всех этих строк `applicationAuthorization`, записывает `applicationAuthorization:delete` для каждой удалённой строки (требуя аутентифицированную идентичность, если удаляется хотя бы одна строка `applicationAuthorization` или если идентичность передана), вызывает `audit.flush()` и повторно сверяет отсутствие строк после flush.
- Расширить `application-metadata-audit.ts` и `WorkspaceMigrationRunnerService.executeRun`:
  - Добавить `'applicationVariable'` в `AUDITED_ROLE_AND_PERMISSION_CASCADE_DELETE_METADATA_NAMES`.
  - В `ApplicationMetadataAuditMappings` добавить `applicationVariables: Record<string, { id: string } | undefined>`.
  - В `readExistingTables` и `readFullMetadataSnapshot` включить `applicationVariable` и `userApplicationVariableValue` (`ORDER BY id FOR UPDATE` после 7 таблиц ролей/прав).
  - В `runAuditedApplicationMetadataMigration` разрешить каскадное удаление строк `core."userApplicationVariableValue"`, чей `applicationVariableId` входит в `plannedApplicationVariableDeletes` (при `mode === 'manifest'`), записывать для каждой такой строки `userApplicationVariableValue:delete` в общем `CrmAuditTransactionContext`, отклонять любые несанкционированные создания/обновления/удаления `userApplicationVariableValue` и сверять снимок после `audit.flush()`.
  - В `WorkspaceMigrationRunnerService.executeRun` при наличии `delete`-действия над `applicationVariable` инвалидировать `'userApplicationVariableValueMaps'` в `workspaceCacheService.invalidateAndRecompute`.
- В `OAuthService`:
  - В `exchangeAuthorizationCode` обернуть `this.applicationAuthorizationService.recordAuthorization(...)` в `withCrmAuditIdentity(authCodeToken.workspaceId, auditIdentity, ...)`.
  - В `consumeUserAuthorization` и `revokeUserAuthorization` передавать проверенную идентичность владельца refresh-токена (`{ workspaceId, actor: { kind: 'coreUser', id: userId } }`) при отсутствии внешнего контекста аудита.
  - В `refreshTokenGrant` и `revokeToken` пробрасывать `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` наружу без маскировки под `invalid_grant` или `{ success: true }`.

### Вариант 2: Отдельные несвязанные локальные транзакции без интеграции с `runAuditedApplicationMetadataMigration` и `ApplicationService.delete`
- Минусы: каскадное удаление `userApplicationVariableValue` при удалении `applicationVariable` в манифесте и каскадное удаление `applicationAuthorization` при удалении приложения останутся без аудита. Отвергнут.

## 3. Порядок блокировок и инварианты (с учётом ревью дизайна M1-M6, T1-T2)

1. В `runAuditedApplicationMetadataMigration`:
   `core.workspace FOR NO KEY UPDATE` -> `core.application ORDER BY id FOR UPDATE` -> 7 таблиц ролей и прав (`ORDER BY id FOR UPDATE`) -> `core."applicationVariable" ORDER BY id FOR UPDATE` -> `core."userApplicationVariableValue" ORDER BY id FOR UPDATE` -> (в режимах `objectDelete`/`fieldDelete`) `core."objectMetadata" ORDER BY id FOR UPDATE` -> `core."fieldMetadata" ORDER BY id FOR UPDATE`. В режимах `objectDelete` и `fieldDelete` любые действия над `applicationVariable` запрещены; в режиме `manifest` проверяется принадлежность удаляемых `applicationVariable` целевому `applicationId` и отсутствие дочерних `userApplicationVariableValue` с чужим `workspaceId`.
2. В `runAuditedApplicationDelete` (`ApplicationService.delete`):
   Синхронный захват `auditIdentity` до первого `await` -> `core.workspace FOR NO KEY UPDATE` -> `core.application FOR UPDATE` -> `assertNoRemainingApplicationRoleOrPermissionMetadata` (включая проверку отсутствия строк `core."userApplicationVariableValue"` по `"applicationVariableId"`) -> блокировка `core."applicationAuthorization" WHERE "applicationId"=$1 ORDER BY id FOR UPDATE` с проверкой `uuid(row.workspaceId) === normalizedWorkspaceId` -> при наличии хотя бы одной строки `applicationAuthorization` (или переданной идентичности) обязательная запись `applicationAuthorization:delete` и повторная сверка после `audit.flush()`. В `ApplicationSyncService.uninstallApplication` захваченная до первого `await` операция передаётся в `ApplicationService.delete`.
3. В `runAuditedApplicationAuthorizationUpsert` / `runAuditedApplicationAuthorizationRevoke`:
   `core.workspace FOR NO KEY UPDATE` -> (при наличии `applicationId`) `core.application FOR NO KEY UPDATE` -> (`core."userWorkspace" FOR NO KEY UPDATE` при upsert) -> `core."applicationAuthorization" FOR UPDATE` (с проверкой `uuid(row.workspaceId) === normalizedWorkspaceId` и монотонным продвижением `lastAuthorizedAt` / `lastUsedAt` на конфликтном обновлении через `GREATEST(..., prev + interval '1 microsecond')`).
4. В `runAuditedUserApplicationVariableValueMutation`:
   `core.workspace FOR NO KEY UPDATE` -> `core.application FOR NO KEY UPDATE` (с проверкой `deletedAt IS NULL` и `universalIdentifier`) -> `core."userWorkspace" FOR NO KEY UPDATE` (с проверкой `deletedAt IS NULL` и совпадения `userId` с `coreUser` актором/инициатором) -> `core."applicationVariable" FOR NO KEY UPDATE` (с проверкой `applicationId` и `scope = 'USER'`) -> `core."userApplicationVariableValue" WHERE "applicationVariableId"=$1 AND "userWorkspaceId"=$2 FOR UPDATE` (с проверкой `uuid(row.workspaceId) === normalizedWorkspaceId`).
5. Все секретные и чувствительные поля (`scopes`, `revokedAt`, `lastAuthorizedAt`, `lastUsedAt` в `applicationAuthorization`; `value` в `userApplicationVariableValue`) находятся только в `CATALOG[kind].redacted` и никогда не попадают в `redactedDiff.values`.

