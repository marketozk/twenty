# LOG-213 Design: Refresh-family revocation on `signOut({ refreshToken })` and deterministic-PK `ON CONFLICT` fencing in omnichannel services

## Scope and motivation
Close the last two actionable non-migration code gaps in `ROB-765` before building a new server candidate and running full end-to-end HTTP/JWT acceptance:
1. **`UserSessionService.signOut({ refreshToken })` family revocation (`packages/twenty-server/src/engine/core-modules/user-session/services/user-session.service.ts`)**:
   - Currently, `revokePresentedRefreshToken` revokes only the single presented `AppTokenEntity` row (`id = jti`).
   - Since `LOG-207` introduced `familyId` in `core."appToken".context`, signing out with a pre-rotation or grace-period refresh token leaves active rotated child/sibling refresh tokens in the same `familyId` alive and renewable.
   - Fix without any DB migration: when the presented refresh token carries a valid `familyId` in `context.familyId`, revoke all unrevoked or reason-less non-expired tokens in the same `(userId, REFRESH_TOKEN, LOWER(context->>'familyId'))` family (plus the presented token if still unmarked) atomically under `acquireUserAuthenticationLock(userId, 'exclusive')`, with `UserSessionRevokedReason.UserSignOut`, canonical `ORDER BY token.id ASC FOR UPDATE` locking, per-row post-update snapshot validation, workspace-grouped `CrmAuditTransactionContext` audit under one `operationId` + `correlationId`, and `SAVEPOINT refresh_revocation_audit` survivability + `reportCrmAuditUnavailable('REFRESH_REVOCATION_AUDIT_UNAVAILABLE')`.
   - Legacy tokens without `familyId` preserve exact single-token revocation behavior.
   - Add fail-closed UUID validation for optional `payload.workspaceId` (must match `before.workspaceId` when present) and `payload.impersonatorUserWorkspaceId` before SQL execution.
2. **Deterministic-PK vs `ON CONFLICT` PG 17 race in `admit-omni-human-text-command.ts` and `omni-binding-config-wakeup.ts`**:
   - Root cause of the sole failure in `LOG-211` full regression (`omni-human-text-command.postgres-spec.ts:668`): `admitOmniHumanTextCommand` inserts a deterministic UUIDv5 `id = commandId` derived from `(workspaceId, workspaceMemberId, idempotencyKey)` while specifying `ON CONFLICT ("workspaceId","actorKind","actorId","idempotencyKey") DO NOTHING`. Under PostgreSQL 17, `PK_8f710425081f885de68a1174f1b (id)` / `UQ_omniOutgoingCommand_workspace_id` is checked before `UQ_omniOutgoingCommand_actor_key`, raising `23505` instead of suppressing the conflict so `replay(await findCommand())` can run and raise `OMNI_HUMAN_TEXT_COMMAND_IDEMPOTENCY_CONFLICT`.
   - Same latent pattern exists in `omni-binding-config-wakeup.ts:378`: deterministic `id = omniBindingConfigWakeupId(eventId)` with `ON CONFLICT ("workspaceId","eventId") DO NOTHING` on a table with `PK(id)` and `UQ_omniBindingConfigWakeup_workspace_id(workspaceId, id)`.
   - Fix:
     - In `admit-omni-human-text-command.ts:461`, use `ON CONFLICT DO NOTHING RETURNING id`. Because `inserted.length === 0` immediately invokes `replay(await findCommand())`, any conflict on `(workspaceId, 'workspaceMember', actorId, idempotencyKey)` (whether caught by `PK` or `UQ_omniOutgoingCommand_actor_key`) resolves cleanly to idempotent replay or `OMNI_HUMAN_TEXT_COMMAND_IDEMPOTENCY_CONFLICT`, while any unexpected conflict on another constraint causes `findCommand()` to return `[]` and fail closed with `OMNI_HUMAN_TEXT_COMMAND_ROW_INTEGRITY`.
     - In `omni-binding-config-wakeup.ts:378`, use `ON CONFLICT DO NOTHING RETURNING ...` AND when `inserted.length === 0`, verify via `SELECT id, "bindingId", "workspaceId", "eventId" FROM core."omniBindingConfigWakeup" WHERE "workspaceId"=$1 AND "eventId"=$2` that the existing row matches `(omniBindingConfigWakeupId(eventId), principal.bindingId, principal.workspaceId, eventId)`, failing closed with `fail('ENQUEUE_POSTCONDITION')` if absent or mismatched.

## Non-goals (preserved boundaries)
- No DB migrations (all 10 frozen fork migrations stay unchanged).
- `UserSessionEntity` still does not store `familyId` (requires DB migration, stays documented architectural limitation).
- `ApplicationTokenService` stateless JWT and `UserSessionCleanupCronJob` retention policy remain unchanged.
- Zero new Enterprise dependency violations (`check_enterprise_dependencies.py --verify-baseline`).
