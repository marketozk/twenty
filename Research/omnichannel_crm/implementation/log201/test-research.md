# LOG-201 Test Research

## New PostgreSQL Test Suite
`packages/twenty-server/test/fork-migration/crm-audit-agent-chat-record-share.postgres-spec.ts`

Test cases against real PostgreSQL 17 with non-superuser runtime role (`SELECT, UPDATE ON core.workspace, core."userWorkspace"`, `SELECT ON core."user", core."objectMetadata", core."agentChatChannel", core."agentChatChannelRole", core."role"`, `SELECT, INSERT, UPDATE, DELETE ON workspace tables`, `SELECT, INSERT ON crm_audit."crmAuditEntry"`):

1. **`AgentChatSharingService` (`createThread`, `claimUnownedThreadForRun`, `assignCreatedThreadsToCreator` -> `setUpCreatedThreadsInboxState`)**:
   - `createThread` with `channelId` and pre-existing orphan `recordShare` on reused `threadId`: produces `delete` (orphan) + `create` (`OWNER` thread grant) + `create` (`RULE` channel role grants) + `create` (`OWNER` participant grant), ALL under ONE `operationId` with user/impersonation attribution.
   - `claimUnownedThreadForRun`: creates thread `OWNER` grant + participant `OWNER` grant under one `operationId`; claiming an already-owned thread returns `null` and emits `0` audit rows.
   - `AgentChatThreadService.assignCreatedThreadsToCreator`: sets up inbox state and audits participant `OWNER` grant with `authContext` attribution (and idempotent re-run emits `0` audit rows).

2. **`AgentChatThreadParticipantService` (`recordMemberActivity`, `updateInboxState`, `markAsMentioned`, `markAsAssigned`, `endSnooze`)**:
   - `recordMemberActivity`: creates participant `OWNER` grant on first message, emits `0` audit rows on second message (idempotent `ON CONFLICT DO NOTHING` on `recordShare`).
   - `updateInboxState` across 2 threads: creates 2 participant `OWNER` grants under ONE `operationId`.
   - `markAsMentioned` and `markAsAssigned` with ALS calling user (`actorMemberId`) targeting `targetMemberId`: audit `actor` is the calling ALS user (`actorMemberId`), NOT `targetMemberId`, while `recordShare.principalId` is `targetMemberId`!
   - `endSnooze` without ALS: uses system actor `agent_chat_thread_snooze_end` (and emits `0` audit rows when participant `OWNER` share already exists).

3. **`AgentChatChannelGrantService` (`rewriteThreadGrantsInTransaction`, `rewriteChannelGrants`, `rewriteAllChannelGrants`, `RewriteAgentChatChannelGrantsJob`) and callers (`moveToChannel`, `AgentChatChannelService`)**:
   - `moveToChannel` (channel A -> channel B, and channel B -> `null`): removes old channel `RULE` grants, inserts new channel `RULE` grants, preserves `OWNER` and `MANUAL` grants untouched.
   - `rewriteChannelGrants` with explicit `auditOperation` + `auditImpersonatorUserWorkspaceId`: deletes revoked role `RULE` grants and inserts newly granted role `RULE` grants under a fresh `operationId` sharing `correlationId` and resolved `initiator`; idempotent repeat emits `0` audit rows.
   - `RewriteAgentChatChannelGrantsJob` (`channelId` and all-channels `rewriteAllChannelGrants`): audits under `system:rewrite_agent_chat_channel_grants_job` with shared `correlationId` across channels.

4. **Fail-closed invariants & rollback**:
   - Calling `rewriteThreadGrantsInTransaction`, `setUpCreatedThreadsInboxState`, or elementary audit helpers outside an active `runAuditedAgentChatRecordShareTransaction` / non-transactional `EntityManager` fails closed.
   - Soft-deleted `recordShare` row in scope fails closed before mutation.
   - Swallowed error inside `runAuditedAgentChatRecordShareTransaction` still aborts and rolls back via failure latching.
   - Impersonator with non-user actor fails closed.
   - `audit.flush()` trigger failure rolls back both `agentChatThread`/`agentChatThreadParticipant` and `recordShare` writes completely (`0` rows committed).
   - Post-flush drift trigger on `crmAuditEntry` rolls back completely for both thread-scope (`createThread` / `moveToChannel`) and channel-scope (`rewriteChannelGrants`) transactions.

## Existing Suites to Verify
- `test/fork-migration/crm-audit-agent-chat-channel.postgres-spec.ts` (update `rewriteChannelGrantsMock` expectation to verify `auditOperation` + shared `correlationId` propagation).
- `src/engine/metadata-modules/ai/ai-chat/query-hooks/__tests__/agent-chat-thread-create.post-query.hook.spec.ts` (update mock fixtures to valid UUIDs, full `UserWorkspaceAuthContext`, and transactional `queryRunner`).
- `test/fork-migration/crm-audit-record-share-writers.postgres-spec.ts`
- `test/fork-migration/crm-audit-record-share.postgres-spec.ts`
- Full PostgreSQL regression suite on Schrodinger.
