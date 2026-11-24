# LOG-213 Test Research

## Existing test suites covering touched paths
1. `packages/twenty-server/test/fork-migration/crm-audit-refresh-logout.postgres-spec.ts` - PG 17 tests for `UserSessionService.signOut({ refreshToken })`, grace period, rotation, audit rollback, trigger tamper detection.
2. `packages/twenty-server/test/fork-migration/crm-audit-session-lifecycle-hardening.postgres-spec.ts` - PG 17 tests for `RefreshTokenService` family revoke on post-grace reuse, active subject/membership fencing, impersonation stop, and paired `correlationId`.
3. `packages/twenty-server/test/fork-migration/omni-human-text-command.postgres-spec.ts` - PG 17 tests for `admitOmniHumanTextCommand`, including line 623 `fences the global actor/key race across two independently locked Conversations before counters advance`.
4. `packages/twenty-server/test/fork-migration/omni-binding-config-wakeup.postgres-spec.ts` (check exact filename) - PG 17 tests for `enqueueOmniBindingConfigWakeups` and concurrent wakeup enqueue.

## New regression tests to add
1. In `crm-audit-session-lifecycle-hardening.postgres-spec.ts` (or `crm-audit-refresh-logout.postgres-spec.ts`):
   - `signOut({ refreshToken })` with a pre-rotation parent token revokes BOTH the parent (stamping `revokedReason: UserSignOut`) AND all active rotated child/sibling tokens in the same `familyId`, auditing all workspace-scoped rows under one `operationId` + `correlationId`, while leaving unrelated families untouched and remaining idempotent on repeated `signOut`.
   - `signOut({ refreshToken })` when `audit` fails inside `SAVEPOINT refresh_revocation_audit` still commits the family revocation and emits `REFRESH_REVOCATION_AUDIT_UNAVAILABLE`.
   - `signOut({ refreshToken })` with legacy token (no `familyId`) revokes only that token and leaves other tokens untouched.
   - `signOut({ refreshToken })` with mismatched `payload.workspaceId` or invalid UUID `impersonatorUserWorkspaceId` safely returns / fails closed without SQL `22P02`.
2. In `omni-human-text-command.postgres-spec.ts`:
   - Existing race test at line 623 passes deterministically under PG 17 (`OMNI_HUMAN_TEXT_COMMAND_IDEMPOTENCY_CONFLICT`).
3. In `omni-binding-config-wakeup` PG spec:
   - Concurrent `enqueueOmniBindingConfigWakeups` race on the same `(workspaceId, eventId)` succeeds cleanly with exactly 1 persisted wakeup row, 1 audit entry, and 0 `23505` errors.
