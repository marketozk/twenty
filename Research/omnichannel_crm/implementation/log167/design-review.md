# Независимое ревью дизайна LOG167

Дата: 08.11.2026
Статус: APPROVED (все замечания M1-M6 и T1-T2 учтены в дизайне, плане проверок и реализации)

## Архитектурные и security-замечания (M1-M6)

1. **M1 (High) - Сохранение и передача `auditIdentity` из `ApplicationSyncService.uninstallApplication` в `ApplicationService.delete` и синхронный захват до первого `await`**:
   - В `ApplicationSyncService.uninstallApplication` контекст аудита захватывается синхронно до `await this.applicationService.findOneApplicationWithRelationsOrThrow(...)` через `captureApplicationMetadataAuditOperation` + `bindApplicationMetadataAuditOperation`, а в `ApplicationSyncService.runUninstall` захваченная операция передаётся в `this.applicationService.delete(applicationUniversalIdentifier, workspaceId, { auditIdentity: capturedAuditOperation })`.
   - В `ApplicationService.delete` контекст аудита захватывается синхронно в самом начале метода до `await this.applicationLookupService.findByUniversalIdentifier(...)`.

2. **M2 (High) - Разрешение `workspaceId` в `revokeAuthorizationForApplication` и единый порядок блокировок при отзыве гранта**:
   - `ApplicationAuthorizationService.revokeAuthorizationForApplication` принимает `{ userId, applicationId, workspaceId?: string, auditIdentity?: ApplicationAuthorizationAuditIdentity }`, а `OAuthService.revokeUserAuthorization` передаёт `workspaceId` из проверенного refresh-токена.
   - Если `workspaceId` не передан напрямую, он синхронно извлекается до первого `await` из `auditIdentity` или из активного контекста `AsyncLocalStorage` (при отсутствии `workspaceId` вызов отклоняется fail-closed до обращения к БД).
   - Внутри `runAuditedApplicationAuthorizationRevoke` всегда соблюдается порядок: `core.workspace WHERE id=$1 FOR NO KEY UPDATE` -> (при наличии `applicationId`) `core.application WHERE id=$1 AND "workspaceId"=$2 FOR NO KEY UPDATE` -> `core."applicationAuthorization" FOR UPDATE`, без требования `userWorkspace.deletedAt IS NULL` (чтобы можно было отозвать грант удалённого участника).

3. **M3 (High) - Защита от кросс-воркспейсного обхода внешних ключей при блокировке дочерних строк**:
   - В `runAuditedApplicationDelete` строки `core."applicationAuthorization"` блокируются по `WHERE a."applicationId"=$1 ORDER BY a.id FOR UPDATE` (без фильтрации `WHERE "workspaceId"=$1` в SQL), после чего в коде проверяется `uuid(row.workspaceId) === normalizedWorkspaceId`.
   - Аналогично в `runAuditedApplicationAuthorizationUpsert`, `runAuditedApplicationAuthorizationRevoke` и `runAuditedUserApplicationVariableValueMutation` блокировка выполняется по уникальному ключу таблицы с последующей проверкой `uuid(row.workspaceId) === normalizedWorkspaceId`.
   - В `assertNoRemainingApplicationRoleOrPermissionMetadata` и `runAuditedApplicationMetadataMigration` проверяется отсутствие дочерних строк `core."userApplicationVariableValue"` по `"applicationVariableId"` без сужения по `uavv."workspaceId"`.

4. **M4 (Medium) - Порядок блокировок и проверка принадлежности `applicationVariable` в `runAuditedApplicationMetadataMigration` и `runAuditedUserApplicationVariableValueMutation`**:
   - В `readFullMetadataSnapshot` таблица `core."applicationVariable"` (`ORDER BY id FOR UPDATE`) блокируется строго перед `core."userApplicationVariableValue"` (`ORDER BY id FOR UPDATE`).
   - В `runAuditedApplicationMetadataMigration` проверяется, что каждая удаляемая `applicationVariable` существует в `before.applicationVariables` и принадлежит целевому `applicationId`, а в режимах `objectDelete` и `fieldDelete` любые действия над `applicationVariable` запрещены.
   - В `runAuditedUserApplicationVariableValueMutation` соблюдается порядок: `core.workspace FOR NO KEY UPDATE` -> `core.application WHERE id=$1 AND "workspaceId"=$2 FOR NO KEY UPDATE` (с проверкой `deletedAt IS NULL` и `universalIdentifier`) -> `core."userWorkspace" WHERE id=$1 AND "workspaceId"=$2 FOR NO KEY UPDATE` (с проверкой `deletedAt IS NULL` и совпадения `userId` с `coreUser` актором/инициатором) -> `core."applicationVariable" WHERE id=$1 AND "workspaceId"=$2 FOR NO KEY UPDATE` (с проверкой `applicationId` и `scope = 'USER'`) -> `core."userApplicationVariableValue" FOR UPDATE`.

5. **M5 (High) - Обработка `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` в `ApplicationService.delete` и `UserApplicationVariableValueService.updateMyUserApplicationVariable`**:
   - В `ApplicationService.delete` при `NativeTransactionOutcomeUnknownError` или `CoreAuditPostCommitError` не вызываются `fileStorageService.invalidateStorageStock`, `deleteApplicationFilesFromStorage` и `broadcastApplicationEvent`, но принудительно инвалидируются кэши `['flatApplicationMaps']` и `[...ALL_FLAT_ENTITY_MAPS_PROPERTIES, 'userApplicationVariableValueMaps']` внутри `try/catch` перед повторным выбросом ошибки. При обычной ошибке до коммита `invalidateStorageStock` вызывается только если `deleteApplicationFileRows` уже выполнялся.
   - В `UserApplicationVariableValueService.updateMyUserApplicationVariable` при `NativeTransactionOutcomeUnknownError` или `CoreAuditPostCommitError` инвалидируется `'userApplicationVariableValueMaps'` внутри `try/catch` перед повторным выбросом ошибки.

6. **M6 (High) - Совместимость с существующими unit и fork-migration тестами**:
   - В `UserApplicationVariableValueService` и `ApplicationAuthorizationService` `coreDataSource` внедряется через `@Optional() @InjectDataSource()` с fallback на `repository?.manager?.connection`.
   - В `runAuditedApplicationDelete` и `assertNoRemainingApplicationRoleOrPermissionMetadata` проверяется `to_regclass(...) IS NOT NULL`, а `assertNoRemainingApplicationRoleOrPermissionMetadata` вызывается до проверки наличия строк `core."applicationAuthorization"`.
   - Поле `applicationVariables` в `ApplicationMetadataAuditMappings` сделано опциональным.
   - Модуль `application-authorization-and-variable-audit.ts` использует только `import type { DataSource, QueryRunner } from 'typeorm'` и параметризованный SQL без runtime-импортов `@Entity`.
   - В `OAuthService` вызовы в `consumeUserAuthorization` и `revokeUserAuthorization` оборачиваются в `withCrmAuditIdentity` с общим `correlationId`.

## Замечания по плану проверок (T1-T2)

1. **T1 (Medium) - Монотонное продвижение `lastAuthorizedAt` и `lastUsedAt` при повторном вызове `recordAuthorization` в пределах одной миллисекунды**:
   - В `runAuditedApplicationAuthorizationUpsert` при конфликте используется `GREATEST($6::timestamptz, COALESCE(core."applicationAuthorization"."lastAuthorizedAt", '-infinity'::timestamptz) + interval '1 microsecond')` (и аналогично для `lastUsedAt`), что гарантирует непустой `changedFields` при повторном `recordAuthorization` с теми же `scopes`.
2. **T2 (Medium) - Явная проверка подавления побочных эффектов в `ApplicationService.delete` при `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError`**:
   - В `crm-audit-application-authorization-and-variable.postgres-spec.ts` добавлены проверки spy для `fileStorageService.invalidateStorageStock`, `fileStorageService.deleteApplicationFilesFromStorage` и `workspaceEventBroadcaster.broadcast`.
