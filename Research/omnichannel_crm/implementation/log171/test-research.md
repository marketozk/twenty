# LOG171 - Test Research and Verification Strategy

## Target PostgreSQL Integration Suite
File: `packages/twenty-server/test/fork-migration/crm-audit-password-update.postgres-spec.ts`

## Planned PostgreSQL Test Cases
1. **Atomic password update and multi-workspace refresh token security revocation**:
   - Verifies `AuthService.updatePassword` updates `core."user"."passwordHash"`, revokes active and grace-period rotated `REFRESH_TOKEN` rows across multiple workspaces with `context.revokedReason = 'PASSWORD_CHANGED'` (preserving original `revokedAt` on grace-rotated tokens and preserving original `revokedAt`/`revokedReason` on already security-revoked tokens, including rows with `deletedAt IS NOT NULL`), revokes workspace-agnostic refresh tokens without inventing tenant audit rows, records exact `refreshToken` `update` audit entries without leaking secrets (`passwordHash`, token `value`, `email`), revokes user sessions with `PASSWORD_CHANGED`, invalidates `CoreEntityCacheService` (`user`), and sends the notification email only after commit.
2. **Immediate block of grace-period refresh token renewal after password update**:
   - Rotates a refresh token via `RenewTokenService.generateTokensFromRefreshToken`, then runs `AuthService.updatePassword` inside the grace window and verifies that both the old rotated token and the newly rotated successor token are rejected by `RefreshTokenService.verifyRefreshToken` and `RenewTokenService.generateTokensFromRefreshToken`.
3. **Atomic reset-token consumption in `AuthResolver.updatePasswordViaResetToken`**:
   - Verifies `updatePasswordViaResetToken` locks and consumes the presented `PASSWORD_RESET_TOKEN` row atomically with the password update and refresh token audit, and rejects concurrent or repeated reuse of the reset token, expired/revoked reset tokens, or deactivated users.
4. **Concurrent serialization between `updatePassword` and `rotateRefreshToken` / `generateRefreshToken`**:
   - Verifies that under `acquireUserAuthenticationLock`, a concurrent `rotateRefreshToken` or `generateRefreshToken` cannot leave an unrevoked refresh token active after `updatePassword` completes.
5. **Fail-closed rollback on audit failure, trigger corruption, or deactivated/workspace-less user**:
   - Verifies that audit table privilege failure, trigger corruption of `core."user"` or `core."appToken"`, or soft-deleted user / missing active workspace rolls back `passwordHash`, `REFRESH_TOKEN`, and `PASSWORD_RESET_TOKEN` changes, writes zero audit rows, revokes no sessions, and sends no email.
6. **Lost COMMIT acknowledgement (`NativeTransactionOutcomeUnknownError`) and impersonated session revocation initiator**:
   - Verifies that on lost `COMMIT` ACK, `AuthService.updatePassword` throws `NativeTransactionOutcomeUnknownError` without retrying, invalidates the `user` core entity cache in `finally`, best-effort revokes active user sessions, and does not send the notification email; also verifies that `UserSessionResolver.revokeUserSession` and `revokeAllOtherUserSessions` record the impersonator `initiator` in `crm_audit."crmAuditEntry"`.
