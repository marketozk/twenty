# LOG168 - аудит жизненного цикла `twoFactorAuthenticationMethod` и связанных с ним операций восстановления

## 1. Область задачи

`LOG168` закрывает транзакционный аудит всех runtime-операций создания, обновления, удаления и замены методов двухфакторной аутентификации (`core."twoFactorAuthenticationMethod"`), а также пакетного отзыва refresh-токенов (`core."appToken"` типа `RefreshToken`) в рамках погашения кода восстановления двухфакторной аутентификации (`TwoFactorAuthenticationRecoveryService.redeemRecoveryCode`).

К моменту `LOG168` каскадное удаление `core."twoFactorAuthenticationMethod"` при удалении `core."userWorkspace"` (`ON DELETE CASCADE`) уже закрыто в `membership-cleanup-audit.ts` (`LOG114`). Все остальные точки записи `core."twoFactorAuthenticationMethod"` и пакетный отзыв refresh-токенов при 2FA-recovery оставались неподключёнными к `crm_audit."crmAuditEntry"`.

## 2. Полная инвентаризация точек записи и каскадов

### 2.1. `core."twoFactorAuthenticationMethod"`
1. **Инициализация / перевыпуск `PENDING` TOTP-метода**:
   - `TwoFactorAuthenticationService.initiateStrategyConfiguration(userId, userEmail, workspaceId, workspaceDisplayName, options?)`
   - Вызывается из:
     - `TwoFactorAuthenticationResolver.initiateOTPProvisioning` (по `loginToken`, публичный endpoint до завершения 2FA-входа; имперсонация запрещена через `assertLoginTokenIsNotForImpersonation`).
     - `TwoFactorAuthenticationResolver.initiateOTPProvisioningForAuthenticatedUser` (аутентифицированная пользовательская сессия без имперсонации).
   - Поведение:
     - Если метод не существует - создаёт новую строку `status = 'PENDING'`, `strategy = 'TOTP'` (`twoFactorAuthenticationMethod:create`).
     - Если метод существует со статусом `'PENDING'` и моложе `PENDING_METHOD_REUSE_WINDOW_MS` (1 час) - переиспользует существующий секрет без записи в БД и без ложного события аудита.
     - Если метод существует со статусом `'PENDING'` и старше 1 часа - перезаписывает `secret` новым зашифрованным секретом (`twoFactorAuthenticationMethod:update`, `changedFields: ['secret']`).
     - Если метод существует со статусом `'VERIFIED'` - выбрасывает `TWO_FACTOR_AUTHENTICATION_METHOD_ALREADY_PROVISIONED`.
2. **Подтверждение (`PENDING` -> `VERIFIED`) и повторная step-up / login проверка OTP**:
   - `TwoFactorAuthenticationService.validateStrategy(userId, token, workspaceId, strategy, options?)`
   - Вызывается из:
     - `AuthResolver.getAuthTokensFromOTP` (завершение входа по `loginToken` + OTP).
     - `TwoFactorAuthenticationService.verifyTwoFactorAuthenticationMethodForAuthenticatedUser` <- `TwoFactorAuthenticationResolver.verifyTwoFactorAuthenticationMethodForAuthenticatedUser`.
     - `TwoFactorAuthenticationService.assertFreshStepUpAuthenticationOrThrow` <- `TwoFactorAuthenticationRecoveryService.generateRecoveryCode` и `AdminPanelServerAdminService.updateServerAdminAccess`.
   - Поведение:
     - Когда метод находился в статусе `'PENDING'`, перевод в `'VERIFIED'` изменяет `status` (`'PENDING'` -> `'VERIFIED'`) и записывает `twoFactorAuthenticationMethod:update` (`changedFields: ['status']`).
     - Когда метод уже находился в статусе `'VERIFIED'` (обычный вход по OTP или step-up проверка), статус не меняется (`'VERIFIED'` -> `'VERIFIED'`); физическое обновление в БД не требуется (или является идемпотентным), но погашенные/активные коды восстановления отзываются, а шумовое событие `twoFactorAuthenticationMethod:update` не создаётся.
3. **Удаление метода пользователем**:
   - `TwoFactorAuthenticationResolver.deleteTwoFactorAuthenticationMethod` (делегирует в `TwoFactorAuthenticationService.deleteTwoFactorAuthenticationMethod`).
   - Поведение:
     - Проверяет существование метода в `workspace.id` и принадлежность `userWorkspace.userId === user.id`, удаляет строку и записывает `twoFactorAuthenticationMethod:delete` в одной транзакции `runInCoreAuditTransaction`.
4. **Погашение кода восстановления (`TwoFactorAuthenticationRecoveryService.redeemRecoveryCode`)**:
   - Вызывается из `AuthResolver.getAuthTokensFromTwoFactorAuthenticationRecoveryCode`.
   - В одной транзакции под `acquireUserAuthenticationLock(userId, 'exclusive')`:
     - Погашает код восстановления (`AppTokenType.TwoFactorAuthenticationRecoveryCode`).
     - Удаляет существующие строки `core."twoFactorAuthenticationMethod"` пользователя в этом рабочем пространстве (`twoFactorAuthenticationMethod:delete` для каждой удалённой строки).
     - Отзывает все неистёкшие `AppTokenType.RefreshToken` этого пользователя в этом рабочем пространстве с установкой `revokedAt = COALESCE("revokedAt", now())` и `context.revokedReason = 'two_factor_authentication_reset'` - для каждого затронутого токена, у которого изменился `revokedAt` или `revokedReason`, в том же `CrmAuditTransactionContext` записывается `refreshToken:update` (`tokenOwner: { userId, access: 'currentWorkspaceAdministration' }`).
     - Если `workspace.isTwoFactorAuthenticationEnforced === true`, создаёт новый `PENDING` TOTP-метод (`twoFactorAuthenticationMethod:create`) в той же транзакции (с новым `id`, поэтому события `delete` старого метода и `create` нового имеют разные `resourceId` в одном `operationId`).
5. **Dev-seeder (`seedTwoFactorAuthenticationMethods`)**:
   - Запускается только при `NODE_ENV === 'test'` для `SEED_APPLE_WORKSPACE_ID` внутри `DevSeederWorkspaceService.seedCoreSchema` до инициализации таблиц аудита `crm_audit`; остаётся bootstrap-фикстурой.

## 3. Архитектура и модель данных аудита

### 3.1. Расширение каталога `CrmAuditTransactionContext`
В `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`:
- В `CATALOG.twoFactorAuthenticationMethod`:
  - `values: ['userWorkspaceId', 'strategy', 'status']`
  - `redacted: ['secret', 'deletedAt']`
  - Поле `'secret'` содержит зашифрованный TOTP-секрет (`enc:v2:...`). Его включение в `redacted` гарантирует, что:
    1. Секрет никогда не попадёт в `redactedDiff.values` в открытом или зашифрованном виде (сохраняется только `{ redacted: true }`).
    2. При перезаписи просроченного `PENDING` метода (`status: 'PENDING'` -> `'PENDING'`, новый `secret`) хеш `auditPayloadHash(secret)` изменится, поэтому `changedFields` будет содержать `['secret']` и `CrmAuditTransactionContext` запишет валидное событие `twoFactorAuthenticationMethod:update`.
    3. Совместимость с `membership-cleanup-audit.ts` полностью сохраняется, так как `membership-cleanup-audit.ts` вырезает `'secret'` через `to_jsonb(r) - $1::text[]`, а `capture()` в `crm-audit-transaction-context.ts` пропускает отсутствующие ключи (`!Object.hasOwn(input, field)`).
- В `ADMINISTRATIVE_ACTIONS`:
  - `twoFactorAuthenticationMethod: ['create', 'update', 'delete']`.

### 3.2. Новый модуль `two-factor-authentication-audit.ts`
Создаётся `packages/twenty-server/src/engine/core-modules/crm-audit/two-factor-authentication-audit.ts`:
- Регистрируется в `registerMetadataAuditScopeCheck(getTwoFactorAuthenticationAudit)` для предотвращения вложенных конфликтующих транзакций.
- `captureTwoFactorAuthenticationAudit(workspaceId, identity, options?)`:
  - Синхронно (до первого `await`) захватывает и валидирует `workspaceId`, `actor` (`{ kind: 'coreUser', id: userId }` или из `RoleUpdateAuditIdentity` / `MembershipCleanupIdentity` / ambient ALS), `expectedUserId` и `expectedUserWorkspaceId`, запрещая мутацию без аутентифицированного субъекта.
- `runAuditedTwoFactorProvisioning(dataSource, request, input)`:
  - Внутри `runInCoreAuditTransaction` устанавливает `SET LOCAL lock_timeout = '8s'`, берёт `acquireUserAuthenticationLock(userId, 'exclusive')`, блокирует `core.workspace` (`FOR NO KEY UPDATE`), `core."userWorkspace"` (`FOR NO KEY UPDATE`, проверяя принадлежность `workspaceId`, `userId` и `deletedAt IS NULL`) и существующую строку `core."twoFactorAuthenticationMethod"` по `("userWorkspaceId", "strategy")` (`FOR UPDATE`, без фильтра по `workspaceId` в SQL с последующей fail-closed проверкой `row.workspaceId === workspaceId`).
  - Проверяет внутри транзакции отсутствие активной резервации recovery-enrollment (`AppTokenType.TwoFactorAuthenticationRecoveryCode` с `deletedAt IS NOT NULL AND revokedAt IS NULL AND createdAt >= userWorkspace.createdAt`), закрывая гонку между `assertEnrollmentNotReservedForRecoveryOrThrow` и записью метода.
  - Если метод существует и `status !== 'PENDING'` - выбрасывает `TWO_FACTOR_AUTHENTICATION_METHOD_ALREADY_PROVISIONED`.
  - Если метод существует, `status === 'PENDING'` и `now - createdAt < PENDING_METHOD_REUSE_WINDOW_MS` - возвращает `{ reused: true, existingSecret: existing.secret }` без записи в БД и без `audit.flush()`.
  - Иначе вставляет новую строку или обновляет существующую `PENDING` строку новым `encryptedSecret` (с монотонным продвижением `updatedAt` и проверкой `secret !== existing.secret`), записывает `twoFactorAuthenticationMethod:create` или `twoFactorAuthenticationMethod:update`, вызывает `audit.flush()` и повторно сверяет сохранённое состояние строки после `audit.flush()`.
- `runAuditedTwoFactorValidation(dataSource, request, input)`:
  - Внутри `runInCoreAuditTransaction` устанавливает `SET LOCAL lock_timeout = '8s'`, берёт `acquireUserAuthenticationLock(userId, 'exclusive')`, блокирует `core.workspace` (`FOR NO KEY UPDATE`), `core."userWorkspace"` (`FOR NO KEY UPDATE`) и целевую строку `core."twoFactorAuthenticationMethod"` (`FOR UPDATE` по `id`), проверяя `row.workspaceId === workspaceId`, `row.userWorkspaceId === userWorkspace.id` и `row.secret === expectedSecret` (защита от гонки с `redeemRecoveryCode`).
  - Если `before.status !== 'VERIFIED'`, обновляет `status = 'VERIFIED'`, записывает `twoFactorAuthenticationMethod:update` (`changedFields: ['status']`), отзывает коды восстановления (`revokeRecoveryCodes` внутри той же транзакции), вызывает `audit.flush()` и сверяет снимок после `audit.flush()`.
  - Если `before.status === 'VERIFIED'`, не делает лишнего `UPDATE` метода и не пишет шумовой аудит, но выполняет отзыв кодов восстановления в той же транзакции и повторно сверяет неизменность строки метода.
- `runAuditedTwoFactorDeletion(dataSource, request, input)`:
  - Внутри `runInCoreAuditTransaction` устанавливает `SET LOCAL lock_timeout = '8s'`, берёт `acquireUserAuthenticationLock(userId, 'exclusive')`, блокирует `core.workspace` (`FOR NO KEY UPDATE`), целевую строку `core."twoFactorAuthenticationMethod"` по `id` (`FOR UPDATE`) и её `core."userWorkspace"` (`FOR NO KEY UPDATE`).
  - Проверяет существование метода в `workspaceId` (иначе `AuthException(INVALID_INPUT)`), совпадение `userWorkspace.workspaceId === workspaceId` и владение `userWorkspace.userId === userId` (иначе `AuthException(FORBIDDEN_EXCEPTION)`).
  - Удаляет строку, проверяет отсутствие строки в БД, записывает `twoFactorAuthenticationMethod:delete`, вызывает `audit.flush()` и повторно проверяет отсутствие строки после `audit.flush()`.
- `runAuditedTwoFactorRecoveryRedemption(dataSource, request, input)`:
  - Внутри `runInCoreAuditTransaction` устанавливает `SET LOCAL lock_timeout = '8s'`, берёт `acquireUserAuthenticationLock(userId, 'exclusive')`, блокирует `core.workspace` (`FOR NO KEY UPDATE`) и `core."userWorkspace"` (`FOR NO KEY UPDATE`, проверяя `workspaceId`, `userId` и `deletedAt IS NULL`).
  - Блокирует и погашает подходящий `AppTokenType.TwoFactorAuthenticationRecoveryCode` (`FOR UPDATE`); если код не найден/истёк/уже использован - возвращает `null` без побочных эффектов.
  - Блокирует все строки `core."twoFactorAuthenticationMethod"` для `userWorkspaceId` (`ORDER BY id FOR UPDATE`), проверяя `row.workspaceId === workspaceId`, удаляет их и записывает `twoFactorAuthenticationMethod:delete` для каждой строки.
  - Блокирует все неистёкшие `AppTokenType.RefreshToken` для `(userId, workspaceId)` (`ORDER BY id FOR UPDATE`), обновляет `revokedAt = COALESCE("revokedAt", $now)` и `context.revokedReason = 'two_factor_authentication_reset'`, и для каждого токена, у которого изменился `revokedAt` или `revokedReason`, записывает `refreshToken:update` (`tokenOwner: { userId, access: 'currentWorkspaceAdministration' }`).
  - Если `workspace.isTwoFactorAuthenticationEnforced === true`, вставляет новый `PENDING` метод (`twoFactorAuthenticationMethod:create`) и проверяет его снимок.
  - Вызывает `audit.flush()` и повторно сверяет отсутствие старых методов, наличие нового метода (если enforced) и состояние всех затронутых refresh-токенов.

### 3.3. Обработка `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError`
- В `TwoFactorAuthenticationRecoveryService.redeemRecoveryCode`:
  - Если `runAuditedTwoFactorRecoveryRedemption` выбрасывает `NativeTransactionOutcomeUnknownError` или `CoreAuditPostCommitError`, транзакция в БД уже могла закоммититься (код погашен, старый 2FA-метод удалён). Поэтому перед повторным пробросом ошибки вызывается `userSessionService.revokeAllSessionsForUser` (в `try / catch`, чтобы не потерять ошибку аудита), а отправка письма о сбросе и возврат `provisioningUri` / выдача новых токенов в `AuthResolver.getAuthTokensFromTwoFactorAuthenticationRecoveryCode` блокируются.
- В `TwoFactorAuthenticationService.initiateStrategyConfiguration`, `validateStrategy`, `deleteTwoFactorAuthenticationMethod`:
  - Ошибки `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` пробрасываются без маскирования.
