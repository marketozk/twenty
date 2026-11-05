# LOG156 - audited role delete and agent/API-key role assignment

Proposed concrete design for independent review. Source inspection used
`RoleService`, `RoleResolver`, `DeleteRoleTool`, `AiAgentRoleService`,
`ApiKeyRoleService`, `ApiKeyResolver`, `RoleTargetService`,
`WorkspaceMigrationRunnerService`, `role-update-audit.ts` (`LOG111`, `LOG112`),
`role-assignment-audit.ts` (`LOG113`), and `crm-audit-transaction-context.ts`.
No repository or runtime changes are claimed by this document.

## Problem and scope

In `rob765-progress.md` (`Role lifecycle`), `LOG111` and `LOG112` closed public
and AI role `CREATE` and `UPDATE` (`withRoleCreateAudit`, `withRoleUpdateAudit`,
`runAuditedRoleMutation`), and `LOG113` closed public member role assignment
(`UserRoleService.assignRoleToWorkspaceMember`, `withRoleAssignmentAudit`,
`runAuditedRoleAssignment`). The remaining public/AI role lifecycle entrypoints
are:

1. **Role deletion (`RoleService.deleteRole`, `RoleResolver.deleteOneRole`, `DeleteRoleTool.execute`):**
   - `RoleService.deleteRole` delegates to `deleteManyRoles({ ids: [roleId], ... })`,
     which checks `defaultRoleId`, `isEditable`, and `validateRoleDeletionDoesNotLockOutActorOrThrow`
     against cached flat maps outside the migration runner transaction, builds
     replacement `roleTarget` rows rebinding active members, active API keys,
     and non-deleted agents to `defaultRoleId`, and executes `delete` `role` +
     `delete`/`create` `roleTarget` actions in `WorkspaceMigrationRunnerService`
     without an atomic `crm_audit."crmAuditEntry"` record or database-locked
     authority/rebind verification.
2. **Agent and API-key role assignments (`AiAgentRoleService.assignRoleToAgent`, `AiAgentRoleService.removeRoleFromAgent`, `ApiKeyRoleService.assignRoleToApiKey`):**
   - `RoleResolver.assignRoleToAgent`, `RoleResolver.removeRoleFromAgent`, and
     `ApiKeyResolver.assignRoleToApiKey` call `AiAgentRoleService` and
     `ApiKeyRoleService`, which validate target existence and role assignability
     outside the runner transaction and call `RoleTargetService.create` /
     `RoleTargetService.delete` without an atomic `roleTarget` audit entry or
     database-locked target/role verification.

## Proposed design

1. **Audit catalog extension (`crm-audit-transaction-context.ts`):**
   - Add `'delete'` to `ADMINISTRATIVE_ACTIONS.role` (`role: ['create', 'update', 'delete']`).
   - Extend `FIELD_POLICY.roleTarget.values` with `'agentId'` and `'apiKeyId'`
     (`values: ['roleId', 'userWorkspaceId', 'agentId', 'apiKeyId']`).
2. **Audited role deletion (`withRoleDeleteAudit` and `runAuditedRoleMutation` in `role-update-audit.ts`, `RoleService.deleteRole`, `RoleResolver.deleteOneRole`, `DeleteRoleTool.execute`, `WorkspaceMigrationRunnerService`):**
   - Require `auditIdentity: RoleUpdateAuditIdentity` (and optional
     `actingUserWorkspaceId?: string`) on `RoleService.deleteRole`, passed by
     `RoleResolver.deleteOneRole` (`roleAuditIdentityFromRequest(context.req)`)
     and `DeleteRoleTool.execute` (`{ auth: context.authContext!, agentId: context.agentId }`
     plus `actingUserWorkspaceId: context.userWorkspaceId`).
   - Add `withRoleDeleteAudit({ workspaceId, roleId, actingRoleIds, actingUserWorkspaceId }, identity, work)`
     in `role-update-audit.ts`.
   - Extend `runAuditedRoleMutation` (and `WorkspaceMigrationRunnerService.executeRun`)
     for `request.action === 'delete'`:
     - Verify the migration action list contains exactly one `{ type: 'delete', metadataName: 'role' }`
       action resolving to `request.roleId`, plus only `{ type: 'delete' | 'create', metadataName: 'roleTarget' }`
       actions, and that no handler emits `deferredActions`.
     - Inside `runInCoreAuditTransaction`:
       - Lock `core.workspace` `FOR NO KEY UPDATE`, verifying the workspace is
         active (`deletedAt === null`) and has a valid `defaultRoleId !== request.roleId`.
       - Verify `core.application` ownership (`verifyRoleAuditApplication`) when
         any replacement `roleTarget` is created.
       - Lock `core.role` rows for `[request.roleId, defaultRoleId]` `FOR UPDATE`,
         verifying `beforeRole` exists, has `universalIdentifier === deletedRoleUniversalIdentifier`,
         has `isEditable === true`, and is not the standard Admin role, and that
         `defaultRole` exists in `core.role`.
       - Enforce actor lockout under DB locks: reject if `request.actingRoleIds`
         contains `request.roleId` or if `request.actingUserWorkspaceId` has a
         live `core."roleTarget"` row pointing to `request.roleId`.
       - Lock all `core."roleTarget"` rows for `"roleId" = request.roleId`
         `FOR UPDATE`; verify that the planned `delete` `roleTarget` actions
         match the exact locked `beforeTargets` set (preventing un-audited
         cascade deletions or stale target sets).
       - Lock referenced `core."userWorkspace"`, `core."apiKey"`, and
         `core.agent` rows `FOR SHARE`, and verify that every active target
         (`userWorkspace` with `deletedAt === null`, `apiKey` with
         `revokedAt === null`, `agent` with `deletedAt === null`) has a matching
         replacement `create` `roleTarget` action pointing to `defaultRoleId`
         while inactive targets are not rebound.
       - Execute `await work(runner)`, then verify `request.roleId` is absent
         from `core.role`, all deleted `roleTarget` IDs are absent from
         `core."roleTarget"`, and all created `roleTarget` rows exist in
         `core."roleTarget"` with exact scalar fields and microsecond
         `createdAt`/`updatedAt` timestamps.
       - Record `roleTarget` `delete` and `create` entries plus the `role`
         `delete` entry (`before: project(beforeRole), after: null`) in
         `CrmAuditTransactionContext`, flush, and re-verify post-flush state!
3. **Audited agent and API-key role assignments (`role-assignment-audit.ts`, `AiAgentRoleService`, `ApiKeyRoleService`, `RoleResolver`, `ApiKeyResolver`):**
   - Generalize `role-assignment-audit.ts` to support three target kinds in
     `withRoleAssignmentAudit`:
     - `'userWorkspace'` (existing `UserRoleService.assignRoleToWorkspaceMember`
       contract preserved unchanged);
     - `'agent'` (`withAgentRoleAssignmentAudit` for `assign` and `remove` in
       `AiAgentRoleService.assignRoleToAgent` / `removeRoleFromAgent`);
     - `'apiKey'` (`withApiKeyRoleAssignmentAudit` in
       `ApiKeyRoleService.assignRoleToApiKey`).
   - Update `RoleResolver.assignRoleToAgent`, `RoleResolver.removeRoleFromAgent`,
     and `ApiKeyResolver.assignRoleToApiKey` to pass
     `auditIdentity: roleAuditIdentityFromRequest(context.req)`.
   - In `AiAgentRoleService.assignRoleToAgent` (when `auditIdentity` is passed;
     or `assignAuditedRoleToAgent` / optional `auditIdentity` for internal
     workflow step duplication), `AiAgentRoleService.removeRoleFromAgent`, and
     `ApiKeyRoleService.assignRoleToApiKey`:
     - Capture and validate `auditIdentity` before the first `await`.
     - Replace any cached no-op check with a repository read; if already
       assigned to the same `roleId`, return without mutation audit.
     - Inside `runAuditedRoleAssignment`:
       - Lock `core.workspace` `FOR NO KEY UPDATE` and verify `core.application`
         (`verifyRoleAuditApplication`).
       - For `'agent'`: lock `core.agent` (`WHERE id=$1 AND "workspaceId"=$2 FOR SHARE`),
         verifying it exists, has `deletedAt === null`, and (on create) matches
         `agentUniversalIdentifier`; lock `core."roleTarget"` (`WHERE "workspaceId"=$1 AND "agentId"=$2 FOR UPDATE`);
         on assign, lock `core.role` (`FOR SHARE`) and verify
         `destination.canBeAssignedToAgents === true`; on remove, verify
         `creates.length === 0 && deletes.length === 1`.
       - For `'apiKey'`: lock `core."apiKey"` (`WHERE id=$1 AND "workspaceId"=$2 FOR SHARE`),
         verifying it exists and `revokedAt === null`; lock `core."roleTarget"`
         (`WHERE "workspaceId"=$1 AND "apiKeyId"=$2 FOR UPDATE`); lock
         `core.role` (`FOR SHARE`) and verify
         `destination.canBeAssignedToApiKeys === true`.
       - Verify post-handler `core."roleTarget"` rows and microsecond timestamps,
         record `roleTarget` `delete`/`create` audit entries (`{ roleId, agentId }`
         or `{ roleId, apiKeyId }`), flush, and re-verify after flush!
