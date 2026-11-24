# LOG-211: Independent Code Review

## Verdict
`pass` (0 blockers; all 6 major and 3 minor findings fixed and covered by PG 17 regression assertions)

## Findings and fixes

| # | Severity | Finding | Fix applied |
|---|---|---|---|
| 1 | major | `hasExplicitNavigationPrincipal` treated `null` fields (`user: null`, `apiKey: null`, `application: null`) and empty `impersonationContext: {}` as explicit principals, breaking `authUserWorkspaceId` / `ambient` / `defaultSystemActorId` fallbacks | Tightened `hasExplicitNavigationPrincipal` to require non-null principal fields and `impersonationContext?.impersonatorUserWorkspaceId !== undefined`. |
| 2 | major | Unconditional `captureCurrentCrmAuditOperation` crashed system-actor bindings inside impersonated or unauthenticated `withCrmAuditRequest` scopes | Loaded `ambient` lazily; `MembershipCleanupIdentity` with `actor.kind === 'system'` uses `captureCurrentCrmAuditTrace` without impersonation rejection, and `defaultSystemActorId` fallback catches `'Membership audit authentication is unavailable'` while still failing closed on workspace mismatch. |
| 3 | major | `withNativeCrmAuditTransaction` and `recordPostRollbackNativeCrmAuditAttempt` did not verify that a `workspaceMember` principal belonged to `pendingAuthUserWorkspaceId`'s `userId` | Added `"workspace_<base36>"."workspaceMember"` lookup verifying `userId === resolvedUserId && deletedAt IS NULL` in both `withNativeCrmAuditTransaction` and `recordPostRollbackNativeCrmAuditAttempt`. |
| 4 | major | `MembershipCleanupIdentity` dropped `ambient.operation.initiator` when `cleanupOp.initiator` was `undefined` and allowed unverified `cleanupOp.initiator` when `ambient.operation.initiator` was `undefined` | Inherited `ambient.operation.initiator` when `cleanupOp.initiator` is absent and rejected unexpected `cleanupOp.initiator` when `ambient.operation.initiator` is absent (outside impersonation). |
| 5 | major | Cross-workspace `reqLike.workspace.id` was skipped when `hasExplicitNavigationPrincipal(reqLike)` was `false` | Moved `reqLike.workspace.id` check before `if (hasExplicitNavigationPrincipal(reqLike))`. |
| 6 | major | `DashboardDuplicationService` did not forward `impersonatorUserWorkspaceId`, `correlationId`, or `causationId` into `layoutAuditIdentity` | Forwarded `auditBinding.impersonatorUserWorkspaceId`, `auditBinding.operation.correlationId`, and `auditBinding.operation.causationId` into `layoutAuditIdentity` for both `pageLayoutDuplicationService.duplicate` and rollback `pageLayoutService.destroy`. |
| 7 | minor | Trusted `NativeCrmAuditBinding` was not single-use across transactions when a first transaction committed 0 audit entries | Added `consumedNavigationBindings` `WeakSet` in `assertTrustedNativeCrmAuditBinding` (preserving post-rollback attempt recording). |
| 8 | minor | `bindUserOrCoreUser` accepted explicit `impersonatorUserWorkspaceId` inside a non-impersonated ambient request; `reqLike.auth` ignored conflicting sibling principal fields | Rejected explicit `impersonatorUserWorkspaceId` under non-impersonated ambient requests and rejected non-null sibling principal fields alongside `reqLike.auth`. |
| 9 | minor | `DashboardSyncService.updateLinkedDashboardsUpdatedAtByPageLayoutId` did not chunk updates over `QUERY_MAX_RECORDS` (200) | Selected matching dashboard IDs (`withDeleted: true`, ordered by `id`) and updated in chunks of `200` inside the audited transaction. |
