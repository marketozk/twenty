# LOG-208 Test Research

## 1. Целевые сценарии нового PG 17 теста (`crm-audit-post-rollback-and-health.postgres-spec.ts`)
Выполняется на реальном PostgreSQL 17 (`coreSchema: 'fork'`, ограниченная роль `runtimeDatabaseUrl` + `owner`), с реальными `CommonUpdateOneQueryRunnerService`, `CommonUpdateManyQueryRunnerService`, `CommonCreateOneQueryRunnerService`, `CommonDestroyOneQueryRunnerService`, `CommonMergeManyQueryRunnerService`, `HealthController`, `checkCrmAuditDatabaseHealth`, `reportCrmAuditUnavailable`, `recordPostRollbackCoreAuditAttempt`:

1. **Post-rollback `denied` audit для публичных CRM-мутаций**:
   - `PermissionsException` (нет права `canUpdateObjectRecords` / `canDestroyObjectRecords`) -> исходная ошибка пробрасывается, CRM-строка не изменена, в `crm_audit."crmAuditEntry"` ровно 1 запись с `outcome: 'denied'`, `reasonCode: 'crm.mutation.permission_denied'`, ненулевым `attemptId`, `redactedDiff: { changedFields: [], values: {} }`, серверным `actor`, `initiator` (под имперсонацией), `correlationId` / `causationId` из ALS, без приватных данных.
   - `OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND` -> исходная ошибка пробрасывается, запись цела, в `crm_audit."crmAuditEntry"` 1 запись `outcome: 'denied'`, `reasonCode: 'crm.mutation.domain_command_required'`, `action: 'delete'`, `deletedRecord: { access: 'currentWorkspaceAdministration' }`.
2. **Post-rollback `failed` audit для публичных CRM-мутаций**:
   - `RECORD_NOT_FOUND` (вкл. скрытую RLS-запись) -> `outcome: 'failed'`, `reasonCode: 'crm.mutation.record_not_found'`, `resourceId = args.id`.
   - Откат из-за БД-триггера / невалидного `core.file` / `MERGE` без поддержки `FILES` -> `outcome: 'failed'`, `reasonCode: 'crm.mutation.audit_coverage_rejected'` / `'crm.mutation.database_error'`, данные в БД откатаны, `0` `success`-записей, `1` `failed`-запись, приватные строки не попали в `reasonCode`/`redactedDiff`.
   - `CREATE_ONE` с сбоем без `id` и `UPDATE_MANY` со сбоем -> `resourceId = flatObjectMetadata.id`.
3. **Защита от `NativeTransactionOutcomeUnknownError` (lost COMMIT ACK)**:
   - При потере ACK после `COMMIT` `CommonUpdateOneQueryRunnerService` бросает `NativeTransactionOutcomeUnknownError`;
   - в `crm_audit."crmAuditEntry"` остаётся ТОЛЬКО закоммиченный `outcome: 'success'` (никакого ложного `outcome: 'failed'` attempt!);
   - в `crm-audit-health` зафиксирован `TRANSACTION_OUTCOME_UNKNOWN_AUDIT_SKIPPED` и сработал зарегистрированный `alertSink`.
4. **Недоступность журнала аудита (отказ post-rollback attempt -> сохранение исходной ошибки + health/alert)**:
   - При `BEFORE INSERT` триггере сбоя на `crm_audit."crmAuditEntry"` (или `REVOKE INSERT`):
     - мутация откатывается, post-rollback attempt тоже падает, **исходная ошибка не подменяется**;
     - `getCrmAuditHealthSnapshot()` переходит в `degraded` с `lastFailureCode: 'POST_ROLLBACK_AUDIT_UNAVAILABLE'`, зарегистрированный `alertSink` получает событие без секретов;
     - `checkCrmAuditDatabaseHealth(runtimeDataSource)` при `REVOKE INSERT` возвращает `status: 'unavailable'`, `appendOnlyPrivilegesVerified: false`; после `GRANT INSERT` и сброса состояния — `status: 'ok'`, `appendOnlyPrivilegesVerified: true`;
     - `HealthController.checkCrmAudit()` возвращает безопасный агрегированный ответ без `workspaceId`/`operationId`.
5. **Общий `recordPostRollbackCoreAuditAttempt` + `reportCrmAuditUnavailable` в `UserSessionService` / `RefreshTokenService`**:
   - `recordPostRollbackCoreAuditAttempt` записывает `denied`/`failed` attempt для `role` (`metadataAccess: 'currentWorkspaceAdministration'`) в отдельной core-транзакции и поднимает `POST_ROLLBACK_AUDIT_UNAVAILABLE` при недоступности БД без подмены исходной ошибки.
   - `reportCrmAuditUnavailable` вызывается из существующих `SAVEPOINT`-точек (проверяем счётчик/sink при `SESSION_REVOCATION_AUDIT_UNAVAILABLE`).

## 2. Существующие PG-тесты для совместного целевого прогона
1. `test/fork-migration/crm-audit-post-rollback-and-health.postgres-spec.ts` (новый)
2. `test/fork-migration/crm-audit-public-update.postgres-spec.ts` (обновлённый)
3. `test/fork-migration/crm-audit-public-destroy.postgres-spec.ts` (обновлённый)
4. `test/fork-migration/crm-audit-public-merge.postgres-spec.ts` (обновлённый)
5. `test/fork-migration/crm-audit-public-attribution-and-crud.postgres-spec.ts` (обновлённый)
6. `test/fork-migration/crm-audit-file-hard-delete.postgres-spec.ts` (обновлённый)
7. `test/fork-migration/crm-audit-user-session.postgres-spec.ts`
8. `test/fork-migration/crm-audit-session-lifecycle-hardening.postgres-spec.ts`

## 3. Гварды, дифференциальный typecheck и полная регрессия
- `check_enterprise_dependencies.py --verify-baseline` (`0` нарушений)
- `check_fork_migration_sources.py` + `33/33` Python unit tests
- Дифференциальный `tsgo --noEmit` против `HEAD` (`0` новых/changed-file/changed-code диагностик)
- Полная PG 17 регрессия на Schrodinger
- SHA-256 сверка и очистка стенда
