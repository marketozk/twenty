# LOG-208 - Общий post-rollback denied/failed audit и audit health/alerting

- Дата: `2026-11-24`
- Задача: Linear `ROB-765` (Phase 2a, остаётся `In Progress`)
- Ветка: `codex/omnichannel-requirements`

## Изменённые и добавленные файлы кода и тестов
1. `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-health.ts` (новый) - централизованный модуль состояния и алертинга подсистемы аудита: `reportCrmAuditUnavailable` (обратно совместимый формат логов `code` / `${code} operationId=...`, санитизация токенов, монотонные счётчики + скользящий буфер последних сбоев), `registerCrmAuditAlertSink` (с изоляцией синхронных и асинхронных ошибок sink и возвратом функции отписки), `getCrmAuditHealthSnapshot` (скользящее окно `recentWindowMs`, дефолт 15 мин, без вечной защёлки `degraded`), `checkCrmAuditDatabaseHealth` и `@Injectable() CrmAuditHealthService` (короткий read-only проход `SET LOCAL TRANSACTION READ ONLY`, `lock_timeout = '1s'`, `statement_timeout = '3s'`, `verifyCrmAuditPrivileges` + `SELECT 1 FROM crm_audit."crmAuditEntry" LIMIT 1`, TTL-кэш 5 с, single-flight дедупликация `inFlightProbes` и монотонный `nextProbeSeq` против затирания кэша устаревшей пробой).
2. `packages/twenty-server/src/engine/core-modules/crm-audit/post-rollback-crm-audit-attempt.ts` (новый) - общий post-rollback писатель отклонённых и неуспешных попыток: `classifyCrmAuditAttemptOutcome` (структурная allowlist-классификация `denied`/`failed` без импорта Enterprise-классов и без утечки сырых текстов ошибок/БД/PII, включая `PermissionsException`, `RLS_VALIDATION_FAILED`, `AuthException`, `OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND`, `RECORD_NOT_FOUND`, `audit_coverage_rejected`, `invalid_input`, `database_error`), `resolveNativeCrmAttemptTarget`, `recordPostRollbackNativeCrmAuditAttempt` (отдельная строгая транзакция `{ commitOutcome: 'strict', nativeOwnershipLock: 'none' }` с `lock_timeout = '3s'` и `statement_timeout = '5s'`, сохранением серверной атрибуции/имперсонации/корреляции, пропуском `isTransactionUnsafeToRetry` с `TRANSACTION_OUTCOME_UNKNOWN_AUDIT_SKIPPED`, пропуском невалидной клиентской атрибуции без ложной деградации health и `POST_ROLLBACK_AUDIT_UNAVAILABLE` без подмены исходной ошибки) и `recordPostRollbackCoreAuditAttempt` (через `runInCoreAuditTransaction`).
3. `packages/twenty-server/src/engine/twenty-orm/types/workspace-transaction-lifecycle.type.ts` и `packages/twenty-server/src/engine/twenty-orm/datasource/workspace-data-source.ts` - добавлен fail-closed режим `nativeOwnershipLock: 'none'` для чистых post-rollback audit транзакций (запрещены `nativeAudit`, `commitOutcome !== 'strict'`, `scope.getRepository(...)` и `scope.afterCommit(...)`, не захватывается `lockOmniNativeOwnership`).
4. `packages/twenty-server/src/engine/api/common/common-query-runners/common-base-query-runner.service.ts` - подключение `recordPostRollbackNativeCrmAuditAttempt` для всех 11 корневых покрытых публичных CRM-мутаций (`CREATE_*`, `UPDATE_*`, `DELETE_*`, `DESTROY_*`, `RESTORE_*`, не-`dryRun` `MERGE_MANY`) строго после отката `runInWorkspaceTransaction` без подмены исходной ошибки и без записи на вложенных `transactionScope`.
5. Подключение централизованного `reportCrmAuditUnavailable` ко всем 8 существующим `*_AUDIT_UNAVAILABLE` точкам с защитой от ложных алертов при откате (`committed || uncertainOutcome` в core-транзакциях и `scope.afterCommit` в workspace-транзакциях):
   - `packages/twenty-server/src/engine/core-modules/auth/token/services/refresh-token.service.ts`
   - `packages/twenty-server/src/engine/core-modules/user-session/services/user-session.service.ts`
   - `packages/twenty-server/src/engine/core-modules/user-workspace/delete-user-workspace-transaction.ts`
   - `packages/twenty-server/src/engine/core-modules/crm-audit/deactivate-core-user-with-audit.ts`
   - `packages/twenty-server/src/engine/core-modules/crm-audit/delete-native-workspace-member-with-audit.ts`
   - `packages/twenty-server/src/engine/core-modules/crm-audit/record-share-audit.ts`
   - `packages/twenty-server/src/engine/core-modules/crm-audit/transfer-connected-accounts-with-audit.ts`
6. `packages/twenty-server/test/fork-migration/crm-audit-public-update.postgres-spec.ts`, `crm-audit-public-destroy.postgres-spec.ts`, `crm-audit-public-merge.postgres-spec.ts`, `crm-audit-file-hard-delete.postgres-spec.ts` - обновлены ассерты откатившихся корневых мутаций (проверяются `0` `success`-записей и точные post-rollback `denied`/`failed` attempts).
7. `packages/twenty-server/test/fork-migration/crm-audit-post-rollback-and-health.postgres-spec.ts` (новый) - 8 PostgreSQL 17 сценариев (denied с имперсонацией/корреляцией, denied delete с `deletedRecord`, allowlisted failed без утечки PII + `RLS_VALIDATION_FAILED`, `nativeOwnershipLock: 'none'` под активной `exclusive`-блокировкой + запрет злоупотреблений, пропуск `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`, сохранение исходной ошибки при недоступности журнала + async sink isolation + скользящее окно + DB health probe / `REVOKE INSERT` / cache / single-flight / stale-probe fencing, `recordPostRollbackCoreAuditAttempt` и реальный wiring `deactivateCoreUserWithAudit` с проверкой отсутствия алерта при откате).

## Артефакты
- [design.md](design.md)
- [test-research.md](test-research.md)
- [design-review.md](design-review.md)
- [review.md](review.md)
- [results.json](results.json)
- [typecheck-differential.json](typecheck-differential.json)
- [source-snapshot.json](source-snapshot.json)
- [next-boundary.md](next-boundary.md)
