# LOG-208 Code Review

## Вердикт первичного независимого ревью кода
`NEEDS_REVISION` (`0` Blocker, `4` Major, `4` Minor). Все `8` находок исправлены и повторно проверены на PostgreSQL 17 (`13/13` целевых наборов, `419/419` тестов PASS, дифференциальный typecheck `0` новых диагностик, Enterprise/migration гварды `0` нарушений).

## Закрытые находки

### Major
1. **M1 - Устаревший `nowMs` после `await pending` и NTP-фильтр в `crm-audit-health.ts`**:
   - В `checkCrmAuditDatabaseHealth` чтение `getCrmAuditHealthSnapshot` после `await pending` теперь перечитывает актуальное время, когда `options.nowMs` не передан, чтобы сбой аудита во время DB-пробы не скрывался.
   - В `getCrmAuditHealthSnapshot` верхняя граница `entry.occurredAtMs <= nowMs` применяется только при явно переданном `options.nowMs`, исключая скрытие свежих потерь при обратном сдвиге системных часов.
2. **M2 - Гонки `probeCache` при конкурентных `bypassCache` и `inFlightProbes` в `crm-audit-health.ts`**:
   - Введён монотонный счётчик `nextProbeSeq` и обновление `probeCache` только в создателе пробы при `cacheTtlMs > 0` и `startedSeq >= currentCached.startedSeq`. Устаревшая долгая проба больше не перетирает более свежий результат `bypassCache`, а вызов с `cacheTtlMs: 0` не инвалидирует валидный кэш.
3. **M3 - Ложные алерты при откате транзакции в 7 подключённых точках `*_AUDIT_UNAVAILABLE`**:
   - В 5 core-транзакциях (`refresh-token.service.ts`, `user-session.service.ts`, `delete-user-workspace-transaction.ts`, `deactivate-core-user-with-audit.ts`, `transfer-connected-accounts-with-audit.ts`) добавлены флаги `committed` и `uncertainOutcome = isTransactionUnsafeToRetry(error)`: `reportCrmAuditUnavailable` в `finally` вызывается только при `auditLost/auditUnavailable/unavailable && (committed || uncertainOutcome)`.
   - В `delete-native-workspace-member-with-audit.ts` и `record-share-audit.ts` вызов `reportCrmAuditUnavailable` перенесён в `scope.afterCommit(...)` (с безопасным fallback) и дополнен `workspaceId`.
4. **M4 - Тестовое покрытие single-flight, гонок кэша, `NativeTransactionOutcomeUnknownError` в core-пути и реального wiring `*_AUDIT_UNAVAILABLE`**:
   - В `crm-audit-post-rollback-and-health.postgres-spec.ts` добавлен 8-й тест, проверяющий неинициализированный `DataSource`, single-flight дедупликацию + защиту от затирания кэша устаревшей пробой + видимость конкурентной потери аудита во время DB-пробы, `NativeTransactionOutcomeUnknownError` в `recordPostRollbackCoreAuditAttempt` и реальный вызов `deactivateCoreUserWithAudit` (0 алертов при откате триггером, 1 алерт и `degraded` при коммите без audit scope).

### Minor
1. **m1 - Валидация прямых входов в `recordPostRollbackNativeCrmAuditAttempt`**: добавлены предварительная проверка UUID для `resourceId`, `objectMetadataId`, `impersonatorUserWorkspaceId`, проверка `actor.kind === 'workspaceMember'` при имперсонации и пропуск `'Native audit operation was already committed'` как `skippedInvalidAttribution` без ложного `POST_ROLLBACK_AUDIT_UNAVAILABLE`.
2. **m2 - Уточнение классификации в `classifyCrmAuditAttemptOutcome`**: `INVALID_INPUT` добавлен в `INVALID_INPUT_CODES`; не-denial коды `AuthException`/`PermissionsException` (`INTERNAL_SERVER_ERROR`, `INVALID_INPUT`, `OBJECT_METADATA_NOT_FOUND_PERMISSIONS`, `USER_WORKSPACE_NOT_FOUND` и др.) больше не маркируются как `denied`.
3. **m3 - Жёсткий контракт `nativeOwnershipLock: 'none'` в `WorkspaceDataSource`**: запрещён запуск с `commitOutcome !== 'strict'` и отключён `scope.afterCommit(...)`.
4. **m4 - Мелкие согласования**: `runDatabaseProbe` учитывает `explicitNowMs` для `checkedAt`; `workspaceId` передаётся в `delete-native-workspace-member-with-audit.ts` и `record-share-audit.ts`; исправлен путь к `workspace-transaction-lifecycle.type.ts` в `design.md`. `CrmAuditHealthService` остаётся готовым `@Injectable()`-провайдером для подключения в административном модуле на этапе `ROB-767`.
