# Независимое ревью реализации LOG168

Дата: 08.11.2026
Задача: ROB-765 (`LOG168` - транзакционный аудит жизненного цикла `twoFactorAuthenticationMethod` и операций восстановления `redeemRecoveryCode`)
Вердикт: `pass`

## 1. Полнота охвата точек записи, удаления и восстановления

Проверены все обращения к `core."twoFactorAuthenticationMethod"` и пакетному отзыву `core."appToken"` (`RefreshToken`) при погашении кода восстановления:

- `TwoFactorAuthenticationService.initiateStrategyConfiguration` (вызывается из `TwoFactorAuthenticationResolver.initiateOTPProvisioning` и `TwoFactorAuthenticationResolver.initiateOTPProvisioningForAuthenticatedUser`) переведён на `runAuditedTwoFactorProvisioning`:
  - при создании нового `PENDING` метода записывается `twoFactorAuthenticationMethod:create`;
  - при переиспользовании `PENDING` метода младше `PENDING_METHOD_REUSE_WINDOW_MS` (1 час) запись в БД и `audit.flush()` не выполняются, шумовые события не создаются;
  - при ротации просроченного `PENDING` метода (старше 1 часа) обновляется `secret` (с монотонным продвижением `updatedAt = GREATEST(now(), "updatedAt" + interval '1 microsecond')`) и записывается `twoFactorAuthenticationMethod:update` (`changedFields: ['secret']`);
  - при наличии метода со статусом `VERIFIED` выбрасывается `TWO_FACTOR_AUTHENTICATION_METHOD_ALREADY_PROVISIONED` без записи в аудит.
- `TwoFactorAuthenticationService.validateStrategy` (вызывается из `AuthResolver.getAuthTokensFromOTP`, `TwoFactorAuthenticationService.verifyTwoFactorAuthenticationMethodForAuthenticatedUser` и `TwoFactorAuthenticationService.assertFreshStepUpAuthenticationOrThrow`) переведён на `runAuditedTwoFactorValidation`:
  - при переходе `PENDING -> VERIFIED` обновляет `status = 'VERIFIED'`, отзывает коды восстановления в той же транзакции и записывает `twoFactorAuthenticationMethod:update` (`changedFields: ['status']`);
  - при проверке уже подтверждённого (`VERIFIED`) метода физический `UPDATE` метода и `audit.flush()` не выполняются (T1), коды восстановления отзываются в той же транзакции.
- `TwoFactorAuthenticationResolver.deleteTwoFactorAuthenticationMethod` делегирует в `TwoFactorAuthenticationService.deleteTwoFactorAuthenticationMethod` -> `runAuditedTwoFactorDeletion`, который атомарно проверяет принадлежность метода и записывает `twoFactorAuthenticationMethod:delete`.
- `TwoFactorAuthenticationRecoveryService.redeemRecoveryCode` (вызывается из `AuthResolver.getAuthTokensFromTwoFactorAuthenticationRecoveryCode`) переведён на `runAuditedTwoFactorRecoveryRedemption`:
  - погашает `AppTokenType.TwoFactorAuthenticationRecoveryCode`;
  - удаляет существующие строки `core."twoFactorAuthenticationMethod"` пользователя в рабочем пространстве и записывает `twoFactorAuthenticationMethod:delete` для каждой строки;
  - блокирует и отзывает все неистёкшие `AppTokenType.RefreshToken` пользователя в этом рабочем пространстве (`revokedAt = COALESCE("revokedAt", $now)`, `context.revokedReason = 'two_factor_authentication_reset'`) и записывает `refreshToken:update` с `tokenOwner: { userId, access: 'currentWorkspaceAdministration' }` для каждого токена, у которого изменился `revokedAt` или `revokedReason`;
  - при `isTwoFactorAuthenticationEnforced = true` создаёт новый `PENDING` метод с новым `UUID` (`twoFactorAuthenticationMethod:create`) в том же `CrmAuditTransactionContext` и с тем же `operationId`.
- Каскадное удаление `core."twoFactorAuthenticationMethod"` при удалении `core."userWorkspace"` (`ON DELETE CASCADE`) ранее закрыто в `membership-cleanup-audit.ts` (`LOG114`). Dev-seeder (`seedTwoFactorAuthenticationMethods`) работает только как тестовая bootstrap-фикстура.

## 2. Атомарность транзакций и блокировки

Во всех четырёх транзакционных раннерах (`runAuditedTwoFactorProvisioning`, `runAuditedTwoFactorValidation`, `runAuditedTwoFactorDeletion`, `runAuditedTwoFactorRecoveryRedemption`) в `packages/twenty-server/src/engine/core-modules/crm-audit/two-factor-authentication-audit.ts` соблюдены требования атомарности:

- Идентичность и контекст операции захватываются синхронно через `captureTwoFactorAuthenticationAudit` до первого `await` во всех методах сервисов (`initiateStrategyConfiguration`, `validateStrategy`, `deleteTwoFactorAuthenticationMethod`, `redeemRecoveryCode`).
- Модуль зарегистрирован в `registerMetadataAuditScopeCheck(getTwoFactorAuthenticationAudit)` и защищён от повторного использования контекста (`consumed.has(request)`) и вложенных транзакций (`storage.getStore() || hasConflictingMetadataAuditScope(request.workspaceId)`).
- В начале каждой транзакции `runInCoreAuditTransaction` выставляется `SET LOCAL lock_timeout = '8s'` и берётся эксклюзивная блокировка `acquireUserAuthenticationLock({ entityManager: runner.manager, userId: normalizedUserId, mode: 'exclusive' })`.
- Родительская строка `core.workspace` (`WHERE id = $1 AND "deletedAt" IS NULL`) и строка `core."userWorkspace"` блокируются через `FOR NO KEY UPDATE`.
- Целевые строки `core."twoFactorAuthenticationMethod"` и `core."appToken"` блокируются через `FOR UPDATE` (при множественной выборке - с детерминированным порядком `ORDER BY id FOR UPDATE`).
- Загрузка метода по `id` или `("userWorkspaceId", strategy)` выполняется без предварительной фильтрации по `workspaceId` в `WHERE`, после чего явно проверяется `uuid(row.workspaceId) === request.workspaceId` (fail-closed при кросс-воркспейсном расхождении).
- В `runAuditedTwoFactorValidation` условие обновления проверяет `WHERE id = $2 AND "workspaceId" = $3 AND secret = $4 AND "deletedAt" IS NULL`, защищая резервную регистрацию от гонки с параллельным `redeemRecoveryCode`.
- После `audit.flush()` во всех четырёх функциях выполняется повторное чтение из БД и побайтовая сверка через `canonicalAuditJson` (или проверка отсутствия удалённых строк).

## 3. Секреты, редактирование и совместимость с `membership-cleanup-audit.ts`

- В `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`:
  - `CATALOG.twoFactorAuthenticationMethod` содержит `values: ['userWorkspaceId', 'strategy', 'status']` и `redacted: ['secret', 'deletedAt']`;
  - `ADMINISTRATIVE_ACTIONS.twoFactorAuthenticationMethod` включает `['create', 'update', 'delete']`.
- Поле `secret` проверяется на префикс `enc:v2:` перед записью в БД, хешируется при расчёте `changedFields` (обеспечивая фиксацию `changedFields: ['secret']` при перезаписи просроченного `PENDING` метода), но никогда не попадает в `redactedDiff.values`.
- В `membership-cleanup-audit.ts` поле `'secret'` входит в `SECRET_FIELDS` и удаляется оператором `to_jsonb(r) - $1::text[]`; функция `capture()` в `crm-audit-transaction-context.ts` пропускает отсутствующие свойства (`!Object.hasOwn(input, field)`), поэтому обратная совместимость с каскадным удалением `userWorkspace` полностью сохранена.

## 4. Атрибуция актора и инварианты M1-M5, T1-T2

- **M1 (редактирование `secret` и ротация `PENDING` метода)**: закрыто через `redacted: ['secret', 'deletedAt']` и проверку `String(beforeSnapshot.secret) === String(afterRow.secret)` в `runAuditedTwoFactorProvisioning`.
- **M2 (атомарная защита резервной регистрации)**: внутри `runAuditedTwoFactorProvisioning` под `acquireUserAuthenticationLock` проверяется отсутствие непогашенной резервной регистрации в `core."appToken"` (`type = 'TWO_FACTOR_AUTHENTICATION_RECOVERY_CODE' AND "deletedAt" IS NOT NULL AND "revokedAt" IS NULL AND "createdAt" >= $3`) до создания или переиспользования метода.
- **M3 (аудит пакетного отзыва `RefreshToken`)**: внутри `runAuditedTwoFactorRecoveryRedemption` все неистёкшие `REFRESH_TOKEN` блокируются и обновляются с записью `refreshToken:update` и `tokenOwner: { userId: normalizedUserId, access: 'currentWorkspaceAdministration' }`.
- **M4 (разделение `resourceId` при замене метода в `redeemRecoveryCode`)**: `replacementId` генерируется через `do { replacementId = randomUUID(); } while (beforeMethods.some((item) => item.id === replacementId))`, обеспечивая раздельные записи `twoFactorAuthenticationMethod:delete` и `twoFactorAuthenticationMethod:create` в одном `operationId`.
- **M5 (обработка пост-коммит и неопределённых ошибок транзакции)**: реализовано в `TwoFactorAuthenticationRecoveryService.redeemRecoveryCode`.
- **T1 (отсутствие шума при повторной проверке `VERIFIED` метода)**: в `runAuditedTwoFactorValidation` обновление и `audit.flush()` выполняются только при `statusChanged === true`.
- **T2 (совместимость с unit-тестами)**: `@Optional() @InjectDataSource()` с fallback `resolveDataSource()` и делегированием в `TwoFactorAuthenticationResolver.deleteTwoFactorAuthenticationMethod` через проверку `typeof this.twoFactorAuthenticationService.deleteTwoFactorAuthenticationMethod === 'function'` сохраняют работоспособность существующих unit-тестов с мок-репозиториями.
- **Проверка субъекта (`assertActorMatchesUserWorkspace`)**: гарантирует, что актор (или инициатор) является пользователем (`coreUser` или `workspaceMember`) и точно соответствует владельцу целевого `userWorkspace`.

## 5. Обработка `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError`

- В `TwoFactorAuthenticationRecoveryService.redeemRecoveryCode` при перехвате `NativeTransactionOutcomeUnknownError` или `CoreAuditPostCommitError` вызывается `this.userSessionService.revokeAllSessionsForUser` внутри вложенного `try / catch`, после чего исходная ошибка пробрасывается дальше. Отправка письма `sendTwoFactorAuthenticationResetEmail` и возврат `provisioningUri` / выдача токенов в `AuthResolver.getAuthTokensFromTwoFactorAuthenticationRecoveryCode` не выполняются.
- В `TwoFactorAuthenticationService.initiateStrategyConfiguration`, `validateStrategy` и `deleteTwoFactorAuthenticationMethod` ошибки `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` не перехватываются и пробрасываются вызывающему коду без маскирования.

## 6. Полнота PostgreSQL-тестов

В `packages/twenty-server/test/fork-migration/crm-audit-two-factor-authentication.postgres-spec.ts` реализованы 6 интеграционных PostgreSQL-сценариев против изолированной роли БД с проверкой привилегий `crm_audit`:

1. Создание `PENDING` метода (`twoFactorAuthenticationMethod:create`), переиспользование в окне 1 часа без дублирования аудита, ротация просроченного `PENDING` метода (`twoFactorAuthenticationMethod:update`, `changedFields: ['secret']`), отсутствие секрета и `enc:v2:` в `crmAuditEntry`, отказ `TWO_FACTOR_AUTHENTICATION_METHOD_ALREADY_PROVISIONED` для `VERIFIED` метода.
2. Переход `PENDING -> VERIFIED` (`twoFactorAuthenticationMethod:update`, `changedFields: ['status']`), отзыв кодов восстановления, отказ при неверном OTP без записи аудита, отсутствие шумовых записей при повторной проверке `VERIFIED` метода (T1).
3. Удаление метода владельцем (`twoFactorAuthenticationMethod:delete`), отказы при удалении несуществующего (`INVALID_INPUT`) и чужого (`FORBIDDEN_EXCEPTION`) метода без мутации БД и журнала аудита.
4. Погашение кода восстановления (`redeemRecoveryCode`) при `isTwoFactorAuthenticationEnforced = false` и `true`, единый `operationId` для `twoFactorAuthenticationMethod:delete`, `refreshToken:update` и `twoFactorAuthenticationMethod:create`, блокировка публичного `initiateStrategyConfiguration` с `RECOVERY_ENROLLMENT_RESTRICTED` до подтверждения резервного метода (M2, M3, M4).
5. Fail-closed инварианты при пустом `auditIdentity`, несовпадении `coreUser` / `workspaceMember` с `userWorkspace.userId` и кросс-воркспейсном `twoFactorAuthenticationMethod.workspaceId`.
6. Проброс `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` с принудительным отзывом сессий и подавлением отправки email в `redeemRecoveryCode` (M5).

Замечаний и блокеров не обнаружено.
