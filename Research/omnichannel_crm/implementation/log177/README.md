# LOG-177 - Транзакционный аудит полного жизненного цикла `connectionProvider` (`core."connectionProvider"`) и отчётов об отказе авторизации подключений приложений (`ApplicationConnectionAuthFailureService.reportAuthFailureOrThrow` -> `core."connectedAccount"`)

## 1. Выполнено

1. Расширен каталог ресурсов и административных действий в `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit.types.ts` и `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`:
   - `connectionProvider`: `values: ['applicationId', 'type', 'scope']`, `redacted: ['name', 'displayName', 'logo', 'oauthConfig', 'identifyAccountLogicFunctionUniversalIdentifier', 'onConnectLogicFunctionUniversalIdentifier', 'onDisconnectLogicFunctionUniversalIdentifier']`, действия `['create', 'update', 'delete']`.
2. Расширены `packages/twenty-server/src/engine/core-modules/crm-audit/application-metadata-audit.ts` и `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service.ts`:
   - В `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES` добавлен `'connectionProvider'` (fail-closed барьер на неаудируемые миграции `connectionProvider` в `WorkspaceMigrationRunnerService.executeRun` и автоматическая системная обёртка при `isSystemBuild: true` в `WorkspaceMigrationValidateBuildAndRunService`).
   - В `ApplicationMetadataAuditMappings` добавлен `connectionProviders`, заполняемый из `allFlatEntityMaps.flatConnectionProviderMaps`.
   - В `runAuditedApplicationMetadataMigration` добавлены `assertConnectionProviderRowInvariants` и `projectConnectionProvider`, чтение `core."connectionProvider"` под `ORDER BY id FOR UPDATE`, запрет мутаций `connectionProvider` в режимах `objectDelete`/`fieldDelete`, проверка отсутствия ссылок в `core."connectedAccount"` перед удалением провайдера, сверка созданных и обновлённых строк с планом миграции, запись `connectionProvider:create`, `connectionProvider:update` и `connectionProvider:delete` и повторная сверка снимка после `audit.flush()`.
   - В `assertNoRemainingApplicationRoleOrPermissionMetadata` добавлена проверка `core."connectionProvider"` перед удалением `core.application` (`ApplicationService.delete`).
3. Расширены `packages/twenty-server/src/engine/core-modules/crm-audit/application-authorization-and-variable-audit.ts`, `packages/twenty-server/src/engine/core-modules/application/connection-provider/connections/services/application-connection-auth-failure.service.ts` и `packages/twenty-server/src/engine/core-modules/application/connection-provider/connections/application-connections.resolver.ts`:
   - Добавлены `projectConnectedAccountAuthFailure`, `captureAppConnectionAuthFailureAudit` и `runAuditedAppConnectionAuthFailureReport`.
   - Внутри `runInCoreAuditTransaction` (`SET LOCAL lock_timeout = '8s'`) блокируются `core.workspace` (`FOR NO KEY UPDATE`), `core.application` (`FOR NO KEY UPDATE`), `core."userWorkspace"` (`FOR SHARE` при наличии `requestUserWorkspaceId`) и `core."connectedAccount"` (`FOR UPDATE`), проверяется видимость `USER`- и `WORKSPACE`-подключений, пропускаются устаревшие отчёты (`status: 'superseded'`) при обновлённом `lastCredentialsRefreshedAt`, записывается `connectedAccount:update` с редактированием `authFailedAt` и `authFailedReason` и повторно сверяется снимок после `audit.flush()`.

## 2. Доказательства и проверки на Schrodinger

- Целевой PostgreSQL прогон: `5` suites / `21` tests PASS (`10.826s`), включая `3` новых интеграционных теста в `packages/twenty-server/test/fork-migration/crm-audit-connection-provider-and-auth-failure.postgres-spec.ts`.
- Полный регрессионный прогон: `122` suites / `3175` tests PASS (`700.702s`) - [`regression.log`](regression.log).
- Guard unit tests: `33` tests PASS (`0.188s`), `10` migration checksums неизменны, `0` нарушений границы Enterprise.
- Дифференциальный typecheck: `484` baseline / `485` current roots, `277` baseline / `277` current diagnostics, `0` новых и `0` в изменённом коде - [`typecheck-differential.json`](typecheck-differential.json).
- Снимок исходников: `8` файлов проверены по SHA-256 (LF) - [`source-snapshot.json`](source-snapshot.json).
- Артефакты проектирования и ревью: [`design.md`](design.md), [`design-review.md`](design-review.md), [`review.md`](review.md), [`test-research.md`](test-research.md), [`next-boundary.md`](next-boundary.md), [`results.json`](results.json).
