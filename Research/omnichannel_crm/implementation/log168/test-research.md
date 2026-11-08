# План проверок LOG168

## Целевые сценарии PostgreSQL (`crm-audit-two-factor-authentication.postgres-spec.ts`)

1. **Инициализация, переиспользование в окне 1 часа и перезапись просроченного `PENDING` метода (`initiateStrategyConfiguration`)**:
   - Первичный вызов `initiateOTPProvisioning` / `initiateStrategyConfiguration` создаёт строку `core."twoFactorAuthenticationMethod"` (`status = 'PENDING'`, `strategy = 'TOTP'`) и записывает `twoFactorAuthenticationMethod:create` (`actor = { kind: 'coreUser', id: userId }`, `values = { userWorkspaceId, strategy: 'TOTP', status: 'PENDING' }`, `changedFields` включает `'secret'`, но в `values` нет ни открытого секрета, ни `enc:v2:...`).
   - Повторный вызов в пределах 1 часа переиспользует существующий секрет и не создаёт новых записей в `crm_audit."crmAuditEntry"`.
   - Если `createdAt` существующего `PENDING` метода старше 1 часа, вызов генерирует новый секрет, обновляет строку и записывает `twoFactorAuthenticationMethod:update` (`changedFields: ['secret']`) без утечки секрета в `values`.
   - Если метод уже в статусе `'VERIFIED'`, вызов выбрасывает `TWO_FACTOR_AUTHENTICATION_METHOD_ALREADY_PROVISIONED` без записи аудита.

2. **Подтверждение `PENDING` -> `VERIFIED` и повторная проверка `VERIFIED` метода (`validateStrategy`)**:
   - Вызов `validateStrategy` с валидным TOTP-кодом для `PENDING` метода переводит его в `'VERIFIED'`, отзывает коды восстановления и записывает ровно одно событие `twoFactorAuthenticationMethod:update` (`before.status = 'PENDING'`, `after.status = 'VERIFIED'`, `changedFields = ['status']`).
   - Повторный вызов `validateStrategy` для уже `'VERIFIED'` метода (например, при `getAuthTokensFromOTP` или `assertFreshStepUpAuthenticationOrThrow`) проходит успешно, отзывает коды восстановления, но не создаёт лишних записей `twoFactorAuthenticationMethod:update`.
   - Вызов с неверным TOTP-кодом выбрасывает `INVALID_OTP`, оставляет метод в `'PENDING'` и не создаёт записей аудита.

3. **Удаление 2FA-метода пользователем (`deleteTwoFactorAuthenticationMethod`)**:
   - Вызов `deleteTwoFactorAuthenticationMethod` владельцем метода удаляет строку из `core."twoFactorAuthenticationMethod"` и записывает `twoFactorAuthenticationMethod:delete` (`before` содержит `{ userWorkspaceId, strategy: 'TOTP', status: 'VERIFIED' }`, `after: null`, секрет отредактирован).
   - Попытка удаления метода другого пользователя выбрасывает `FORBIDDEN_EXCEPTION`, строка и журнал аудита остаются неизменными.
   - Попытка удаления несуществующего метода выбрасывает `INVALID_INPUT` без записи аудита.

4. **Погашение кода восстановления (`redeemRecoveryCode`) в режимах с необязательной и обязательной 2FA**:
   - При `isTwoFactorAuthenticationEnforced = false`: погашение валидного кода удаляет `twoFactorAuthenticationMethod`, отзывает активные `RefreshToken` пользователя в этом рабочем пространстве и в одной операции (`operationId`) записывает `twoFactorAuthenticationMethod:delete` и `refreshToken:update` (`after.revokedReason = 'two_factor_authentication_reset'`), а затем отзывает пользовательские сессии.
   - При `isTwoFactorAuthenticationEnforced = true`: погашение валидного кода в одной транзакции и с одним `operationId` записывает `twoFactorAuthenticationMethod:delete` (для старого метода), `refreshToken:update` (для затронутых refresh-токенов) и `twoFactorAuthenticationMethod:create` (для нового `PENDING` метода резервной регистрации) и возвращает `provisioningUri`.
   - Mientras резервная регистрация не завершена (`deletedAt IS NOT NULL AND revokedAt IS NULL`), публичный `initiateStrategyConfiguration` блокируется с `RECOVERY_ENROLLMENT_RESTRICTED` внутри транзакции без перезаписи резервного метода.

5. **Fail-closed инварианты (отсутствие аутентификации, кросс-воркспейсные внешние ключи, расхождение `actor`/`userWorkspace`)**:
   - Вызовы аудируемых операций без валидной идентичности или при несовпадении `actor.id` и `userWorkspace.userId` отклоняются до коммита.
   - При кросс-воркспейсном несоответствии `twoFactorAuthenticationMethod.workspaceId !== userWorkspace.workspaceId` транзакция завершается ошибкой и откатывается.

6. **Проброс `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError`**:
   - При возникновении `NativeTransactionOutcomeUnknownError` или `CoreAuditPostCommitError` в `initiateStrategyConfiguration`, `validateStrategy`, `deleteTwoFactorAuthenticationMethod` и `redeemRecoveryCode` ошибка не маскируется; в `redeemRecoveryCode` сессии пользователя принудительно отзываются в `try / catch`, а письмо о сбросе и выдача `provisioningUri` подавляются.
