# LOG-204 Design: ALS Attribution Propagation for Native CRM Audit & `NativeTransactionOutcomeUnknownError` Propagation Across All `record-crud` Services

## Goal
1. Close the cross-cutting attribution gap across all public native CRM mutations (`CREATE_ONE`, `CREATE_MANY`, `UPDATE_ONE`, `UPDATE_MANY`, `DELETE_ONE`, `DELETE_MANY`, `RESTORE_ONE`, `RESTORE_MANY`, `DESTROY_ONE`, `DESTROY_MANY`, `MERGE_MANY`) and all callers of `WorkspaceDataSource.transaction(..., { nativeAudit })` by propagating trusted ALS attribution (`impersonatorUserWorkspaceId` -> `initiator`, `correlationId`, `causationId`), `viaApplication` / `application` / `agentId` delegation on `user` auth contexts, and `application` initiator for `actingAgent` on `application` auth contexts, while failing closed on ALS/auth conflicts and preserving full compatibility with `role-update-audit.ts` and `record-share-audit.ts` Branch A.
2. Close the remaining `NativeTransactionOutcomeUnknownError` masking gap in all 7 remaining mutating `record-crud` services (`CreateRecordService`, `CreateManyRecordsService`, `UpdateRecordService`, `UpdateManyRecordsService`, `DeleteManyRecordsService`, `UpsertRecordService`, `UpsertManyRecordsService`), matching `DeleteRecordService` (`LOG-202`).

## Surgical Changes

### 1. `membership-cleanup-identity.ts` (M1)
- Add optional `causationId?: string` to `MembershipCleanupIdentity` (validated as non-empty string with length `<= 256`), propagated by `copyMembershipCleanupIdentity` and `membershipCleanupOperation`.

### 2. `crm-audit-attribution-context.ts` (B3)
- Add `captureCurrentCrmAuditTrace(workspaceId)` for `auth.type === 'system'` callers:
  - Returns `undefined` when ALS is empty or masked (`kind === 'resolved'` with `identity === undefined`).
  - For `kind === 'resolved'`, verifies `snapshot.workspaceId === scope` (throws `'CRM audit context workspace mismatch'` otherwise) and returns `{ correlationId, causationId }`.
  - For `kind === 'request'`, verifies `snapshot.authentication.workspaceId === undefined || snapshot.authentication.workspaceId.toLowerCase() === scope` (throws `'CRM audit context workspace mismatch'` on cross-workspace mismatch) and returns `{ correlationId: snapshot.correlationId }` without requiring `user`/`apiKey`/`application` on unauthenticated or workspace-less requests.

### 3. `native-crm-audit-transaction.ts` (B1, M2, M3, M4, m1)
- Extend structural `NativeCrmAuditAuth` port (backward-compatible optional fields):
  - `'user'`: `user?: { id: string }`, `userWorkspaceId?: string`, `application?: { id: string }`, `viaApplication?: { id: string }`, `agentId?: string`.
  - `'application'`: `agentId?: string`.
- **Keep `captureNativeCrmAuditOperation(workspaceId, auth, options): CrmAuditOperation` pure (NO ALS reads, B1)** so `role-update-audit.ts` and ~20 metadata/role audit modules (which strip `auth.user` and manage ALS/impersonator/agentId themselves) remain unaffected:
  - Validates `options` allowlist (`operationId`, `correlationId`, `causationId`, `systemActorId`), workspace match, and `systemActorId` guard.
  - On `'user'`: validates `auth.application` vs `auth.viaApplication` (using `!== undefined` and normalized `uuid(...)`), rejects `agentId` without `application`/`viaApplication`, derives `agent(agentId) + initiator: workspaceMember` or `application(appId) + initiator: workspaceMember` or `workspaceMember`.
  - On `'application'`: derives `agent(actingAgent.id) + initiator: application(appId)` when `actingAgent` is present, else `application(appId)` (never promoting `auth.agentId` to `actingAgent`).
  - On `'apiKey'` and `'system'`: unchanged.
- **Add `captureNativeCrmAuditBinding(workspaceId, auth, options)`** returning `Readonly<{ operation, impersonatorUserWorkspaceId?, ambientCorrelationId?, ambientCausationId? }>`:
  - Uses `captureNativeCrmAuditOperation` for the base auth mapping, then reconciles ALS strictly:
    - For `auth.type === 'system'`: calls `captureCurrentCrmAuditTrace(workspaceId)` (B3); inherits `correlationId` / `causationId` when not set in `options`; never attaches `impersonatorUserWorkspaceId`.
    - For `auth.type === 'user'`: calls `captureCurrentCrmAuditOperation(workspaceId)`. Validates all optional fields with `!== undefined` and `uuid(...)` (M2):
      - `ambient.actor.kind === 'coreUser'`: requires `userId !== undefined && ambient.actor.id === userId`; adopts `ambient.initiator` if present.
      - `ambient.actor.kind === 'workspaceMember'`: requires `ambient.actor.id === workspaceMemberId`; adopts `ambient.initiator` if present.
      - `ambient.actor.kind === 'application'`: reconciles `resolvedApplicationId`; allows `ambient.initiator` ONLY as `coreUser(userId)` (requiring `userId !== undefined`), `workspaceMember(workspaceMemberId)`, or `undefined` ONLY when `resolvedApplicationId === ambient.actor.id` (rejects app-only ALS + plain user auth and any other initiator kind with `'Native audit ambient initiator conflict'`, M2).
      - `ambient.actor.kind === 'agent'`: reconciles `resolvedAgentId`; allows `ambient.initiator` ONLY as `coreUser(userId)` (requiring `userId !== undefined`), `workspaceMember(workspaceMemberId)`, `application(resolvedApplicationId)` (requiring `resolvedApplicationId !== undefined`), or `undefined` ONLY when `resolvedAgentId === ambient.actor.id && resolvedApplicationId !== undefined` (rejects app+agent-only ALS + plain user auth and any other initiator kind, M2).
      - Any other ambient actor (`apiKey`, `system`): throws `'Native audit ambient principal conflict'`.
      - Extracts `impersonatorUserWorkspaceId = ambient?.impersonatorUserWorkspaceId !== undefined ? uuid(...) : undefined` and rejects combining impersonation or `resolvedAmbientInitiator` with `resolvedApplicationId` or `resolvedAgentId`.
    - For `auth.type === 'application'`: calls `captureCurrentCrmAuditOperation(workspaceId)`. Rejects `ambient.impersonatorUserWorkspaceId`. When `actingAgent` is present, allows ambient `agent(actingAgentId)` (with no initiator or initiator `application(appId)`) or `application(appId)` (no initiator). When `actingAgent` is absent, allows ambient `application(appId)` (no initiator) or `agent(id)` with initiator `application(appId)` (and verifies `id === uuid(auth.agentId)` if `auth.agentId !== undefined`, m1).
    - For `auth.type === 'apiKey'`: calls `captureCurrentCrmAuditOperation(workspaceId)`. Requires no `impersonatorUserWorkspaceId`, no `initiator`, and `ambient.actor` === `apiKey(apiKeyId)`.
- **Update `withNativeCrmAuditTransaction(executor, scope, operation, work, meta?)`** (M4):
  - Synchronously validates and normalizes `normalizedImpersonator = meta?.impersonatorUserWorkspaceId !== undefined ? uuid(meta.impersonatorUserWorkspaceId) : undefined` and asserts `operation.actor.kind === 'workspaceMember'` BEFORE acquiring `pg_advisory_xact_lock` or running SQL.
  - When `normalizedImpersonator !== undefined`, resolves active impersonator inside the transaction:
    `SELECT "userId" FROM core."userWorkspace" WHERE id = $1 AND "deletedAt" IS NULL`
    (intentionally omits `"workspaceId"` filter to support cross-workspace server-level impersonation per `ImpersonationAuthorizationService`, matching `role-update-audit.ts` and `record-share-audit.ts`). Throws `'Native audit impersonation initiator unavailable'` if 0 or >1 rows; throws `'Native audit impersonation context conflict'` if `operation.initiator` differs; sets `operation.initiator = { kind: 'coreUser', id: resolvedInitiatorId }`.
  - Stores `{ executor, operation, impersonatorUserWorkspaceId: normalizedImpersonator, ambientCorrelationId, ambientCausationId }` in `scopes`.
- **Update `runInExistingNativeCrmAuditScope` and `runInNativeCrmAuditScopeIfPresent`** (M3, B2):
  - Calls `captureNativeCrmAuditBinding` and checks:
    - `workspaceId` and `actor` (`'Public CRM mutation scope has a different workspace or actor'`, preserving existing test messages);
    - `impersonatorUserWorkspaceId` match;
    - `correlationId` / `ambientCorrelationId` and `causationId` / `ambientCausationId` consistency (rejects both `C1 !== C2`, newly introduced ALS over an uncorrelated scope, and lost/masked ALS inside an ALS-correlated scope, without breaking explicit `options.correlationId` outside ALS);
    - in `runInExistingNativeCrmAuditScope`: `initiator` consistency when `impersonatorUserWorkspaceId === undefined`;
    - in `runInNativeCrmAuditScopeIfPresent`: passes `impersonatorUserWorkspaceId` into the callback so `record-share-audit.ts` Branch A can verify impersonated and non-impersonated `initiator` attribution with its exact domain error message.

### 4. `workspace-data-source.ts`
- Call `captureNativeCrmAuditBinding(this.internalContext.workspaceId, this.authContext, options.nativeAudit)` in `WorkspaceDataSource.transaction` and pass `{ impersonatorUserWorkspaceId, ambientCorrelationId, ambientCausationId }` to `withNativeCrmAuditTransaction`.

### 5. `record-share-audit.ts` (B2)
- Extend `toNativeAuthPort` to forward `user`, `userWorkspaceId`, `application`, `viaApplication`, and `agentId` for `'user'` (and `agentId` for `'application'`).
- Update Branch A (`runAuditedShareWithInsert` inside `runInNativeCrmAuditScopeIfPresent`): accept `impersonatorUserWorkspaceId` from the scope callback, allow `userCapture.impersonatorUserWorkspaceId === impersonatorUserWorkspaceId && operation.initiator?.kind === 'coreUser'` for impersonated `CREATE` with `shareWith`, and keep exact mismatch rejection when non-impersonated `initiator` differs.
- Update `resolveShareWithStandaloneOperation` for `authContext.type === 'application'` without `actingAgent` to allow `ambient.actor.kind === 'agent'` with `initiator = application(appId)` (and match `authContext.agentId` if defined), staying aligned with `captureNativeCrmAuditBinding`.

### 6. Seven Remaining Mutating `record-crud` Services
Add `if (error instanceof NativeTransactionOutcomeUnknownError) { throw error; }` at the top of `catch (error)` in:
- `create-record.service.ts`
- `create-many-records.service.ts`
- `update-record.service.ts`
- `update-many-records.service.ts`
- `delete-many-records.service.ts`
- `upsert-record.service.ts`
- `upsert-many-records.service.ts`

## Enterprise Boundary & Known Limitations
- Zero new imports from `@license Enterprise` modules (`check_enterprise_dependencies.py --verify-baseline` must report `0` violations).
- Known limitations kept out of scope for `LOG-204`:
  - `ToolExecutorService.dispatch` (`tool-executor.service.ts:80-93`) has an outer `catch (error)` converting thrown errors into `{ success: false }` for AI tool calls (same as `DeleteRecordService`); workflow actions and direct callers of all 8 `record-crud` services receive `NativeTransactionOutcomeUnknownError` unmasked.
  - Non-impersonated `user` auth contexts rely on server-hydrated `WorkspaceAuthContext` + `userId` matching `ambient.actor.id` (no extra `core."userWorkspace"` query per regular write).
  - Full HTTP/JWT end-to-end acceptance, uncovered standard FK child tables (`timelineActivity`, etc.), durable audited `FILES` hard-delete, and deployment remain open criteria of `ROB-765`.
