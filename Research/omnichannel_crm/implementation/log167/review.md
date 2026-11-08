# Независимое ревью кода LOG167

Дата: 08.11.2026
Задача: ROB-765 (LOG167 - аудит жизненного цикла и каскадного удаления `applicationAuthorization` и `userApplicationVariableValue`)
Вердикт: pass (0 блокеров, 0 дефектов; все замечания M1-M6 и T1-T2 устранены и подтверждены в коде и тестах)

## Проверенный объём

1. Документация этапа:
   - `Research/omnichannel_crm/implementation/log167/design.md`
   - `Research/omnichannel_crm/implementation/log167/design-review.md`
   - `Research/omnichannel_crm/implementation/log167/test-research.md`
2. Производственные файлы (12 файлов):
   - `packages/twenty-server/src/engine/core-modules/crm-audit/application-authorization-and-variable-audit.ts`
   - `packages/twenty-server/src/engine/core-modules/crm-audit/application-metadata-audit.ts`
   - `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-attribution-context.ts`
   - `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`
   - `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service.ts`
   - `packages/twenty-server/src/engine/core-modules/application/application-authorization/services/application-authorization.service.ts`
   - `packages/twenty-server/src/engine/core-modules/application/application-authorization/application-authorization.resolver.ts`
   - `packages/twenty-server/src/engine/core-modules/application/application-oauth/oauth.service.ts`
   - `packages/twenty-server/src/engine/core-modules/application/application-variable/user-application-variable-value.service.ts`
   - `packages/twenty-server/src/engine/core-modules/application/application-variable/user-application-variable-value.resolver.ts`
   - `packages/twenty-server/src/engine/core-modules/application/application.service.ts`
   - `packages/twenty-server/src/engine/core-modules/application/application-manifest/application-sync.service.ts`
3. Интеграционный PostgreSQL-тест:
   - `packages/twenty-server/test/fork-migration/crm-audit-application-authorization-and-variable.postgres-spec.ts`

## Проверка по чеклисту

### 1. Полнота охвата всех write/delete/cascade путей `core."applicationAuthorization"` и `core."userApplicationVariableValue"`
- **Прямые операции `applicationAuthorization`**:
  - `ApplicationAuthorizationService.recordAuthorization` (вызывается из `OAuthService.exchangeAuthorizationCode`) выполняет транзакционный upsert через `runAuditedApplicationAuthorizationUpsert(..., mode: 'record')` с записью `applicationAuthorization:create` (при первой авторизации) или `applicationAuthorization:update` (при повторной авторизации или перевыпуске после отзыва).
  - `ApplicationAuthorizationService.backfillAuthorizationFromRefreshToken` (вызывается из `OAuthService.consumeUserAuthorization` при `refreshTokenGrant` и из `OAuthService.revokeUserAuthorization` при `revokeToken`) выполняет `INSERT ... ON CONFLICT ("userId", "applicationId") DO NOTHING` через `runAuditedApplicationAuthorizationUpsert(..., mode: 'backfill')` и записывает `applicationAuthorization:create` только при фактической вставке строки.
  - `ApplicationAuthorizationService.revokeAuthorizationByIdForUserWorkspace` (`ApplicationAuthorizationResolver.revokeApplicationAuthorization`) и `ApplicationAuthorizationService.revokeAuthorizationForApplication` (`OAuthService.revokeUserAuthorization`) переводят активный грант (`revokedAt IS NULL`) в отозванное состояние через `runAuditedApplicationAuthorizationRevoke` с записью `applicationAuthorization:update` (`changedFields: ['revokedAt']`); повторный отзыв или обращение к отсутствующему гранту возвращает `false` без ложных записей аудита.
  - `ApplicationAuthorizationService.touchLastUsedAt` при штатном обновлении `lastUsedAt` на refresh не порождает шумовых событий аудита.
- **Каскадные удаления `applicationAuthorization`**:
  - Каскад по `userWorkspaceId` (`ON DELETE CASCADE` при удалении `core."userWorkspace"`) уже закрыт в `membership-cleanup-audit.ts` (`LOG114`).
  - Каскад по `applicationId` (`ON DELETE CASCADE` при удалении `core.application`) закрыт в `ApplicationService.delete` через `runAuditedApplicationDelete` (включая вызов из `ApplicationSyncService.uninstallApplication`): все дочерние строки `core."applicationAuthorization"` блокируются до удаления приложения, проверяется их каскадное удаление и для каждой строки записывается `applicationAuthorization:delete`.
- **Прямые операции `userApplicationVariableValue`**:
  - `UserApplicationVariableValueService.updateMyUserApplicationVariable` (`UserApplicationVariableValueResolver.updateMyUserApplicationVariable`) проходит через `runAuditedUserApplicationVariableValueMutation`: непустое значение шифруется через `secretEncryptionService.encryptVersioned` и записывает `userApplicationVariableValue:create` или `userApplicationVariableValue:update`, а пустое значение удаляет строку и записывает `userApplicationVariableValue:delete` (при отсутствии строки повторное удаление является идемпотентным no-op без записи аудита).
- **Каскадные удаления `userApplicationVariableValue`**:
  - Каскад по `userWorkspaceId` закрыт в `membership-cleanup-audit.ts` (`LOG114`).
  - Каскад по `("applicationVariableId", "scope")` при удалении `core."applicationVariable"` (`DeleteApplicationVariableActionHandlerService`) закрыт в `runAuditedApplicationMetadataMigration` (`application-metadata-audit.ts`): для всех удалённых значений записывается `userApplicationVariableValue:delete` в общем `CrmAuditTransactionContext` с единым `operationId`.
  - В `AUDITED_ROLE_AND_PERMISSION_CASCADE_DELETE_METADATA_NAMES` добавлен `'applicationVariable'`, благодаря чему любой неаудируемый запуск `WorkspaceMigrationRunnerService.executeRun` с удалением `applicationVariable` блокируется fail-closed до создания `QueryRunner`.
  - В `assertNoRemainingApplicationRoleOrPermissionMetadata` добавлена проверка отсутствия строк `core."userApplicationVariableValue"` для переменных удаляемого приложения, что блокирует прямой вызов `ApplicationService.delete` в обход предварительного удаления метаданных.

### 2. Атомарность транзакций (`FOR UPDATE` в каноническом порядке, fail-closed при расхождении ожидаемых каскадов, захват ALS до `await`)
- Во всех точках входа (`ApplicationAuthorizationService`, `UserApplicationVariableValueService.updateMyUserApplicationVariable`, `ApplicationService.delete`, `ApplicationSyncService.uninstallApplication`) захват контекста атрибуции выполняется синхронно первой операцией до первого `await`.
- Во всех транзакциях `runInCoreAuditTransaction` устанавливается `SET LOCAL lock_timeout = '8s'` и выдерживается согласованный порядок блокировок:
  - `runAuditedApplicationAuthorizationUpsert`: `core.workspace FOR NO KEY UPDATE` -> `core.application FOR NO KEY UPDATE` -> `core."userWorkspace" FOR NO KEY UPDATE` -> `core."applicationAuthorization" FOR UPDATE`.
  - `runAuditedApplicationAuthorizationRevoke`: `core.workspace FOR NO KEY UPDATE` -> (при наличии `applicationId`) `core.application FOR NO KEY UPDATE` -> `core."applicationAuthorization" FOR UPDATE`.
  - `runAuditedUserApplicationVariableValueMutation`: `core.workspace FOR NO KEY UPDATE` -> `core.application FOR NO KEY UPDATE` -> `core."userWorkspace" FOR NO KEY UPDATE` -> `core."applicationVariable" FOR NO KEY UPDATE` -> `core."userApplicationVariableValue" FOR UPDATE`.
  - `runAuditedApplicationDelete`: `core.workspace FOR NO KEY UPDATE` -> `core.application FOR UPDATE` -> `assertNoRemainingApplicationRoleOrPermissionMetadata` -> `core."applicationAuthorization" ORDER BY id FOR UPDATE`.
  - `runAuditedApplicationMetadataMigration`: `core.workspace FOR NO KEY UPDATE` -> `core.application ORDER BY id FOR UPDATE` -> 7 таблиц ролей и прав (`ORDER BY id FOR UPDATE`) -> `core."applicationVariable" ORDER BY id FOR UPDATE` -> `core."userApplicationVariableValue" ORDER BY id FOR UPDATE` -> (в режимах `objectDelete`/`fieldDelete`) `core."objectMetadata" ORDER BY id FOR UPDATE` -> `core."fieldMetadata" ORDER BY id FOR UPDATE`.
- После `audit.flush()` во всех путях повторно перечитывается состояние БД и сверяется с ожидаемым снимком через `canonicalAuditJson`; любое расхождение приводит к выбросу исключения и откату транзакции.

### 3. Секреты и редактирование (`scopes` в `applicationAuthorization` и `value` в `userApplicationVariableValue`, совместимость с `membership-cleanup-audit.ts`)
- В `crm-audit-transaction-context.ts`:
  - `ADMINISTRATIVE_ACTIONS.applicationAuthorization = ['create', 'update', 'delete']`, `CATALOG.applicationAuthorization` оставляет в `values` только `['userId', 'userWorkspaceId', 'applicationId']`, а `['scopes', 'revokedAt', 'lastAuthorizedAt', 'lastUsedAt']` находятся в `redacted`.
  - `ADMINISTRATIVE_ACTIONS.userApplicationVariableValue = ['create', 'update', 'delete']`, `CATALOG.userApplicationVariableValue` содержит `values: ['userWorkspaceId', 'applicationVariableId', 'scope']` и `redacted: ['value']`.
- Поля из `redacted` хешируются через `auditPayloadHash` и отражаются только в `redactedDiff.changedFields`, никогда не попадая в `redactedDiff.values` (ни открытый секрет, ни шифротекст `enc:v2:...`, ни массив `scopes`).
- Совместимость с `membership-cleanup-audit.ts` полностью сохранена: `membership-cleanup-audit.ts` вырезает `'value'` на уровне SQL (`to_jsonb(r) - $1::text[]`), а `capture()` в `crm-audit-transaction-context.ts` пропускает поля, отсутствующие в снимке (`!Object.hasOwn(input, field)`).

### 4. Атрибуция актора и fail-closed инварианты M1-M6, T1-T2
- **M1**: `ApplicationSyncService.uninstallApplication` захватывает `capturedAuditOperation` синхронно до первого `await` и передаёт его в `ApplicationService.delete(..., { auditIdentity: capturedAuditOperation })`, который создаёт отдельную операцию аудита с новым `operationId` и сохранёнными `actor`, `initiator`, `correlationId` и `impersonatorUserWorkspaceId`.
- **M2**: `ApplicationAuthorizationService.revokeAuthorizationForApplication` принимает `workspaceId` и `auditIdentity`, синхронно извлекает `workspaceId` через `extractWorkspaceIdFromIdentityOrAmbient` (или через `peekCurrentCrmAuditWorkspaceId()`) и не требует `userWorkspace.deletedAt IS NULL`, позволяя отзывать гранты удалённых участников.
- **M3**: Блокировки дочерних строк в `runAuditedApplicationDelete`, `runAuditedApplicationAuthorizationUpsert`, `runAuditedApplicationAuthorizationRevoke`, `runAuditedUserApplicationVariableValueMutation`, `assertNoRemainingApplicationRoleOrPermissionMetadata` и `runAuditedApplicationMetadataMigration` выполняются без сужения по `workspaceId` в SQL с последующей проверкой `uuid(row.workspaceId) === request.workspaceId`, предотвращая обход через кросс-воркспейсные внешние ключи.
- **M4**: В `runAuditedUserApplicationVariableValueMutation` проверяется принадлежность `applicationVariable` целевому `applicationId`, `scope === 'USER'`, а также совпадение `userWorkspace.userId` с `coreUser` актором/инициатором и `expectedUserId`/`expectedUserWorkspaceId` из запроса. В `runAuditedApplicationMetadataMigration` проверяется принадлежность удаляемых `applicationVariable` целевому приложению и запрещаются любые действия над `applicationVariable` в режимах `objectDelete` и `fieldDelete`.
- **M5**: Корректно обработаны `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` во всех трёх сервисах (`OAuthService`, `UserApplicationVariableValueService`, `ApplicationService`).
- **M6**: `DataSource` внедряется с `@Optional() @InjectDataSource()` и fallback на `repository?.manager?.connection`, используются проверки `to_regclass(...) IS NOT NULL`, модуль `application-authorization-and-variable-audit.ts` не содержит runtime-импортов `@Entity`, а `OAuthService` передаёт общий `correlationId` между backfill и revoke в `revokeUserAuthorization`.
- **T1**: При повторном вызове `recordAuthorization` в ту же миллисекунду `lastAuthorizedAt` и `lastUsedAt` монотонно продвигаются на `1 microsecond` через `GREATEST(...)`, гарантируя непустой `changedFields` (аналогично `revokedAt` при отзыве).

### 5. Обработка `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError`
- В `ApplicationService.delete` при `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` подавляются вызовы `fileStorageService.invalidateStorageStock`, `fileStorageService.deleteApplicationFilesFromStorage` и `broadcastApplicationEvent`, при этом принудительно инвалидируются кэши `['flatApplicationMaps']` и `[...ALL_FLAT_ENTITY_MAPS_PROPERTIES, 'userApplicationVariableValueMaps']`. При обычном докоммитном откате после `deleteApplicationFileRows` вызывается `invalidateStorageStock`.
- В `UserApplicationVariableValueService.updateMyUserApplicationVariable` при `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` принудительно инвалидируется кэш `'userApplicationVariableValueMaps'` перед повторным выбросом ошибки.
- В `OAuthService.refreshTokenGrant` и `OAuthService.revokeToken` оба класса ошибок перехватываются и пробрасываются наружу без маскировки под `invalid_grant` или `{ success: true }`.
- В `WorkspaceMigrationRunnerService.invalidateCache` при изменении `flatApplicationVariableMaps` автоматически инвалидируется `'userApplicationVariableValueMaps'`.

### 6. Полнота PostgreSQL-тестов в `crm-audit-application-authorization-and-variable.postgres-spec.ts`
- Тестовый набор покрывает все целевые сценарии against real PostgreSQL с изолированной непривилегированной ролью:
  1. `exchangeAuthorizationCode` -> `recordAuthorization` (`create` с имперсонацией и редактированием `scopes`), повторный `recordAuthorization` в ту же миллисекунду (`update`, T1), отзыв через `ApplicationAuthorizationResolver.revokeApplicationAuthorization` (`update` + идемпотентный повторный вызов), `refreshTokenGrant` -> `backfillAuthorizationFromRefreshToken` (`create` + отсутствие шума от `touchLastUsedAt`), `revokeToken` -> `backfill` + `revoke` с единым `correlationId`.
  2. Каскадное удаление `applicationAuthorization` при `ApplicationSyncService.uninstallApplication` и `ApplicationService.delete`, fail-closed отказ при неаутентифицированном `ApplicationService.delete` и передача `auditIdentity` без ambient ALS (M1).
  3. Создание, обновление и удаление `userApplicationVariableValue` через `UserApplicationVariableValueResolver.updateMyUserApplicationVariable` с проверкой редактирования секрета `value` и инвалидации кэша `'userApplicationVariableValueMaps'`.
  4. Каскадное удаление `userApplicationVariableValue` при удалении `applicationVariable` в `runAuditedApplicationMetadataMigration`, блокировка прямого `ApplicationService.delete` при оставшихся значениях переменных и блокировка неаудируемого удаления `applicationVariable` в `WorkspaceMigrationRunnerService.run`.
  5. Fail-closed защита при отсутствии идентичности во всех публичных методах, при расхождении `actor` и `userWorkspace` (M4) и при кросс-воркспейсной строке `applicationAuthorization` (M3).
  6. Проброс `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError`, инвалидация кэша и подавление пост-коммитных побочных эффектов в `ApplicationService.delete` (M5, T2).
