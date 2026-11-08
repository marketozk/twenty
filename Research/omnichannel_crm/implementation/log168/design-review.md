# Ревью решения LOG168

Дата: 08.11.2026
Задача: ROB-765 (LOG168 - аудит жизненного цикла `twoFactorAuthenticationMethod` и связанных с ним операций восстановления)
Вердикт: pass (замечания M1-M5 и T1-T2 учтены в архитектуре и тестовом плане)

## Замечания ревизии и их закрытие в дизайне

### M1. Редактирование секрета `secret` и обнаружение перезаписи просроченного `PENDING` метода
- **Риск**: при повторном вызове `initiateStrategyConfiguration` для `PENDING` метода старше 1 часа поля `userWorkspaceId`, `strategy = 'TOTP'` и `status = 'PENDING'` не изменяются; меняется только зашифрованный `secret`. Если `secret` не входит в `CATALOG.twoFactorAuthenticationMethod.redacted`, `CrmAuditTransactionContext` увидит пустой `changedFields` и отклонит `twoFactorAuthenticationMethod:update`.
- **Решение**: добавить `'secret'` в `CATALOG.twoFactorAuthenticationMethod.redacted` (`redacted: ['secret', 'deletedAt']`). Тогда `secret` хешируется в `changedFields: ['secret']`, не попадает в `redactedDiff.values` и остаётся совместимым с `membership-cleanup-audit.ts`, который вырезает `'secret'` из `to_jsonb(r)` до `context.record(...)`.

### M2. Атомарная защита резервной регистрации (`assertEnrollmentNotReservedForRecoveryOrThrow`) внутри транзакции `initiateStrategyConfiguration`
- **Риск**: если проверка `isAwaitingRecoveryEnrollment` выполняется только до и после `initiateStrategyConfiguration` вне транзакции, параллельное погашение кода восстановления может создать резервный `PENDING` метод, который `initiateStrategyConfiguration` перезапишет или переиспользует до пост-проверки.
- **Решение**: внутри `runAuditedTwoFactorProvisioning` под `acquireUserAuthenticationLock(userId, 'exclusive')` проверять отсутствие неподтверждённой резервной регистрации (`status !== 'VERIFIED'` + наличие `AppTokenType.TwoFactorAuthenticationRecoveryCode` с `deletedAt IS NOT NULL AND revokedAt IS NULL AND createdAt >= userWorkspace.createdAt`) до чтения/перезаписи `twoFactorAuthenticationMethod`.

### M3. Аудит пакетного отзыва `RefreshToken` при `redeemRecoveryCode`
- **Риск**: `TwoFactorAuthenticationRecoveryService.redeemRecoveryCode` отзывает все неистёкшие `AppTokenType.RefreshToken` пользователя в целевом рабочем пространстве (`revokedAt = COALESCE("revokedAt", now())`, `context.revokedReason = 'two_factor_authentication_reset'`), но ранее делал это массовым `QueryBuilder.update()` без записи событий `refreshToken:update`.
- **Решение**: внутри `runAuditedTwoFactorRecoveryRedemption` блокировать целевые строки `core."appToken"` (`type = 'REFRESH_TOKEN'`, `userId`, `workspaceId`, `expiresAt > now()`) в порядке `ORDER BY id FOR UPDATE`, обновлять их и для каждой строки, у которой изменился `revokedAt` или `context.revokedReason`, записывать `refreshToken:update` с `tokenOwner: { userId, access: 'currentWorkspaceAdministration' }` в том же `CrmAuditTransactionContext` и с тем же `operationId`.

### M4. Разделение `resourceId` при удалении старого метода и создании резервного `PENDING` метода в `redeemRecoveryCode`
- **Риск**: если в одной транзакции (`isTwoFactorAuthenticationEnforced = true`) удалить старый `twoFactorAuthenticationMethod` и вставить новый `PENDING` метод, они имеют разные `id` (`UUID`). В `CrmAuditTransactionContext` агрегация идёт по `(resourceKind, resourceId)`, поэтому старый метод даёт `twoFactorAuthenticationMethod:delete` (`resourceId = oldId`), а новый - `twoFactorAuthenticationMethod:create` (`resourceId = newId`). Необходимо проверить, что новый `id` отличается от всех удалённых `id`.
- **Решение**: явно генерировать `newId = randomUUID()` (гарантируя `!deletedIds.includes(newId)`), записывать `delete` для каждого удалённого метода и `create` для `newId`, а после `audit.flush()` сверять отсутствие `deletedIds` и точное совпадение новой строки `newId`.

### M5. Обработка `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` в `redeemRecoveryCode`
- **Риск**: если `runAuditedTwoFactorRecoveryRedemption` завершается с `NativeTransactionOutcomeUnknownError` или `CoreAuditPostCommitError`, коммит в БД уже мог произойти (старый 2FA-метод удалён, код восстановления погашен), но если просто пробросить ошибку до `revokeAllSessionsForUser`, активные пользовательские сессии останутся открытыми.
- **Решение**: при перехвате `NativeTransactionOutcomeUnknownError` или `CoreAuditPostCommitError` в `redeemRecoveryCode` вызывать `this.userSessionService.revokeAllSessionsForUser` внутри защищённого `try / catch`, после чего пробрасывать исходную ошибку без отправки email и без возврата `provisioningUri` / выдачи новых токенов.

### T1. Отсутствие шумовых событий при проверке уже подтверждённого (`VERIFIED`) метода
- **Решение**: в `runAuditedTwoFactorValidation` записывать `twoFactorAuthenticationMethod:update` и выполнять `UPDATE core."twoFactorAuthenticationMethod" SET status = 'VERIFIED'` только если `before.status !== 'VERIFIED'`. Если `before.status === 'VERIFIED'`, метод остаётся неизменным (проверяется до и после отзыва recovery-кодов), а `audit.flush()` не вызывается.

### T2. Совместимость с существующими unit-тестами `two-factor-authentication.resolver.spec.ts` и `two-factor-authentication-recovery.service.spec.ts`
- **Решение**: внедрять `@Optional() @InjectDataSource()` с fallback на `appTokenRepository?.manager?.connection` или `twoFactorAuthenticationMethodRepository` и сохранять поддержку тестового режима с мок-репозиториями, когда `connection` не предоставлен в unit-тесте (при обязательном наличии `DataSource` во всех реальных PostgreSQL/NestJS окружениях).
