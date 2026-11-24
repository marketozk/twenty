# LOG-208 Design: General Post-Rollback Denied/Failed Audit & Audit Health/Alerting (Revised after Design Review)

## 1. Цель и границы
Закрыть строку `Denied/failed audit и health` в `rob765-progress.md` и требования `design/08-audit.md:39` / `implementation-spec.md:169` в рамках `ROB-765` без новых миграций БД и без новых Enterprise-зависимостей:

1. **Централизованный модуль health и alerting подсистемы аудита (`crm-audit-health.ts`)**:
   - `reportCrmAuditUnavailable(event)`:
     - типизированные коды (`CrmAuditUnavailableCode`), без секретов и клиентских данных;
     - обновляет монотонные счётчики (`totalUnavailableCount`, `countsByCode`, `lastFailureAt`, `lastFailureCode`) и кольцевой буфер `recentFailures` (лимит 100 записей);
     - пишет структурированный `Logger.error(...)` в обратно совместимом формате: `code` (когда `operationId` не задан) или `${code} operationId=${operationId}` (когда `operationId` задан);
     - асинхронно-безопасно уведомляет зарегистрированные `registerCrmAuditAlertSink` (`Promise.resolve().then(() => sink(record)).catch(() => undefined)`), возвращая `unsubscribe`.
   - `getCrmAuditHealthSnapshot({ recentWindowMs?, nowMs? })`:
     - вычисляет `recentUnavailableCount` и `hasRecentAuditLoss` строго по скользящему окну `recentWindowMs` (дефолт 15 минут), исключая вечную защёлку `degraded`.
   - `checkCrmAuditDatabaseHealth(dataSource, { bypassCache?, cacheTtlMs?, recentWindowMs?, nowMs? })` + `@Injectable() CrmAuditHealthService`:
     - короткий TTL-кэш (5 с) + single-flight дедупликация (`inFlightProbe`) против DB amplification;
     - проверка `!dataSource?.isInitialized` до старта транзакции;
     - короткая read-only транзакция: `SET LOCAL TRANSACTION READ ONLY` -> `SET LOCAL lock_timeout = '1s'` -> `SET LOCAL statement_timeout = '3s'` -> `verifyCrmAuditPrivileges(runner)` -> `SELECT 1 FROM crm_audit."crmAuditEntry" LIMIT 1`;
     - статус: `'unavailable'` если БД недоступна или `verifyCrmAuditPrivileges` не прошла, `'degraded'` если БД и права исправны, но `hasRecentAuditLoss === true`, иначе `'ok'`.
   - `HealthController` (`GET /healthz`) остаётся строго zero-IO liveness без неаутентифицированных БД-проб и без раскрытия внутренней телеметрии.
   - Подключение всех **8 существующих `*_AUDIT_UNAVAILABLE` точек** к `reportCrmAuditUnavailable` (в `transfer-connected-accounts-with-audit.ts` - с переносом в `finally` после транзакции).

2. **Изолированный режим `nativeOwnershipLock: 'none'` в `WorkspaceDataSource.transaction`**:
   - В `WorkspaceTransactionOptions` добавляется `nativeOwnershipLock?: 'shared' | 'exclusive' | 'none'`.
   - При `nativeOwnershipLock === 'none'`:
     - запрещена комбинация с `options.nativeAudit !== undefined` (fail-closed throw);
     - `lockOmniNativeOwnership` не захватывается (исключается бесконечное ожидание на exclusive ownership lock без `lock_timeout`);
     - `scope.getRepository(...)` бросает ошибку (нельзя обойти ownership fence для CRM-таблиц).

3. **Общий post-rollback denied/failed audit writer (`post-rollback-crm-audit-attempt.ts`)**:
   - `recordPostRollbackNativeCrmAuditAttempt(...)` (через `runInWorkspaceTransaction` с `nativeOwnershipLock: 'none'`, `commitOutcome: 'strict'`, `SET LOCAL lock_timeout = '3s'`, `SET LOCAL statement_timeout = '5s'`);
   - `recordPostRollbackCoreAuditAttempt(...)` (через `runInCoreAuditTransaction` с `SET LOCAL lock_timeout = '3s'`, `SET LOCAL statement_timeout = '5s'`);
   - Инвариант `isTransactionUnsafeToRetry(error)`: при `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError` отрицательный attempt **НЕ** записывается; фиксируется `reportCrmAuditUnavailable({ code: 'TRANSACTION_OUTCOME_UNKNOWN_AUDIT_SKIPPED', ... })` и возвращается `{ recorded: false, skippedUnknownOutcome: true }`.
   - Инвариант невалидной клиентской атрибуции: при `Native audit impersonation initiator unavailable` / `Native audit impersonation context conflict` / `Native audit workspace mismatch` (или 0 активных строк имперсонатора в post-rollback attempt) возвращается `{ recorded: false, skippedInvalidAttribution: true }` без деградации health БД.
   - Инвариант сохранения исходного отказа: при любой ошибке самой attempt-транзакции вызывается `reportCrmAuditUnavailable({ code: 'POST_ROLLBACK_AUDIT_UNAVAILABLE', ... })` и возвращается `{ recorded: false, alertReported: true }`; исходная ошибка caller никогда не подменяется.
   - `classifyCrmAuditAttemptOutcome(error)`: структурный allowlist по `error.constructor?.name`, `error.code` и фиксированным маркерам сообщений (без импорта Enterprise-классов):
     - `denied`: `crm.mutation.permission_denied`, `crm.mutation.auth_denied`, `crm.mutation.rls_denied`, `crm.mutation.domain_command_required`;
     - `failed`: `crm.mutation.record_not_found`, `crm.mutation.audit_coverage_rejected`, `crm.mutation.invalid_input`, `crm.mutation.invalid_auth_context`, `crm.mutation.database_error`, `crm.mutation.execution_failed`.
   - Для `action === 'delete'` (`DESTROY_ONE`, `DESTROY_MANY`, `MERGE_MANY`) с `outcome !== 'success'` используется `deletedRecord: { access: 'currentWorkspaceAdministration' }` как fail-closed административная область видимости для `ROB-767`.

4. **Подключение к `CommonBaseQueryRunnerService`**:
   - В `executeQueryAndEnrichResults` для корневой покрытой мутации (`auditedMutation && !queryRunnerContext.transactionScope`):
     - `nativeAuditOptions` и синхронный `captureNativeCrmAuditBinding(workspaceId, auth, nativeAuditOptions)` выполняются строго перед `runInWorkspaceTransaction` без промежуточных `await`;
     - в `catch (error)` вызывается `await recordPostRollbackNativeCrmAuditAttempt(...)`, затем немедленно перебрасывается исходная `error`.

## 2. Изменяемые и новые файлы
1. `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-health.ts` (новый)
2. `packages/twenty-server/src/engine/core-modules/crm-audit/post-rollback-crm-audit-attempt.ts` (новый)
3. `packages/twenty-server/src/engine/twenty-orm/types/workspace-transaction-lifecycle.type.ts`
4. `packages/twenty-server/src/engine/twenty-orm/datasource/workspace-data-source.ts`
5. `packages/twenty-server/src/engine/api/common/common-query-runners/common-base-query-runner.service.ts`
6. 7 файлов с `*_AUDIT_UNAVAILABLE`: `user-session.service.ts`, `refresh-token.service.ts`, `delete-user-workspace-transaction.ts`, `deactivate-core-user-with-audit.ts`, `delete-native-workspace-member-with-audit.ts`, `record-share-audit.ts`, `transfer-connected-accounts-with-audit.ts`
7. Обновление затронутых ассертов в 5 существующих public PG-спеках: `crm-audit-public-update`, `crm-audit-public-destroy`, `crm-audit-public-merge`, `crm-audit-public-attribution-and-crud`, `crm-audit-file-hard-delete`
8. `packages/twenty-server/test/fork-migration/crm-audit-post-rollback-and-health.postgres-spec.ts` (новый)
