# LOG-201 Design: Transactional Audit of Agent Chat SQL CTE `recordShare` Writers

## Goal
Close the remaining production `recordShare` writers in `twenty-server`: the `AgentHistoryRepository` (`EntityManager` / SQL CTE) writers across `AgentChatSharingService`, `AgentChatThreadService`, `AgentChatThreadParticipantService`, `AgentChatChannelService`, `AgentChatChannelGrantService`, and `RewriteAgentChatChannelGrantsJob`.

## Complete Inventory of Remaining `recordShare` Writers
1. **Already audited**:
   - `LOG-199`: `RecordSharingResolver` / `RecordSharingService` / `ShareRecordTool` (`setManualShare`, `deleteMatching`, `insertMany`), `RecordShareOwnershipTransferService` (`transferMemberGrants`).
   - `LOG-200`: `ShareWithService.insertRecordSharesForCreatedRecords` (`CommonCreateManyQueryRunnerService`), `WorkflowRunRecordShareService` (`replaceShares`, `syncRunsOfCoreWorkflows`, `updateAccessThenSyncRuns`, `SyncWorkflowRunSharesDeferredActionHandlerService`).
2. **Unused / Bootstrap**:
   - `RecordShareStorageService.deleteBySourceId`: 0 production callers in `packages/twenty-server/src` (left untouched per scope discipline).
   - `RecordShareStorageService.deleteByRecordIdsInTransaction`: 1 production caller (`AgentChatSharingService.createThread:259`), covered by `LOG-201`.
   - `database/commands/upgrade-version-command/2-40..2-46` and `database/commands/agent-history/utils/backfill-legacy-chat-thread-owner-grants.util.ts`: immutable committed upgrade commands / migration utilities (never rewritten per repo policy).
   - `dev-seeder`: `DevSeederAgentChatChannelWorkspaceService` calls `rewriteChannelGrants` (gets system audit automatically); `seed-agent-chat-thread-inbox-state.util.ts` and `dev-seeder.workspace-service.ts` are dev-only seeders outside production scope.
3. **Production writers closed in `LOG-201`** (all run inside `AgentHistoryWorkspaceStorageService.run(workspaceId, work)` = `dataSource.transaction((manager) => work({ manager, table }))`):
   - `AgentChatSharingService.createThread`: `deleteByRecordIdsInTransaction` + `backfillWorkspaceChatThreadOwnerGrants` + optional `channelGrantService.rewriteThreadGrantsInTransaction` + `setUpCreatedThreadsInboxState` in one transaction.
   - `AgentChatSharingService.claimUnownedThreadForRun`: `backfillWorkspaceChatThreadOwnerGrants` + participant CTE with `buildAgentChatThreadParticipantOwnerShareInsert`.
   - `AgentChatSharingService.setUpCreatedThreadsInboxState`: called from `createThread` (reuses outer audited transaction) and `AgentChatThreadService.assignCreatedThreadsToCreator` (opens audited transaction with `authContext`).
   - `AgentChatThreadParticipantService.recordMemberActivity` and `AgentChatThreadParticipantService.write` (`updateInboxState`, `markAsMentioned`, `markAsAssigned`, `endSnooze`): participant CTE with `buildAgentChatThreadParticipantOwnerShareInsert`.
   - `AgentChatChannelGrantService.rewriteThreadGrantsInTransaction` (called from `AgentChatSharingService.createThread`, `AgentChatThreadService.moveToChannel`, and `AgentChatChannelService.moveChannelThreads` during `deleteChannel`), `rewriteChannelGrants` (called from `AgentChatChannelService.updateChannel`, `RewriteAgentChatChannelGrantsJob`, `rewriteAllChannelGrants`, `DevSeeder`), and `rewriteAllChannelGrants` (called from `RewriteAgentChatChannelGrantsJob`).

## Architecture (`record-share-audit.ts`, zero Enterprise edges)

### 1. EntityManager Audit Executor & Session Registry
- `createCrmAuditEntityManagerExecutor(manager, workspaceId)`:
  - Validates `manager?.queryRunner` exists, `isTransactionActive === true`, and `isReleased === false` on creation and before every `query()` call (fail-closed).
  - Routes all queries through `manager.query(sql, params)` on the same transactional PostgreSQL connection.
- `activeAgentChatShareAudits = new WeakMap<object, ActiveAgentChatShareAudit>()` keyed by `manager`:
  - `runAuditedAgentChatRecordShareTransaction({ manager, workspaceId, operation, impersonatorUserWorkspaceId?, work })`:
    1. Rejects nested registration if `activeAgentChatShareAudits.has(manager)`.
    2. Creates executor via `createCrmAuditEntityManagerExecutor(manager, normalizedWorkspaceId)`.
    3. Executes `SET LOCAL lock_timeout = '8s'` (before caller channel-grant lock helpers, so `acquireAgentChatChannelGrantLocksForThreadWriteOrThrow`'s tighter `2000ms` timeout still takes precedence when entered).
    4. Calls `verifyWorkspaceKeyShare(executor, normalizedWorkspaceId)` (`FOR KEY SHARE` on `core.workspace`, requiring `deletedAt IS NULL`).
    5. Validates `impersonatorUserWorkspaceId` (only allowed for `coreUser` / `workspaceMember` actors), resolves `userId` from `core."userWorkspace" WHERE id = $1 AND "deletedAt" IS NULL`, checks initiator consistency, and finalizes `operation` with fresh `operationId`.
    6. Creates one `CrmAuditTransactionContext(executor, operation)` and tracks touched scopes (`trackedRecordScopes: Map<string, Set<string>>` by `objectMetadataId` -> `Set<recordId>`, `trackedChannelScopes: Map<string, Set<string>>` by `threadObjectMetadataId` -> `Set<channelId>`) plus `recordedMutations` counter.
    7. Runs `await work()` with session stored in `activeAgentChatShareAudits`.
    8. On success, if `recordedMutations > 0`:
       - Reads one canonical `preFlushSnapshot` across all tracked `(objectMetadataId, recordIds)` and `(threadObjectMetadataId, channelId, rowCause = 'RULE')` scopes.
       - Calls `await audit.flush()`.
       - Executes `SET CONSTRAINTS ALL IMMEDIATE` and `verifyWorkspaceActive(executor, normalizedWorkspaceId, false)`.
       - Re-reads `postFlushSnapshot` across the same scopes and throws on any drift.
    9. Cleans up `activeAgentChatShareAudits.delete(manager)` in `finally`.
- Using a single transaction-level `CrmAuditTransactionContext` and end-of-transaction pre-flush/post-flush snapshot solves multi-step composition in `createThread` cleanly:
  - Step 1 (`deleteByRecordIdsInTransaction`), Step 2 (`backfillWorkspaceChatThreadOwnerGrants`), Step 3 (`rewriteThreadGrantsInTransaction`), and Step 4 (`setUpCreatedThreadsInboxState`) each verify their own exact `before` (`FOR UPDATE`) -> `after` diff invariants and record into the shared `audit` under ONE `operationId`, while the post-flush check compares the final committed-before-flush state of all touched scopes without false drift between intermediate steps.

### 2. Attribution Resolution
- `resolveAgentChatUserAuditOperation({ workspaceId, authContext })`:
  - Uses `captureRecordShareAudit({ workspaceId, authContext })` (reusing `LOG-199` / `LOG-200` ALS consistency, `viaApplication`, and `impersonatorUserWorkspaceId` handling) for `createThread`, `claimUnownedThreadForRun`, and `assignCreatedThreadsToCreator`.
- `resolveAgentChatExplicitOrAmbientAuditOperation({ workspaceId, auditOperation?, auditImpersonatorUserWorkspaceId?, fallbackActor, requireAmbientMatchForMemberId? })`:
  - Validates `workspaceId` and rejects `auditImpersonatorUserWorkspaceId` without `auditOperation` or with non-user actors (reusing `validateWorkflowRunShareSyncAuditInput` pattern).
  - If explicit `auditOperation` is provided: uses it (with fresh `operationId = randomUUID()`).
  - Else if ALS `captureCurrentCrmAuditOperation(workspaceId)` is present: uses ambient `operation` + `impersonatorUserWorkspaceId` (when `requireAmbientMatchForMemberId` is set, e.g., `recordMemberActivity`, `updateInboxState`, `moveToChannel`, verifies ambient actor consistency for user actors or preserves ambient actor/initiator; when unset, e.g., `markAsMentioned`, `markAsAssigned`, attributes to the calling ALS principal rather than the target participant!).
  - Else falls back to `fallbackActor` (`{ kind: 'workspaceMember', id }` for self-initiated member calls without ALS, or `{ kind: 'system', id: ... }` for background jobs such as `agent_chat_thread_snooze_end`, `agent_chat_thread_participant_sync`, `rewrite_agent_chat_channel_grants_job`, `agent_chat_channel_grant_rewrite`).
- In `AgentChatChannelService.updateChannel` and `deleteChannel`:
  - Synchronously capture a dedicated `recordShare` audit operation before any `await` (from `auditIdentity`, `authUserWorkspaceId`, and ALS) so the `correlationId`, `actor`, `initiator`, and `impersonatorUserWorkspaceId` are preserved into `rewriteChannelGrants` and `moveChannelThreads` -> `rewriteThreadGrantsInTransaction`.

### 3. Five Audited Elementary Scopes (all require active session on `manager`, fail-closed if absent)
1. **`auditAgentChatRecordShareCleanup`** (`AgentChatSharingService.createThread` -> `deleteByRecordIdsInTransaction`):
   - Locks `before` (`FOR UPDATE`) for `(threadObjectMetadataId, recordIds)`.
   - Runs `deleteByRecordIdsInTransaction`.
   - Reads `after`; asserts `after.size === 0`.
   - Records `delete` for every removed row and registers `(threadObjectMetadataId, recordIds)`.
2. **`auditAgentChatThreadOwnerGrantBackfill`** (`createThread`, `claimUnownedThreadForRun` -> `backfillWorkspaceChatThreadOwnerGrants`):
   - Locks `before` (`FOR UPDATE`) for `(threadObjectMetadataId, recordIds)`.
   - Runs `backfillWorkspaceChatThreadOwnerGrants`, receives `insertedCount`.
   - Reads `after`; asserts no pre-existing row was deleted or modified, every new row has `rowCause === 'OWNER'`, `principalType === 'WORKSPACE_MEMBER'`, `accessLevel === 'FULL'`, `sourceId === recordId`, `principalId === expectedOwnerWorkspaceMemberId`, and `newRows.length === insertedCount`.
   - Records `create` for every new row and registers `(threadObjectMetadataId, recordIds)`.
3. **`auditAgentChatParticipantOwnerShareWrite`** (`claimUnownedThreadForRun`, `setUpCreatedThreadsInboxState`, `recordMemberActivity`, `AgentChatThreadParticipantService.write`):
   - Locks existing `recordShare` rows (`FOR UPDATE OF rs`) joined with `"agentChatThreadParticipant" p` where `rs."objectMetadataId" = $participantObjId AND rs."recordId" = p.id AND p."threadId" = ANY($threadIds) AND p."workspaceMemberId" = $memberId`.
   - Runs the existing atomic participant + `buildAgentChatThreadParticipantOwnerShareInsert` CTE untouched.
   - Re-reads `after` with the same join.
   - Asserts no `before` row was deleted or modified; every new row in `after \ before` has `objectMetadataId === participantObjId`, `principalType === 'WORKSPACE_MEMBER'`, `principalId === normalizedMemberId`, `accessLevel === 'FULL'`, `rowCause === 'OWNER'`, `sourceId === recordId`, `deletedAt === null`.
   - Records `create` for each new row (idempotent no-op emits `0` audit rows) and registers `(participantObjId, createdRecordIds)`.
4. **`auditAgentChatChannelGrantRewrite`** (`AgentChatChannelGrantService.replaceGrantsInTransaction`):
   - Resolves `threadObjectMetadataId` from `core."objectMetadata"` (`workspaceId` + `STANDARD_OBJECTS.agentChatThread.universalIdentifier`); if missing, returns early without writing.
   - For `{ threadIds }` scope: locks all `recordShare` rows (`FOR UPDATE`) for `(threadObjectMetadataId, threadIds)` (all `rowCause` values, proving `OWNER`/`MANUAL`/`APPLICATION` rows are untouched!).
   - For `{ channelId }` scope: locks all `recordShare` rows (`FOR UPDATE`) for `(threadObjectMetadataId, rowCause = 'RULE', sourceId = channelId)`.
   - Runs the existing `DELETE` + `INSERT ... ON CONFLICT DO NOTHING` SQL.
   - Re-reads `after` with the same scope query.
   - Asserts zero in-place updates; every deleted row has `rowCause === 'RULE'` (and `sourceId === channelId` for channel scope); every inserted row has `rowCause === 'RULE'`, `principalType === 'ROLE'`, `accessLevel === 'READ_WRITE'` (and `sourceId === channelId` for channel scope).
   - Records `delete` / `create` into shared `session.audit` (idempotent rewrite emits `0` audit rows) and registers the scope for post-flush verification.
5. **Failure latching on shared session**:
   - If any audited step throws inside `runAuditedAgentChatRecordShareTransaction` and caller attempts to swallow the error, latch `session.failure` (same pattern as `runNativeCrmAuditWrite` in `LOG-200`) and rethrow before `audit.flush()` so partial/unverified writes can never commit.

## Edge Cases & Non-Goals
- `lock_timeout` ordering: `runAuditedAgentChatRecordShareTransaction` sets `8s` at transaction entry; `acquireAgentChatChannelGrantLocksForThreadWriteOrThrow` temporarily sets `5000ms` (`AGENT_CHAT_CHANNEL_GRANT_LOCK_TIMEOUT_MS`) and restores the previous `lock_timeout` after acquiring locks.
- `core.workspace` uses `FOR KEY SHARE` (never `FOR NO KEY UPDATE`) so concurrent chat thread creations and participant inbox actions do not serialize on `core.workspace`.
- Participant share audit acquires `pg_advisory_xact_lock(hashtextextended('agent-chat-thread-participant:${workspaceId}:${threadId}:${workspaceMemberId}', 0))` in sorted deduplicated `threadIds` order and locks `recordShare` with `ORDER BY rs.id FOR UPDATE OF rs`.
- `recordMemberActivity` locks `agentChatThread` (`FOR NO KEY UPDATE`) before `auditAgentChatParticipantOwnerShareWrite` (keeping `agentChatThread -> recordShare` lock order); `moveChannelThreads` uses `ORDER BY id FOR NO KEY UPDATE`.
- `expectedWorkspaceMemberId` is validated inside the transaction against `${schema}."workspaceMember"` (`FOR SHARE`, `deletedAt IS NULL`) when the calling user principal (`actor` or `initiator` under `application`/`agent`) is `coreUser`, and by UUID equality when `workspaceMember`.
- `AgentChatChannelService.updateChannel` / `deleteChannel` derive `recordShare` audit attribution from `peekNavigationMenuItemAuditAttribution(capturedAudit)` (sharing the same `correlationId`, principal, and `pendingUserWorkspaceActor`/`pendingAgentId` resolution).
- `AgentChatSharingService.createThread` / `claimUnownedThreadForRun` accept optional `auditContext`; `AgentInboxService` attributes to ALS or `sender` (`application` / `system:agent_inbox_workflow`), never to the passive recipient.
- Cumulative `expectedRows: Map<rowId, RecordShareRowProjection>` tracks all audited scopes, verifies pre-flush and post-flush snapshots against `expectedRows`, and checks `session.failure` unconditionally on helper entry and after `work()`.
- `auditAgentChatChannelGrantRewrite` passes `threadObjectUniversalIdentifier` as a parameter (keeping `record-share-audit.ts` free of `twenty-shared/*` imports) and verifies `principalType === 'ROLE' && accessLevel === 'READ_WRITE'` for every `RULE` row in `after`.
- Known limitation: `AgentHistoryWorkspaceStorageService.run` uses TypeORM `dataSource.transaction`, so lost COMMIT ACK does not classify as `NativeTransactionOutcomeUnknownError`.
- Soft-deleted `recordShare` rows fail closed via `assertRecordShareRowInvariants` on every `before` and `after` read.
- Upgrade commands (`2-40..2-46`) and `RecordShareStorageService.deleteBySourceId` (0 callers) are out of scope.
