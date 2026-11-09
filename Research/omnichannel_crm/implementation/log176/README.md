# LOG-176 - Транзакционный аудит обновления секретных и конфигурационных переменных приложений уровня рабочего пространства (`applicationVariable`) и полного жизненного цикла флагов функциональности (`featureFlag`)

## 1. Выполнено

1. Расширен каталог ресурсов и административных действий в `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit.types.ts` и `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`:
   - `applicationVariable`: `values: ['applicationId', 'scope', 'isSecret']`, `redacted: ['key', 'value']`, действия `['update']`.
   - `featureFlag`: `values: ['key', 'value']`, `redacted: []`, действия `['create', 'update']`.
2. Расширен модуль `packages/twenty-server/src/engine/core-modules/crm-audit/application-authorization-and-variable-audit.ts`:
   - В `resolveOperationFromIdentity` добавлена поддержка request-подобных контекстов и субъекта `coreUser` (для межворкспейсных операций серверного администратора) с сохранением `impersonatorUserWorkspaceId`.
   - Добавлены `projectApplicationVariable`, `projectFeatureFlag`, `captureApplicationVariableUpdateAudit`, `captureFeatureFlagAudit`, `runAuditedApplicationVariableUpdate`, `runAuditedFeatureFlagUpsert` и `runAuditedFeatureFlagsEnable`.
   - В `runAuditedApplicationVariableUpdate` обновление `core."applicationVariable"` выполняется внутри `runInCoreAuditTransaction` с `SET LOCAL lock_timeout = '8s'`, блокировкой `core.workspace` (`FOR NO KEY UPDATE`), `core.application` (`FOR NO KEY UPDATE`) и целевой строки `core."applicationVariable"` (`FOR UPDATE`), проверкой конверта `enc:v2:`, принадлежности вызывающему приложению (`callingApplicationId` / `actor.kind === 'application'`), возвратом `{ status: 'not_found' | 'user_variable' }` для сохранения канонических кодов ошибок (`APPLICATION_VARIABLE_NOT_FOUND`, `INVALID_APPLICATION_VARIABLE_INPUT`), записью `applicationVariable:update` с редактированием `key` и `value` и повторной сверкой снимка после `audit.flush()`.
   - В `runAuditedFeatureFlagUpsert` и `runAuditedFeatureFlagsEnable` создание и переключение `core."featureFlag"` выполняются внутри `runInCoreAuditTransaction` с блокировкой `core.workspace` (`FOR NO KEY UPDATE`) и `core."featureFlag"` (`FOR UPDATE` / `ORDER BY ff.id FOR UPDATE`), подавлением идемпотентных повторов без изменений (`Boolean(beforeRow.value) === value`), записью `featureFlag:create` / `featureFlag:update` и повторной сверкой снимка после `audit.flush()`.
3. Подключены все точки входа `applicationVariable` и `featureFlag`:
   - `ApplicationVariableEntityService.update` и `ApplicationVariableEntityResolver.updateOneApplicationVariable` с синхронным захватом `auditIdentity` до первого `await` и инвалидацией кэша `flatApplicationVariableMaps` при `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`.
   - `FeatureFlagService.upsertWorkspaceFeatureFlag` и `FeatureFlagService.enableFeatureFlags` с валидацией ключей до открытия транзакции и инвалидацией кэша `featureFlagsMap` при фактическом изменении или `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`.
   - `LabResolver.updateLabPublicFeatureFlag`, `AdminPanelResolver.updateWorkspaceFeatureFlag` (с поддержкой как своего, так и целевого рабочего пространства для серверного администратора и `impersonationContext`) и `WorkspaceService.activateWorkspace`.

## 2. Доказательства и проверки на Schrodinger

- Целевой PostgreSQL прогон: `4` suites / `24` tests PASS (`8.961s`), включая `3` новых интеграционных теста в `packages/twenty-server/test/fork-migration/crm-audit-application-variable-and-feature-flag.postgres-spec.ts`.
- Полный регрессионный прогон: `121` suites / `3172` tests PASS (`702.355s`) - [`regression.log`](regression.log).
- Guard unit tests: `33` tests PASS (`0.188s`), `10` migration checksums неизменны, `0` нарушений границы Enterprise.
- Дифференциальный typecheck: `485` baseline / `486` current roots, `297` baseline / `297` current diagnostics, `0` новых и `0` в изменённом коде - [`typecheck-differential.json`](typecheck-differential.json).
- Снимок исходников: `10` файлов проверены по SHA-256 (LF) - [`source-snapshot.json`](source-snapshot.json).
- Артефакты проектирования и ревью: [`design.md`](design.md), [`design-review.md`](design-review.md), [`review.md`](review.md), [`test-research.md`](test-research.md), [`next-boundary.md`](next-boundary.md), [`results.json`](results.json).
