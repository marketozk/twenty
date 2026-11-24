# LOG-213: Independent Design Review

## Verdict
`pass` after incorporating all 3 Blockers and 5 Majors into implementation.

## Findings and resolutions

| # | Severity | Finding | Resolution |
|---|---|---|---|
| B1 | blocker | Early-return when `before` already has `revokedReason` would skip revoking active/reason-less siblings in the same `familyId` | Only early-return on `!before` or `payload.workspaceId` mismatch; query all revocable family rows (`revokedAt IS NULL OR revokedReason IS NULL`) so fully-revoked families remain idempotent no-op while partial/pre-LOG-213 families revoke remaining siblings. |
| B2 | blocker | Ambiguous `payload.workspaceId` (`undefined` vs `null` vs UUID) could break workspace-agnostic tests or allow `null` claim to revoke workspace row | Enforce exact 3-way contract: reject malformed non-UUID pre-SQL; reject `null` against non-null DB `workspaceId` and UUID mismatch; preserve `undefined` for legacy compatibility. |
| B3 | blocker | Non-UUID `before.context.familyId` must not downgrade to single-token revocation | Treat only `familyId === undefined` as legacy; fail closed (`Refresh revocation family is invalid`) for any defined non-UUID `familyId`. |
| M1 | major | Locking `before` `FOR UPDATE` before family `ORDER BY id ASC FOR UPDATE` breaks ascending lock order when `tokenId > sibling.id` | Under `acquireUserAuthenticationLock(userId, 'exclusive')`, read `before` without `FOR UPDATE`, then lock all target rows in a single `ORDER BY token.id ASC FOR UPDATE` query. |
| M2 | major | `payload.impersonatorUserWorkspaceId` lacked `isImpersonating === true` gate, pre-SQL UUID check, and per-workspace match inside `SAVEPOINT` | Validate pre-SQL (silently return if malformed or `!isImpersonating`), check `membership.workspaceId === wsId` inside `SAVEPOINT`, and flush workspace audit contexts in ascending `workspaceId` order. |
| M3 | major | `validateAll()` must also guard excluded `before` against audit-trigger tampering, preserve existing `revokedReason` if `revokedAt IS NULL`, and lowercase `tokenId` | Lowercase `tokenId`, preserve `row.context?.revokedReason ?? UserSignOut`, and verify `before` in `validateAll()` even when excluded from `expectedById`. |
| M4 | major | Third deterministic-PK `ON CONFLICT` PG 17 race in `apply-omni-history-receipt.ts:506` (`creatorConversationId` + `creatorThreadId` derived from `proof.receiptId` with `ON CONFLICT ("workspaceId","bindingId","providerChatId")`) | Included `apply-omni-history-receipt.ts:506` (`ON CONFLICT DO NOTHING RETURNING id`) in LOG-213; lines 524-537 already re-select by `(workspaceId, bindingId, providerChatId)` and fail closed via `requireOne`. |
| M5 | major | `omni-binding-config-wakeup.ts` fallback `SELECT` must not use `one(...)` (wrong error code on 0 rows) | Parse with `z.array(...)` and explicitly fail closed with `fail('ENQUEUE_POSTCONDITION')` when `existing.length !== 1` or any of `(id, bindingId, workspaceId, eventId)` mismatches. |
| m1 | minor | Post-`ON CONFLICT DO NOTHING` `SELECT` relies on `READ COMMITTED` visibility | Documented explicitly via terse comment; all callers run under `READ COMMITTED`. |
| m2 | minor | Enterprise dependency baseline | Verified zero new imports and zero baseline impact across all 4 touched production files. |
