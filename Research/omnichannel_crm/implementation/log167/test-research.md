# План проверок LOG167

Дата: 08.11.2026
Задача: ROB-765 (LOG167)

## Целевой PostgreSQL-набор: `crm-audit-application-authorization-and-variable.postgres-spec.ts`

1. **Жизненный цикл `applicationAuthorization` (`ApplicationAuthorizationService`, `ApplicationAuthorizationResolver`, `OAuthService`)**:
   - `OAuthService.exchangeAuthorizationCode` -> `ApplicationAuthorizationService.recordAuthorization`: создание нового гранта записывает `applicationAuthorization:create` с атрибуцией пользователя и `initiator` при имперсонации, `values` содержат `userId`, `userWorkspaceId`, `applicationId`, а `scopes`, `lastAuthorizedAt`, `lastUsedAt` находятся только в `changedFields` (значения `scopes` не попадают в `redactedDiff`).
   - Повторная авторизация (`recordAuthorization` при существующей строке, в том числе после отзыва или при повторном вызове в ту же миллисекунду с теми же `scopes`) записывает `applicationAuthorization:update` с непустым `changedFields`.
   - `OAuthService.refreshTokenGrant` -> `backfillAuthorizationFromRefreshToken`: при отсутствии строки создаёт грант и записывает `applicationAuthorization:create`; при повторном вызове (`ON CONFLICT DO NOTHING`) не создаёт лишних записей аудита; `touchLastUsedAt` не создаёт шумовых записей аудита.
   - `ApplicationAuthorizationResolver.revokeApplicationAuthorization` -> `revokeAuthorizationByIdForUserWorkspace` и `OAuthService.revokeToken` -> `revokeUserAuthorization` (`backfillAuthorizationFromRefreshToken` + `revokeAuthorizationForApplication`): записывают `applicationAuthorization:update` (`changedFields: ['revokedAt']`, с общим `correlationId` при backfill + revoke); повторный отзыв уже отозванного гранта или чужого ID возвращает `false` и не пишет ложных записей аудита.

2. **Каскадное удаление `applicationAuthorization` при удалении приложения (`ApplicationSyncService.uninstallApplication` и `ApplicationService.delete`)**:
   - При удалении приложения через `ApplicationSyncService.uninstallApplication` (и прямом вызове `ApplicationService.delete` с `auditIdentity`) каскадное удаление строк `core."applicationAuthorization"` (`ON DELETE CASCADE`) записывает `applicationAuthorization:delete` для каждого гранта.
   - Прямой вызов `ApplicationService.delete` без аутентифицированной идентичности при наличии строк `core."applicationAuthorization"` отклоняется fail-closed (транзакция откатывается, приложение и гранты остаются в БД).

3. **Жизненный цикл `userApplicationVariableValue` (`UserApplicationVariableValueService.updateMyUserApplicationVariable`, `UserApplicationVariableValueResolver.updateMyUserApplicationVariable`)**:
   - Установка непустого значения переменной (`scope = 'USER'`) через резолвер создаёт зашифрованную строку (`enc:v2:...`) и записывает `userApplicationVariableValue:create` (`values`: `userWorkspaceId`, `applicationVariableId`, `scope: 'USER'`; `changedFields` включает `'value'`, но ни открытый текст, ни шифротекст не попадают в `redactedDiff.values`), инвалидируя `'userApplicationVariableValueMaps'`.
   - Обновление значения существующей переменной записывает `userApplicationVariableValue:update` (`changedFields: ['value']`, `values: {}`).
   - Передача пустой строки `""` удаляет строку из БД и записывает `userApplicationVariableValue:delete`; повторная передача `""` при отсутствии строки не создаёт ложных записей аудита.

4. **Каскадное удаление `userApplicationVariableValue` при удалении `applicationVariable` в миграциях (`ApplicationManifestMigrationService.syncMetadataFromManifest`, `ApplicationSyncService.uninstallApplication`, `WorkspaceMigrationRunnerService.executeRun`)**:
   - Удаление `applicationVariable` при синхронизации манифеста или удалении приложения каскадно удаляет связанные строки `core."userApplicationVariableValue"`, записывает `userApplicationVariableValue:delete` в той же транзакции `runAuditedApplicationMetadataMigration` (с общим `operationId` вместе с остальными изменениями ролей/прав) и инвалидирует `'userApplicationVariableValueMaps'`.
   - Неаудируемый вызов `WorkspaceMigrationRunnerService.executeRun` с `delete`-действием над `applicationVariable` отклоняется fail-closed до создания `QueryRunner`.
   - Прямой вызов `ApplicationService.delete`, пока в БД остаются строки `core."userApplicationVariableValue"` для переменных приложения, отклоняется `assertNoRemainingApplicationRoleOrPermissionMetadata`.

5. **Fail-closed защита и обработка `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`**:
   - Вызовы `recordAuthorization`, `backfillAuthorizationFromRefreshToken`, `revokeAuthorizationByIdForUserWorkspace`, `revokeAuthorizationForApplication` и `updateMyUserApplicationVariable` без аутентифицированной идентичности отклоняются до изменения БД.
   - При обрыве соединения на `COMMIT` (`NativeTransactionOutcomeUnknownError`) и пост-коммитном сбое (`CoreAuditPostCommitError`) ошибки пробрасываются без маскировки в `OAuthService.refreshTokenGrant`, `OAuthService.revokeToken`, `UserApplicationVariableValueService.updateMyUserApplicationVariable` и `ApplicationService.delete`, кэш инвалидируется, а в `ApplicationService.delete` подавляются `fileStorageService.invalidateStorageStock`, `fileStorageService.deleteApplicationFilesFromStorage` и `workspaceEventBroadcaster.broadcast` (тогда как при обычном откате после `deleteApplicationFileRows` вызывается `invalidateStorageStock`).
