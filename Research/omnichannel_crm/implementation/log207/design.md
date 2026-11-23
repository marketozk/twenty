# LOG-207 Design: Session Lifecycle Hardening (Refresh Token Family Revoke, Active Subject/Membership Fencing, Impersonation/Superseded Attribution & Locking)

## 1. Цель и границы
Закрыть оставшиеся проверяемые пробелы строки `Session lifecycle` в `ROB-765` без изменения схемы БД (без новых миграций):

1. **Refresh Token Family Revoke (`RefreshTokenService` + `AppTokenEntity` + `UserSessionRevokedReason`)**:
   - Каждый новый refresh-токен (`generateRefreshToken`) получает идентификатор семейства `familyId = randomUUID()` в `core."appToken".context.familyId`.
   - При штатной ротации (`rotateRefreshToken`) новый токен наследует `familyId = validUuid(before.context?.familyId) ?? before.id.toLowerCase()` (невалидный не-`undefined` `familyId` отклоняется fail-closed); если исходный токен `before` был legacy-токеном без `familyId` и ещё не был отозван (`!before.revokedAt`), при его пометке `revokedAt` ему также записывается `context = { ...before.context, familyId: before.id.toLowerCase() }`.
   - При повторном предъявлении уже ротированного refresh-токена (`revokedAt !== null && revokedReason == null`) **вне** `REFRESH_TOKEN_REUSE_GRACE_PERIOD`, если у токена есть валидный `familyId`, срабатывает обнаружение компрометации цепочки (`RefreshTokenReuseDetected`):
     - в отдельной атомарной `runInCoreAuditTransaction` (`this.assertOwnTransaction()`) под `SET LOCAL lock_timeout = '8s'` и `acquireUserAuthenticationLock(userId, 'exclusive')` блокируются (`ORDER BY id ASC FOR UPDATE`) и отзываются токены этого `userId`:
       ```sql
       WHERE "userId" = $1
         AND type = 'REFRESH_TOKEN'
         AND LOWER(context->>'familyId') = $2
         AND ("revokedAt" IS NULL OR "expiresAt" > $3 OR id = $4)
         AND ("revokedAt" IS NULL OR context->>'revokedReason' IS NULL)
       ORDER BY id ASC
       FOR UPDATE
       ```
     - для активных строк устанавливается `revokedAt = now` и `context.revokedReason = 'REFRESH_TOKEN_REUSE_DETECTED'`; для уже ротированных строк исходный `revokedAt` сохраняется неизменным, но добавляется `context.revokedReason = 'REFRESH_TOKEN_REUSE_DETECTED'` (мгновенно закрывая grace-окно и делая последующие повторы идемпотентными без повторного аудита);
     - аудит группируется по `row.workspaceId` в `Map<string, CrmAuditTransactionContext>` под единым `operationId` и защитой `SAVEPOINT refresh_family_revocation_audit` (чтобы отзыв семейства пережил недоступность журнала, с `REFRESH_FAMILY_REVOCATION_AUDIT_UNAVAILABLE` в `Logger` `RefreshTokenService`), записывая `refreshToken:update` (`revokedAt`, `revokedReason: 'REFRESH_TOKEN_REUSE_DETECTED'`);
     - до и после `SAVEPOINT` выполняется `validateSnapshot` по всем обновлённым строкам;
     - после коммита отзыва семейства выбрасывается штатное `AuthException('This refresh token has been revoked.', AuthExceptionCode.FORBIDDEN_EXCEPTION)`.
   - В `verifyRefreshToken` до replay detection проверяются `isUUID(jwtPayload.jti)`, `isUUID(jwtPayload.sub)`, `token.type === AppTokenType.RefreshToken` и `token.userId?.toLowerCase() === jwtPayload.sub.toLowerCase()`. Проверка `if (token.revokedAt)` (и запуск `revokeRefreshTokenFamilyOnReuse` при replay вне grace-окна) выполняется **до** `userRepository.findOneBy({ id: jwtPayload.sub })`, чтобы replay украденного токена деактивированного пользователя тоже отзывал скомпрометированную семью.
   - Тот же replay detection выполняется в `rotateRefreshToken` (на случай пересечения границы grace-окна между `verifyRefreshToken` и захватом блокировки в `rotateRefreshToken`).
   - Для legacy-токенов без `familyId`, а также для уже отозванных по security-причине (`revokedReason != null`), семейный отзыв не запускается. (Для legacy-токена без `familyId`, уже находившегося в 1-минутном grace-окне в момент выката, `before` при grace-повторе не изменяется ради обратной совместимости; все вновь выданные наследники уже несут `familyId`.)

2. **Транзакционный active subject & membership fence при выпуске/ротации (`concurrent-sign-in` / `in-flight` deactivation, workspace deletion & membership-removal fencing)**:
   - Единый канонический порядок строковых блокировок внутри транзакций под `acquireUserAuthenticationLock(userId, 'shared')`:
     **`core.workspace` (`FOR KEY SHARE`) -> `core."user"` (`FOR SHARE`) -> `core."userWorkspace"` (`ORDER BY id FOR SHARE`) -> `core."appToken"` / `core."userSession"` (`FOR UPDATE`)**.
     - `FOR KEY SHARE` на `core.workspace` сериализуется с `admitOmniWorkspaceDeletion` (`FOR UPDATE`) и `DELETE`, но не конфликтует с 70+ транзакциями `FOR NO KEY UPDATE` на `core.workspace` (импорт, роли, домены, контакты, 2FA).
     - `FOR SHARE` на `core."user"` (проверяется `AND "deletedAt" IS NULL AND COALESCE((to_jsonb(u)->>'disabled')::boolean, false) = false`) и `core."userWorkspace"` (`AND "deletedAt" IS NULL`) сериализуется с `deactivateCoreUserWithAudit` и `deleteUserWorkspaceTransaction` (`FOR UPDATE`).
     - Порядок `W -> U -> UW -> AT` согласован с `ON DELETE CASCADE` и `create-company-and-contact.service.ts` (исключает 2-way deadlock).
   - В `RefreshTokenService.generateRefreshToken` и `rotateRefreshToken`:
     - в `capturePayload` валидируются (`isUUID`) и нормализуются в lowercase `userId`, `workspaceId`, `impersonatorUserWorkspaceId` и `impersonatedUserWorkspaceId`;
     - `lockAndCheckActiveSubject(runner, payload)` блокирует `core.workspace` (`FOR KEY SHARE`), `core."user"` (`FOR SHARE`), и (в одном `ORDER BY id FOR SHARE`) целевой `userWorkspace` + `impersonatorUserWorkspaceId` (если задан), возвращая статус активности и резолвленный `initiator`;
     - в `rotateRefreshToken` ошибка неактивного субъекта сохраняется без немедленного `throw` до чтения и проверки `before` (`AT FOR UPDATE`), чтобы `revoked`/replay всегда срабатывали первыми (сохраняя совместимость с `crm-audit-refresh-logout.postgres-spec.ts:478-503` и с `verifyRefreshToken`), и выбрасывается перед мутацией `before` / выпуском нового токена;
     - если `impersonatorUserWorkspaceId` задан и не найден активным -> `throw new Error('Refresh issuance initiator unavailable')`.
   - В `UserSessionService.saveWorkspaceAgnosticSession` (с проверкой `isUUID(candidate.userId)`) и `saveAuditedWorkspaceSession`:
     - под `acquireUserAuthenticationLock(userId, 'shared')` проверяются `core.workspace` (`FOR KEY SHARE`, для workspace-сессии) -> `core."user"` (`FOR SHARE`, `deletedAt IS NULL` и не `disabled`) -> `core."userWorkspace"` (`ORDER BY id FOR SHARE`).

3. **Исправление блокировки и атрибуции в `UserSessionService` и `ImpersonationService.stopImpersonation` + сквозной `correlationId`**:
   - **Исправление `acquireUserAuthenticationLock` при отзыве конкретной сессии**: в `UserSessionService.revokeSessionsWithAudit` добавлен явный `lockUserId?: string`; `lockedUserId = (input.lockUserId ?? input.userId ?? input.actingUserId).toLowerCase()` валидируется (`isUUID`) до транзакции (не пропускает блокировку молча), `revokeSessionEntity` всегда передаёт `lockUserId: session.userId`, а при `isDefined(input.sessionId)` после `FOR UPDATE` проверяется `before.every((row) => row.userId.toLowerCase() === lockedUserId)`.
   - **Исправление атрибуции и fail-closed проверка `ImpersonationService.stopImpersonation`**:
     - `UserSessionService.revokeSessionByToken` получает 4-й опциональный параметр `options?: { initiatorMembershipId?: string; correlationId?: string; expectedWorkspaceId?: string; expectedImpersonatedUserWorkspaceId?: string }` с сохранением прежнего fallback для `UserSignOut`.
     - В `ImpersonationService.stopImpersonation` явно проверяется `isNonEmptyString(impersonationContext.impersonatorUserWorkspaceId)` до `findOne`, после чего вызывается `revokeSessionByToken(presentedSessionToken, UserSessionRevokedReason.ImpersonationEnded, undefined, { initiatorMembershipId: impersonatorUserWorkspace.id, expectedWorkspaceId: workspaceId, expectedImpersonatedUserWorkspaceId: impersonationContext.impersonatedUserWorkspaceId })`.
     - При `reason === UserSessionRevokedReason.ImpersonationEnded` в `revokeSessionByToken` и внутри транзакции `revokeSessionsWithAudit` безусловно проверяется: `isDefined(initiatorMembershipId)`, `row.isImpersonating === true`, `row.impersonatorUserWorkspaceId?.toLowerCase() === initiatorMembershipId.toLowerCase()`, совпадение `expectedWorkspaceId` и `expectedImpersonatedUserWorkspaceId` (если переданы); при несоответствии - fail-closed `AuthException('Session does not match active impersonation', AuthExceptionCode.FORBIDDEN_EXCEPTION)`.
   - **Валидация `correlationId` до транзакции и `SAVEPOINT`**: `correlationId` валидируется (`typeof === 'string' && length > 0 && length <= 256`) до входа в транзакцию и `SAVEPOINT` во всех методах `UserSessionService`.
   - **Единый `correlationId` для парных операций**:
     - `issueSessionForTokenPair`: общий `correlationId = randomUUID()` связывает `userSession:create` и `userSession:update (Superseded)`.
     - `signOut`: общий `correlationId = randomUUID()` связывает `userSession:update (UserSignOut)` и `refreshToken:update (UserSignOut)`.

Вне границ `LOG-207`:
- связь `UserSessionEntity` с `familyId`: таблица `core."userSession"` не имеет колонки `familyId`, поэтому `revokeRefreshTokenFamilyOnReuse` отзывает всю цепочку `REFRESH_TOKEN` в `core."appToken"`, но не отзывает браузерные `UserSession` cookies;
- `signOut({ refreshToken })` по-прежнему отзывает только предъявленный refresh-токен (не всю семью, закреплено в `crm-audit-refresh-logout.postgres-spec.ts:914-947`);
- stateless application JWT (`ApplicationTokenService`);
- `UserSessionCleanupCronJob` (retention-purge завершённых записей);
- post-rollback denied/failed audit;
- HTTP/JWT приёмка и выкат.

## 2. Проверка Enterprise-границ
- Ни один из изменяемых файлов не добавляет новых импортов в Enterprise-достижимые модули; проверяется `check_enterprise_dependencies.py --verify-baseline`.

## 3. Изменяемые и новые файлы
1. `packages/twenty-server/src/engine/core-modules/user-session/types/user-session-revoked-reason.type.ts`
2. `packages/twenty-server/src/engine/core-modules/app-token/app-token.entity.ts`
3. `packages/twenty-server/src/engine/core-modules/auth/token/services/refresh-token.service.ts`
4. `packages/twenty-server/src/engine/core-modules/user-session/services/user-session.service.ts`
5. `packages/twenty-server/src/engine/core-modules/impersonation/services/impersonation.service.ts`
6. `packages/twenty-server/test/fork-migration/crm-audit-refresh-logout.postgres-spec.ts` (`deletedAt`, `GRANT UPDATE`, `userWorkspace` seed)
7. `packages/twenty-server/test/fork-migration/crm-audit-user-session.postgres-spec.ts` (`deletedAt`, `GRANT UPDATE`)
8. `packages/twenty-server/test/fork-migration/crm-audit-password-update.postgres-spec.ts` (`GRANT UPDATE ON core.workspace`)
9. `packages/twenty-server/test/fork-migration/crm-audit-session-lifecycle-hardening.postgres-spec.ts` (новый)
