# LOG171 - Design: Transactional Password Update Audit, Bulk Refresh Token Security Revocation, and Auth Fencing

## 1. Context and Problem

Before `LOG171`, `AuthService.updatePassword` (`packages/twenty-server/src/engine/core-modules/auth/services/auth.service.ts`) had four security and audit gaps:

1. **Non-transactional password and token updates**: `userRepository.update(userId, { passwordHash })` and `appTokenRepository.update({ userId, type: AppTokenType.RefreshToken, revokedAt: IsNull() }, { revokedAt: new Date() })` ran in separate autocommit queries without `runInCoreAuditTransaction`, without `acquireUserAuthenticationLock`, without checking `core."user"."deletedAt" IS NULL`, without verifying persisted post-update state, and without invalidating `CoreEntityCacheService` (`user`).
2. **Grace-period refresh renewal bypass after password change**: `appTokenRepository.update` only matched `revokedAt: IsNull()` and only set `{ revokedAt: new Date() }` without setting `context.revokedReason = UserSessionRevokedReason.PasswordChanged`. Because `isRevokedRefreshTokenStillRenewable` allows any token with `revokedReason === undefined` inside `REFRESH_TOKEN_REUSE_GRACE_PERIOD`, both newly revoked tokens and recently rotated tokens remained renewable via `RefreshTokenService.verifyRefreshToken` and `RefreshTokenService.rotateRefreshToken` after password change.
3. **Missing `refreshToken` `update` audit entries**: Workspace-scoped refresh tokens (`workspaceId IS NOT NULL`) revoked by `AuthService.updatePassword` recorded no `refreshToken` `update` entries in `crm_audit."crmAuditEntry"`.
4. **Reset token race and standalone auth fencing**: `AuthResolver.updatePasswordViaResetToken` validated `passwordResetToken`, updated the password, and invalidated reset tokens in three separate steps without locking the presented `PASSWORD_RESET_TOKEN` row inside the password-update transaction; `RefreshTokenService.generateRefreshToken` and `UserSessionService` session creation/revocation did not acquire `acquireUserAuthenticationLock`; and `UserSessionResolver` (`revokeUserSession`, `revokeAllOtherUserSessions`) did not forward `initiatorMembershipId` when revoking sessions under impersonation.

## 2. Design Options Considered

### Option A (Selected): Dedicated `password-update-audit.ts` Core Transaction Owner + Shared Auth Fencing
- Create `packages/twenty-server/src/engine/core-modules/crm-audit/password-update-audit.ts` with `capturePasswordUpdateAudit` and `runAuditedPasswordUpdate`.
- Hash the validated password before entering the DB transaction so `bcrypt` never holds PostgreSQL locks.
- Inside `runInCoreAuditTransaction`:
  - Acquire `acquireUserAuthenticationLock({ entityManager: runner.manager, userId, mode: 'exclusive' })`.
  - If `passwordResetTokenHash` is supplied (from `updatePasswordViaResetToken`), lock the matching `PASSWORD_RESET_TOKEN` row `FOR UPDATE` and verify `deletedAt IS NULL`, `revokedAt IS NULL`, `expiresAt > now`, and `userId === targetUserId`.
  - Lock `core."user"` `FOR UPDATE`, verify `deletedAt IS NULL`, and lock active `core."userWorkspace"` joined with active `core.workspace` `FOR KEY SHARE` to confirm at least one active workspace membership exists.
  - Update `core."user"."passwordHash"` with `WHERE id = $1 AND "deletedAt" IS NULL` and verify the complete post-update snapshot.
  - Lock and revoke all unrevoked `PASSWORD_RESET_TOKEN` rows for `userId`.
  - Lock all `REFRESH_TOKEN` rows for `userId` `ORDER BY id FOR UPDATE` (including rows with `deletedAt IS NOT NULL`, since `RefreshTokenService` does not filter by `deletedAt`). For every row where `revokedAt IS NULL` or `context.revokedReason IS NULL`, set `revokedAt = COALESCE("revokedAt", $now)` and `context = COALESCE(context, '{}'::jsonb) || jsonb_build_object('revokedReason', 'PASSWORD_CHANGED')`. Rows that already have both `revokedAt` and a non-null `context.revokedReason` preserve their original timestamp and reason untouched.
  - For every workspace-scoped refresh token (`workspaceId IS NOT NULL` on an active `core.workspace`) whose `revokedAt` or `revokedReason` changed, record a `refreshToken` `update` entry in `CrmAuditTransactionContext` with `tokenOwner: { userId, access: 'currentWorkspaceAdministration' }`, and flush all workspace contexts before commit. Workspace-agnostic tokens (`workspaceId IS NULL`) are revoked and verified without inventing a tenant audit row.
  - Re-verify `core."user"`, `REFRESH_TOKEN`, and `PASSWORD_RESET_TOKEN` post-conditions after `audit.flush()`.
- In `AuthService.updatePassword`:
  - Always invalidate `coreEntityCacheService.invalidate('user', userId)` in `finally` (logging cache errors without masking the transaction result).
  - On `NativeTransactionOutcomeUnknownError` or `CoreAuditPostCommitError`, best-effort revoke user sessions via `userSessionService.revokeAllSessionsForUser` before rethrowing, and suppress post-commit notification email.
- Acquire `acquireUserAuthenticationLock` (`mode: 'shared'` in `RefreshTokenService.generateRefreshToken` and `UserSessionService.saveAuditedWorkspaceSession`; `mode: 'exclusive'` in `UserSessionService.revokeSessionsWithAudit`) and propagate `initiatorMembershipId` in `UserSessionResolver` and `UserSessionService` (`revokeSessionByIdForUserWorkspace`, `revokeAllSessionsForUser`).

### Option B: Inline Transaction in `AuthService.updatePassword` Without Reset-Token Locking or Shared Auth Fencing
- Rejected because concurrent `updatePasswordViaResetToken` requests could race between token validation and invalidation, and concurrent `generateRefreshToken` / `createSession` calls would not serialize against exclusive security revocations.

## 3. Blast Radius and Enterprise Boundary

- `password-update-audit.ts` imports only leaf auth/audit modules and TypeORM primitives, adding `0` new Enterprise dependency edges.
- Existing signatures of `AuthService.updatePassword`, `ResetPasswordService`, `RefreshTokenService`, `UserSessionService`, and `UserSessionResolver` remain backward-compatible for all existing callers and unit tests.
