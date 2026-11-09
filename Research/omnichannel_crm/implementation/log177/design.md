# LOG-177 - Дизайн транзакционного аудита полного жизненного цикла `connectionProvider` (`core."connectionProvider"`) и отчётов об отказе авторизации подключений приложений (`ApplicationConnectionAuthFailureService.reportAuthFailureOrThrow` -> `core."connectedAccount"`)

## 1. Контекст и постановка задачи

После закрытия `LOG-176` (`applicationVariable` и `featureFlag`) в контуре безопасности и OAuth-интеграций приложений остаются две открытые поверхности:
1. **Провайдеры подключений приложений (`core."connectionProvider"`, `ConnectionProviderEntity`)**:
   - Определяют параметры OAuth-подключений приложений (`name`, `displayName`, `logo`, `type`, `scope` (`'USER' | 'WORKSPACE'`), `oauthConfig` (`authorizationEndpoint`, `tokenEndpoint`, `revokeEndpoint`, `scopes`, `authorizationParams`, `usePkce`, `tokenRequestContentType`, `clientIdVariable`, `clientSecretVariable`) и хуки логических функций `identifyAccountLogicFunctionUniversalIdentifier`, `onConnectLogicFunctionUniversalIdentifier`, `onDisconnectLogicFunctionUniversalIdentifier`).
   - Мутируются через `WorkspaceMigrationRunnerService.executeRun` (`CreateConnectionProviderActionHandlerService`, `UpdateConnectionProviderActionHandlerService`, `DeleteConnectionProviderActionHandlerService`) при синхронизации манифеста (`ApplicationManifestMigrationService.syncMetadataFromManifest`), удалении приложения (`ApplicationSyncService.uninstallApplication`) и системных сборках.
   - Таблица `core."connectionProvider"` наследует `SyncableEntity` с `ON DELETE CASCADE` на `core.application(id)`, поэтому без проверки в `assertNoRemainingApplicationRoleOrPermissionMetadata` прямое удаление `core.application` (`ApplicationService.delete`) могло бы тихо удалить записи `core."connectionProvider"` без аудита.
2. **Отчёты об отказе авторизации OAuth-подключений приложений (`ApplicationConnectionAuthFailureService.reportAuthFailureOrThrow` / `ApplicationConnectionsResolver.reportAppConnectionAuthFailure` -> `core."connectedAccount"`)**:
   - В `CATALOG.connectedAccount` поля `['archivedAt', 'authFailedAt', 'authFailedReason']` уже объявлены в `redacted`, однако `ApplicationConnectionAuthFailureService.reportAuthFailureOrThrow` обновлял `authFailedAt` и `authFailedReason` напрямую через `this.connectedAccountRepository.update(...)` вне транзакции аудита и без блокировок строк.

## 2. Рассмотренные варианты

### Вариант A (Рекомендуемый)
1. **Каталог ресурсов и административных действий (`crm-audit.types.ts`, `crm-audit-transaction-context.ts`)**:
   - Добавить `'connectionProvider'` в `CrmAuditResourceKind`.
   - В `CATALOG` добавить:
     - `connectionProvider`:
       - `values: ['applicationId', 'type', 'scope']`
       - `redacted: ['name', 'displayName', 'logo', 'oauthConfig', 'identifyAccountLogicFunctionUniversalIdentifier', 'onConnectLogicFunctionUniversalIdentifier', 'onDisconnectLogicFunctionUniversalIdentifier']`
   - В `ADMINISTRATIVE_ACTIONS` установить:
     - `connectionProvider: ['create', 'update', 'delete']`.
2. **Миграции метаданных и барьер удаления `core.application` (`application-metadata-audit.ts`, `workspace-migration-runner.service.ts`)**:
   - Добавить `'connectionProvider'` в `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES` (fail-closed барьер в `WorkspaceMigrationRunnerService.executeRun` и автоматическая системная обёртка при `isSystemBuild: true` в `WorkspaceMigrationValidateBuildAndRunService`).
   - Добавить `connectionProviders?: Record<string, { id: string } | undefined>` в `ApplicationMetadataAuditMappings` и заполнять его в `WorkspaceMigrationRunnerService.executeRun` из `allFlatEntityMaps.flatConnectionProviderMaps`.
   - В `runAuditedApplicationMetadataMigration`:
     - Запретить действия `connectionProvider` в режимах `mode === 'objectDelete'` и `mode === 'fieldDelete'`.
     - Под блокировкой `ORDER BY id FOR UPDATE` считывать снимок `core."connectionProvider"` до `work(runner)`.
     - Проверять инварианты строк (`assertConnectionProviderRowInvariants`: UUID `id`, `workspaceId`, `applicationId`, `universalIdentifier`, непустые `name` и `displayName`, `type === 'oauth'`, `scope === 'USER' || scope === 'WORKSPACE'`, структуру `oauthConfig` и nullable UUID хуков), принадлежность обновляемых и удаляемых строк целевому `applicationId`, отсутствие оставшихся `core."connectedAccount"` у удаляемых провайдеров, соответствие созданных и обновлённых строк плану миграции, записывать `connectionProvider:create`, `connectionProvider:update` (при изменении проекции) и `connectionProvider:delete`, а после `audit.flush()` повторно сверять снимок `core."connectionProvider"`.
   - В `assertNoRemainingApplicationRoleOrPermissionMetadata` добавить `'connectionProvider'` в список проверяемых таблиц перед удалением `core.application`.
3. **Транзакционный аудит `ApplicationConnectionAuthFailureService.reportAuthFailureOrThrow` (`application-authorization-and-variable-audit.ts`, `application-connection-auth-failure.service.ts`, `application-connections.resolver.ts`)**:
   - Добавить `captureAppConnectionAuthFailureAudit` и `runAuditedAppConnectionAuthFailureReport` в `application-authorization-and-variable-audit.ts`.
   - Внутри `runInCoreAuditTransaction` (`SET LOCAL lock_timeout = '8s'`):
     - Заблокировать `core.workspace` (`FOR NO KEY UPDATE`, `deletedAt IS NULL`) и `core.application` (`FOR NO KEY UPDATE`, `deletedAt IS NULL`, `workspaceId`).
     - Проверить совпадение `actor.id` с `applicationId` при `actor.kind === 'application'`.
     - Если передан `requestUserWorkspaceId`, проверить под `FOR SHARE` существование активного `core."userWorkspace"` в данном `workspaceId`.
     - Заблокировать строку `core."connectedAccount"` (`WHERE id=$1 AND "workspaceId"=$2 AND "applicationId"=$3 AND provider='APP' AND "archivedAt" IS NULL FOR UPDATE`).
     - Если строка не найдена или скрыта от вызывающего пользователя (`scope === 'USER'` и `(requestUserWorkspaceId === null || uuid(row.userWorkspaceId) !== normalizedRequestUserWorkspaceId)`), вернуть `{ status: 'not_found' }`, чтобы `ApplicationConnectionAuthFailureService.reportAuthFailureOrThrow` выбросил штатный `ConnectionProviderException(..., ConnectionProviderExceptionCode.CONNECTION_NOT_FOUND)`.
     - Если передан `expectedLastCredentialsRefreshedAt` и он не совпадает с текущим `lastCredentialsRefreshedAt` под блокировкой (переподключение обновило токен параллельно), вернуть `{ status: 'superseded' }` без изменения строки и без записи аудита.
     - Обновить `authFailedAt = now()`, `authFailedReason = $reason`, `updatedAt = now()`, проверить инварианты сохранённой строки, записать `connectedAccount:update` (`values: ['userWorkspaceId', 'hasAccessToken', 'hasRefreshToken', 'hasConnectionParameters']`, `redacted: ['archivedAt', 'authFailedAt', 'authFailedReason']`), выполнить `audit.flush()` и повторно сверить снимок строки после `audit.flush()`.

### Вариант B (Отклонён)
- Оставить `ApplicationConnectionAuthFailureService.reportAuthFailureOrThrow` без транзакционного аудита, полагаясь только на лог ошибок приложения.
- **Причина отклонения**: `authFailedAt` и `authFailedReason` входят в `CATALOG.connectedAccount.redacted`, а их изменение переводит подключение приложения в состояние отказа авторизации.

## 3. Стратегия тестирования

- Новый PostgreSQL-спецификационный файл `packages/twenty-server/test/fork-migration/crm-audit-connection-provider-and-auth-failure.postgres-spec.ts`:
  1. Жизненный цикл `connectionProvider` (`create`, идемпотентный повтор без изменений, `update` `displayName`/`scope`/`oauthConfig`/хуков, `delete`) в `runAuditedApplicationMetadataMigration` и `WorkspaceMigrationRunnerService.executeRun` (включая `isSystemBuild: true`), проверка редактирования `oauthConfig` и `name`/`displayName`/`logo`/хуков, блокировка удаления `connectionProvider` при наличии привязанного `connectedAccount`, блокировка `assertNoRemainingApplicationRoleOrPermissionMetadata` / `runAuditedApplicationDelete` и fail-closed барьер на неаудируемые миграции `connectionProvider`.
  2. Транзакционный аудит `ApplicationConnectionAuthFailureService.reportAuthFailureOrThrow` и `ApplicationConnectionsResolver.reportAppConnectionAuthFailure`: запись `connectedAccount:update` с редактированием `authFailedAt` и `authFailedReason` (с причиной и с `reason: null`), доступ к `WORKSPACE`- и собственному `USER`-подключению, отказ с каноническим `ConnectionProviderException(CONNECTION_NOT_FOUND)` для чужого `applicationId`, чужого `USER`-подключения, архивированного (`archivedAt IS NOT NULL`) или не-`APP` подключения и пропуск устаревшего отчёта (`superseded`) при обновлённом `lastCredentialsRefreshedAt` без лишних записей аудита.
  3. Откат транзакции при срабатывании post-flush триггера на `core."connectionProvider"` и корректный проброс `NativeTransactionOutcomeUnknownError` без `ROLLBACK` при потере подтверждения `COMMIT`.
