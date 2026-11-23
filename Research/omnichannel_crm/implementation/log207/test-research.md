# LOG-207 Test Research

## 1. Целевые сценарии нового PG 17 теста (`crm-audit-session-lifecycle-hardening.postgres-spec.ts`)
Выполняется на реальном PostgreSQL 17 с ограниченной ролью (`NOSUPERUSER`, с `GRANT UPDATE` на `core."user"`, `core.workspace`, `core."userWorkspace"`, `core."appToken"`, `core."userSession"`), `OmniAuditBootstrapFastInstanceCommand`, реальными `RefreshTokenService`, `RenewTokenService`, `UserSessionService`, `ImpersonationService` и криптографическим JWT:

1. **Refresh Token Family Revoke (обнаружение replay вне grace-окна)**:
   - `generateRefreshToken` выдаёт `T1` с `context.familyId = F`; ротация `T1 -> T2 -> T3` сохраняет `familyId = F`; параллельно выдаётся независимая сессия `U1` (`familyId = F2`), а также исторический истёкший ротированный токен `T0` (`expiresAt < now`, `revokedAt < now`, `familyId = F`).
   - При повторном предъявлении `T1` вне grace-окна (через `RenewTokenService.generateTokensFromRefreshToken` и напрямую через `rotateRefreshToken`):
     - вызов отклоняется `AuthException` (`revoked`);
     - `T1`, `T2`, `T3` получают `context.revokedReason = 'REFRESH_TOKEN_REUSE_DETECTED'`, у активного `T3` выставляется `revokedAt`, у ротированных `T1`/`T2` сохраняются исходные `revokedAt`, исторический истёкший `T0` НЕ раздувает блокировки и аудит, а независимая семья `F2` (`U1`) остаётся активной;
     - все `crmAuditEntry` для отзыва семьи `F` имеют единый `operationId`, `action: 'update'`, `revokedReason: 'REFRESH_TOKEN_REUSE_DETECTED'`, не содержат `familyId`/JWT/`email`;
     - повторное предъявление `T1` или `T3` отклоняется идемпотентно без новых записей в `crmAuditEntry`;
     - replay украденного токена деактивированного пользователя (`core."user"."deletedAt" IS NOT NULL`) всё равно отзывает скомпрометированную семью `F`;
     - при отказе вставки в `crm_audit."crmAuditEntry"` отзыв семейства коммитится через `SAVEPOINT refresh_family_revocation_audit` с логом `REFRESH_FAMILY_REVOCATION_AUDIT_UNAVAILABLE`;
     - legacy-токен без `familyId` при ротации получает `familyId = legacy.id`, и последующий replay отзывает наследника;
     - конкурентный replay двух запросов не приводит к deadlock и отзывает семью ровно один раз.
2. **Active Subject & Membership Fencing (реальный row-level `FOR UPDATE` + `disabled` + `deletedAt`)**:
   - Деактивированный пользователь (`deletedAt IS NOT NULL` или `disabled = true`), удалённый воркспейс (`deletedAt IS NOT NULL`) или удалённое членство (`userWorkspace."deletedAt" IS NOT NULL`):
     - `generateRefreshToken`, `rotateRefreshToken`, `createSession` (workspace и workspace-agnostic) отказывают без создания токенов/сессий и без `crmAuditEntry`.
   - Реальная сериализация через **строковый `FOR UPDATE` БЕЗ `acquireUserAuthenticationLock`** (точно как в `deactivateCoreUserWithAudit`, `deleteUserWorkspaceTransaction`, `admitOmniWorkspaceDeletion`): конкурентная транзакция держит `FOR UPDATE` на `core."user"`, `core."userWorkspace"` и `core.workspace`, ставит `deletedAt = now()` и коммитится -> ожидавшие `generateRefreshToken`, `rotateRefreshToken` и `createSession` после разблокировки видят `deletedAt` и отказывают.
3. **Атрибуция, fail-closed проверки и `lockUserId` в `ImpersonationService.stopImpersonation`, `Superseded` и сквозной `correlationId`**:
   - `ImpersonationService.stopImpersonation`: отзывает имперсонированную сессию с `reason = ImpersonationEnded`, блокирует `targetUserId` (проверяем конкурентным `acquireUserAuthenticationLock(targetUserId, 'exclusive')`), и пишет в `crmAuditEntry` `actor = targetUserId`, `initiator = impersonatorUserId`;
   - `stopImpersonation` при предъявлении обычной (не-имперсонационной) сессии или сессии другого имперсонатора отказывает fail-closed (`AuthException`, `FORBIDDEN_EXCEPTION`) и не отзывает сессию;
   - `issueSessionForTokenPair` при перелогине пользователя B поверх сессии пользователя A: `revokeSessionByToken(..., Superseded, B)` берёт `acquireUserAuthenticationLock` на `userA` (проверяем конкурентной блокировкой на `userA`!) и связывает `userSession:create` и `userSession:update (Superseded)` единым `correlationId`;
   - `signOut({ sessionToken, refreshToken })`: связывает `userSession:update (UserSignOut)` и `refreshToken:update (UserSignOut)` единым `correlationId`; невалидный `correlationId` отклоняется до транзакции и `SAVEPOINT`.

## 2. Существующие PG-тесты для совместного целевого прогона
1. `test/fork-migration/crm-audit-session-lifecycle-hardening.postgres-spec.ts` (новый)
2. `test/fork-migration/crm-audit-refresh-logout.postgres-spec.ts` (обновлённый)
3. `test/fork-migration/crm-audit-user-session.postgres-spec.ts` (обновлённый)
4. `test/fork-migration/crm-audit-password-update.postgres-spec.ts` (обновлённый)
5. `test/fork-migration/crm-audit-two-factor-authentication.postgres-spec.ts`
6. `test/fork-migration/crm-audit-membership-auth.postgres-spec.ts`

## 3. Гварды, дифференциальный typecheck и полная регрессия
- `check_enterprise_dependencies.py --verify-baseline` (`0` нарушений)
- `check_fork_migration_sources.py` + `33/33` Python unit tests
- Дифференциальный `tsgo --noEmit` против `HEAD` (`0` новых/changed-file/changed-code диагностик)
- Полная PG 17 регрессия на Schrodinger
- SHA-256 сверка и очистка стенда
