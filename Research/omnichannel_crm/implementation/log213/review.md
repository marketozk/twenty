# LOG-213: Independent Code Review

## Verdict
`pass` (1 Blocker, 3 Major, 3 Minor found and all resolved with real PG 17 regression tests)

## Findings and resolutions

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | blocker | `initiatorMembership.workspaceId !== wsId` rejected server-level impersonation (where impersonator membership belongs to another workspace) inside `SAVEPOINT refresh_revocation_audit`, dropping audit on every server-level impersonation refresh logout | Removed the workspace-equality assertion (matching `saveAuditedWorkspaceSession`, `revokeSessionsWithAudit`, and `RefreshTokenService.revokeRefreshTokenFamilyOnReuse`) and added a server-level impersonation `signOut({ refreshToken })` PG 17 regression test verifying `actor` and `initiator`. |
| 2 | major | Unlocked `presented` read could leave an already-revoked `presented` row unlocked while `snapshotsToValidate` still checked it (risking spurious abort on concurrent cleanup); legacy path did not re-verify invariants on `lockedSingle` | Included `token.id = :tokenId` in the single `ORDER BY token.id ASC FOR UPDATE` lock query, re-verified `workspaceId`, `context` shape, and `familyId` on `lockedPresented` across both family and legacy paths, and validated all locked rows. |
| 3 | major | Concurrent reconcile test barrier fired inside `authorize` before `SELECT ... NOT EXISTS` and did not verify `scannedCount === 1` on both transactions or test `ENQUEUE_POSTCONDITION` | Synchronized both concurrent transactions directly at `INSERT INTO core."omniBindingConfigWakeup"`, asserted `scannedCount === 1` on both, and added a trigger-based test for `OMNI_BINDING_CONFIG_WAKEUP_ENQUEUE_POSTCONDITION`. |
| 4 | major | Coverage/assertion gaps in `crm-audit-session-lifecycle-hardening.postgres-spec.ts` (no server-level impersonation signOut test, undefined `correlationId` possibility, lowercase `'user_sign_out'` literal, missing `spParent`/empty-audit/workspace-agnostic/uppercase-UUID checks) | Added all missing assertions and regression cases, and updated `crm-audit-refresh-logout.postgres-spec.ts:927` for the new successor-revocation contract. |
| 5 | minor | `isImpersonating: true` without `impersonatorUserWorkspaceId` was not rejected pre-SQL; `initiatorMembership` was queried even when `rowsByWorkspace.size === 0` | Rejected `isImpersonating: true` without valid UUID `impersonatorUserWorkspaceId` pre-SQL; gated `initiator` query on `rowsByWorkspace.size > 0`. |
| 6 | minor | Cross-workspace `familyId` revocation scope in `revokePresentedRefreshToken` was not explicitly documented | Added terse comment noting parity with `RefreshTokenService.revokeRefreshTokenFamilyOnReuse`. |
| 7 | minor | `apply-omni-history-receipt.ts:503` comment mentioned `PK/thread races` although `omniConversation` has no unique constraint on `messageThreadId` | Corrected comment to `deterministic PK races`. |
