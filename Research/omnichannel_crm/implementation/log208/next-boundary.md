# Следующая граница после LOG-208

## Что закрыто в LOG-208
- **Общий post-rollback denied/failed audit (`post-rollback-crm-audit-attempt.ts`, `CommonBaseQueryRunnerService`, `WorkspaceDataSource`)**:
  - Все 11 покрытых корневых публичных CRM-мутаций (`CREATE_ONE/MANY`, `UPDATE_ONE/MANY`, `DELETE_ONE/MANY`, `DESTROY_ONE/MANY`, `RESTORE_ONE/MANY`, не-`dryRun` `MERGE_MANY`) записывают `denied`/`failed` attempt после подтверждённого отката в отдельной строгой ограниченной транзакции (`nativeOwnershipLock: 'none'`, `commitOutcome: 'strict'`, `lock_timeout = '3s'`, `statement_timeout = '5s'`) без блокировки на `lockOmniNativeOwnership` и без подмены исходного исключения.
  - Переиспользуемый `recordPostRollbackCoreAuditAttempt` для core/metadata/session owners через `runInCoreAuditTransaction`.
  - allowlist-классификация `classifyCrmAuditAttemptOutcome` (включая `PermissionsException`, `RLS_VALIDATION_FAILED`, `AuthException`, `OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND`, `RECORD_NOT_FOUND`, `audit_coverage_rejected`, `invalid_input`, `database_error`) без утечки сырых текстов ошибок/PII и без новых Enterprise-рёбер.
  - Строгий инвариант `isTransactionUnsafeToRetry`: при `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError` ложный `failed`-attempt не пишется, а в health фиксируется `TRANSACTION_OUTCOME_UNKNOWN_AUDIT_SKIPPED`.
- **Централизованный health и alerting (`crm-audit-health.ts` + 8 существующих `*_AUDIT_UNAVAILABLE` точек)**:
  - `reportCrmAuditUnavailable`, `registerCrmAuditAlertSink` (с изоляцией sync/async ошибок sink), `getCrmAuditHealthSnapshot` (скользящее окно без вечной защёлки `degraded`), `checkCrmAuditDatabaseHealth` и `CrmAuditHealthService` (read-only проба БД и append-only прав с TTL-кэшем, single-flight дедупликацией и монотонным fencing кэша).
  - Все 8 существующих `*_AUDIT_UNAVAILABLE` точек подключены к `reportCrmAuditUnavailable` с защитой от ложных алертов при откате (`committed || uncertainOutcome` / `scope.afterCommit`).

## Оставшиеся открытые границы ROB-765
1. **Расширение FK-покрытия `prepareNativeCrmDeleteEffects` и оставшиеся native/core/metadata writers**: непокрытые входящие FK-таблицы (`timelineActivity`, `noteTarget`, `taskTarget`, `attachment`, email `messageParticipant`) и неподключённые native/core/metadata writers.
2. **Подключение `CrmAuditHealthService` к защищённому административному API (`AdminPanelGuard` / `ROB-767`) и внешнему sink алертинга**: `GET /healthz` намеренно оставлен zero-IO liveness; защищённый health-эндпоинт и экспортёр метрик подключаются с учётом прав администратора.
3. **Архитектурные ограничения Session lifecycle**: `UserSessionEntity` не хранит `familyId`, `signOut({ refreshToken })` отзывает только предъявленный токен, `ApplicationTokenService` выпускает stateless JWT без DB-отзыва, `UserSessionCleanupCronJob` ожидает утверждения политики хранения.
4. **Build / deployment / full HTTP/JWT acceptance**: сборка нового образа, полная сквозная HTTP/JWT приёмка и выкат (текущий собранный кандидат - `LOG088`).

## Рекомендуемый следующий срез (LOG-209)
- Расширение FK-покрытия `prepareNativeCrmDeleteEffects` (например `noteTarget`, `taskTarget`, `attachment`, `timelineActivity`) либо сборка нового изолированного кандидата и сквозная HTTP/JWT приёмка накопленного покрытия `ROB-765` по приоритету владельца.
