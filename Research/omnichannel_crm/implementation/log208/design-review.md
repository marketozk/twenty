# LOG-208 Design Review

## Вердикт первичного ревью
`NEEDS_REVISION` (4 Blocker, 3 Major, 4 Minor). Все находки закрыты до начала реализации и перенесены в [design.md](design.md).

## Разбор находок и принятые решения

### Blockers
1. **B1 - Публичный `GET /healthz/crm-audit` под `PublicEndpointGuard` (DoS через пул БД + утечка телеметрии)**:
   - **Решение**: убрано добавление неаутентифицированного эндпоинта в `HealthController` (`GET /healthz` остаётся строго zero-IO liveness). Вся health-диагностика оформлена в `crm-audit-health.ts` (`checkCrmAuditDatabaseHealth`, `getCrmAuditHealthSnapshot`, `reportCrmAuditUnavailable`, `registerCrmAuditAlertSink`, `CrmAuditHealthService`) со встроенным TTL-кэшем (5 с) + single-flight дедупликацией (`inFlightProbe`) + `bypassCache` для тестов и проверкой `!dataSource?.isInitialized`. Подключение к защищённому административному API остаётся за `ROB-767` / `AdminPanelGuard`.
2. **B2 - `lockOmniNativeOwnership` без `lock_timeout` при использовании `runInWorkspaceTransaction`**:
   - **Решение**: добавлен явный режим `nativeOwnershipLock?: 'shared' | 'exclusive' | 'none'` в `WorkspaceTransactionOptions` (`workspace-data-source.ts`). При `nativeOwnershipLock: 'none'` запрещена комбинация с `nativeAudit` и отключён `scope.getRepository(...)` (бросает ошибку), чтобы исключить обход ownership fence для CRM-таблиц. `recordPostRollbackNativeCrmAuditAttempt` использует `nativeOwnershipLock: 'none'`, `commitOutcome: 'strict'` и первым оператором выставляет `SET LOCAL lock_timeout = '3s'` и `SET LOCAL statement_timeout = '5s'`.
3. **B3 - Ложный `POST_ROLLBACK_AUDIT_UNAVAILABLE` при невалидном имперсонаторе / конфликте контекста**:
   - **Решение**: если исходная транзакция отказала из-за невалидной/удалённой клиентской атрибуции (`Native audit impersonation initiator unavailable`, `Native audit impersonation context conflict`, `Native audit workspace mismatch`) или при резолюции имперсонатора в post-rollback attempt получено 0 активных строк, `recordPostRollbackNativeCrmAuditAttempt` возвращает `{ recorded: false, skippedInvalidAttribution: true }` и **не вызывает** `reportCrmAuditUnavailable` (не деградирует health БД на клиентском отказе).
4. **B4 - `error.name === 'Error'` у `CustomError`/`CustomException`/`PostgresException` + `RLS_VALIDATION_FAILED` + реальные коды `CommonQueryRunnerException` + `MERGE` FILES**:
   - **Решение**: `classifyCrmAuditAttemptOutcome(error)` использует `error.constructor?.name`, точные `error.code` (без импорта Enterprise-классов) и проверяет:
     - `PermissionsException` / `PERMISSION_DENIED` -> `denied`, `crm.mutation.permission_denied`;
     - `AuthException` -> `denied`, `crm.mutation.auth_denied`;
     - `RLS_VALIDATION_FAILED` -> `denied`, `crm.mutation.rls_denied`;
     - `OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND` / `OMNI_NATIVE_MUTATION_REQUIRES_DOMAIN_COMMAND` -> `denied`, `crm.mutation.domain_command_required`;
     - `RECORD_NOT_FOUND` -> `failed`, `crm.mutation.record_not_found`;
     - `Merging files from duplicate records` / `Merging records that share the same file` / `Native audit` / `Native file` / `Native delete` / `Nested public CREATE exceeds native audit coverage` -> `failed`, `crm.mutation.audit_coverage_rejected` (до общего `BAD_REQUEST`);
     - `INVALID_QUERY_INPUT` / `INVALID_ARGS_DATA` / `INVALID_ARGS_FIRST` / `INVALID_ARGS_LAST` / `INVALID_ARGS_FILTER` / `ARGS_CONFLICT` / `BAD_REQUEST` / `UPSERT_MULTIPLE_MATCHING_RECORDS_CONFLICT` / `TOO_MANY_RECORDS_TO_UPDATE` -> `failed`, `crm.mutation.invalid_input`;
     - `INVALID_AUTH_CONTEXT` -> `failed`, `crm.mutation.invalid_auth_context`;
     - `TwentyOrmException` / `PostgresException` / `QueryFailedError` / 5-символьный SQLSTATE -> `failed`, `crm.mutation.database_error`;
     - прочее -> `failed`, `crm.mutation.execution_failed`.

### Major
1. **M1 - Вечная защёлка `status: 'degraded'`**: введено скользящее окно `recentWindowMs` (дефолт 15 мин, с инъекцией `nowMs` для детерминированных тестов), чтобы `status` автоматически возвращался в `'ok'` после истечения окна без новых сбоев при исправной БД.
2. **M2 - Exact-match ассерты `Logger.prototype.error` в 3 существующих PG-спеках и перенос в `finally`**: `reportCrmAuditUnavailable` форматирует сообщение как `code` при отсутствии `operationId` и как `${code} operationId=${operationId}` при наличии `operationId` (100% обратная совместимость со всеми 12 существующими тестовыми проверками). В `transfer-connected-accounts-with-audit.ts` вызов переносится в `finally`. Все 5 смежных PG-спеков (`crm-audit-core-user-deactivation`, `crm-audit-native-member`, `omni-metadata-transaction`, `crm-audit-membership-owner`, `crm-audit-refresh-logout`) включены в целевой прогон.
3. **M3 - Async-отклонения в `registerCrmAuditAlertSink`**: поддерживается `void | Promise<void>`, вызов каждого sink обёрнут в `Promise.resolve().then(() => sink(record)).catch(() => undefined)`, возвращается функция отписки `() => void`.

### Minor
1. В `checkCrmAuditDatabaseHealth` первым оператором транзакции идёт `SET LOCAL TRANSACTION READ ONLY`, затем `SET LOCAL lock_timeout = '1s'` и `SET LOCAL statement_timeout = '3s'`, до старта транзакции проверяется `!dataSource?.isInitialized`.
2. Для `action === 'delete'` с `outcome !== 'success'` зафиксировано, что `deletedRecord: { access: 'currentWorkspaceAdministration' }` задаёт fail-closed административную область видимости для `ROB-767`, а не свершившееся удаление.
3. В 5 публичных PG-спеках обновляются только те ассерты, где root-мутация реально откатилась внутри транзакции, с проверкой `0` `success` и наличия ожидаемого `denied`/`failed` attempt.
4. `captureNativeCrmAuditBinding` в `CommonBaseQueryRunnerService` вызывается строго синхронно перед `runInWorkspaceTransaction` без промежуточных `await`.
