# LOG171 - Design Review

## Verdict
`pass`

## Checklist Review

1. **Architecture alignment**: Uses `runInCoreAuditTransaction`, `acquireUserAuthenticationLock`, and `CrmAuditTransactionContext` with the existing `refreshToken` catalog (`values: ['revokedReason']`, `redacted: ['revokedAt', 'expiresAt', 'createdAt']`) and `tokenOwner: { userId, access: 'currentWorkspaceAdministration' }` contract established in `LOG109`, `LOG110`, and `LOG168`.
2. **Failure paths and concurrency**:
   - Password hashing (`hashPassword`) runs before opening the database transaction so CPU work never holds row or advisory locks.
   - Exclusive `acquireUserAuthenticationLock` serializes `updatePassword` against `RefreshTokenService.generateRefreshToken` (`shared`), `RefreshTokenService.rotateRefreshToken` (`shared`), `UserSessionService.saveAuditedWorkspaceSession` (`shared`), and `UserSessionService.revokeSessionsWithAudit` (`exclusive`).
   - Both active refresh tokens (`revokedAt IS NULL`) and recently rotated grace-period refresh tokens (`revokedAt IS NOT NULL` and `context.revokedReason IS NULL`) receive `context.revokedReason = 'PASSWORD_CHANGED'`, while already security-revoked tokens (`revokedAt IS NOT NULL` and `context.revokedReason IS NOT NULL`) preserve their original `revokedAt` and `revokedReason`.
   - `AppTokenEntity.deletedAt` is not used to skip `REFRESH_TOKEN` rows because `RefreshTokenService` does not filter by `deletedAt`.
   - On `NativeTransactionOutcomeUnknownError` or `CoreAuditPostCommitError`, `CoreEntityCacheService.invalidate('user', userId)` runs in `finally`, `revokeAllSessionsForUser` runs best-effort, and post-commit email delivery is suppressed.
3. **Security and privacy**:
   - No password plaintext, `passwordHash`, reset token value, refresh token value, or unrelated `context` fields (`email`, etc.) are written to `crm_audit."crmAuditEntry"`.
   - Impersonation `initiatorMembershipId` is forwarded from `UserSessionResolver` through `UserSessionService.revokeSessionByIdForUserWorkspace` and `revokeAllSessionsForUser`.
4. **Enterprise dependency boundary**:
   - `password-update-audit.ts` does not import `WorkspaceEntity` or `workspaceAuthContextStorage`.
