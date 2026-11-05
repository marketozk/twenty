# LOG156 Architecture and Security Design Review

Reviewed `Research/omnichannel_crm/implementation/log156/design.md`,
`Research/omnichannel_crm/implementation/log156/test-research.md`, and the
actual `crm-audit-transaction-context.ts`, `role-update-audit.ts`,
`role-assignment-audit.ts`, `role.service.ts`, `role.resolver.ts`,
`delete-role.tool.ts`, `ai-agent-role.service.ts`, `api-key-role.service.ts`,
`api-key.resolver.ts`, `workspace-migration-runner.service.ts`,
`crm-audit-role-update.postgres-spec.ts`, and
`crm-audit-role-assignment.postgres-spec.ts` files after LOG155 (`59a3acac`).
This report covers audited role delete and agent/API-key role assignment (part
of ROB-765). Runtime and source implementation acceptance belong to the
following step.

## Verdict

The LOG156 design is sound and closes the remaining public and AI role lifecycle
entrypoints (`RoleService.deleteRole`, `RoleResolver.deleteOneRole`,
`DeleteRoleTool.execute`, `AiAgentRoleService.assignRoleToAgent`,
`AiAgentRoleService.removeRoleFromAgent`, and `ApiKeyRoleService.assignRoleToApiKey`)
under the existing atomic `core` / `crm_audit` transaction boundary. Three
implementation-critical refinements identified during source verification must
be incorporated during implementation:

1. **Multi-action plan in `WorkspaceMigrationRunnerService.executeRun` and `runAuditedRoleMutation` (`delete`):**
   - `RoleService.deleteManyRoles` passes `role.flatEntityToDelete` plus
     `roleTarget.flatEntityToDelete` and `roleTarget.flatEntityToCreate` to
     `validateBuildAndRunWorkspaceMigration`, which orders actions as
     `role.delete`, then `roleTarget.delete`, then `roleTarget.create`.
   - For `roleAudit.action === 'delete'`, `WorkspaceMigrationRunnerService.executeRun`
     must allow `action.metadataName === 'role' && action.type === 'delete'`
     (matching `roleAudit.roleId`) and `action.metadataName === 'roleTarget' && (action.type === 'delete' || action.type === 'create')`,
     and pass `{ application: flatApplication, roles: allFlatEntityMaps.flatRoleMaps?.byUniversalIdentifier ?? {}, targets: allFlatEntityMaps.flatRoleTargetMaps?.byUniversalIdentifier ?? {}, agents: allFlatEntityMaps.flatAgentMaps?.byUniversalIdentifier ?? {} }`
     to `runAuditedRoleMutation` (and include `agents` in `mappings` passed to
     `runAuditedRoleAssignment`).
   - Because delete action handlers mutate `allFlatEntityMaps.*.byUniversalIdentifier`
     in place during `execute`, `runAuditedRoleMutation` and
     `runAuditedRoleAssignment` must resolve all universalIdentifier-to-ID
     mappings from `mappings` before invoking `await work(runner)`.
   - Because `core."roleTarget"."roleId"` references `core.role(id) ON DELETE CASCADE`
     in PostgreSQL, `runAuditedRoleMutation` locks `core.role` (`FOR UPDATE`)
     and locks all `core."roleTarget"` rows for `"roleId" = request.roleId`
     (`FOR UPDATE`) before `await work(runner)` executes, verifying a 1-to-1
     match between locked `beforeTargets` and planned `delete` `roleTarget`
     actions so `ON DELETE CASCADE` can never silently delete an un-planned or
     un-audited `roleTarget` row.

2. **`RoleService.buildRoleTargetsRebindToDefaultRole` vs Database Target State:**
   - In `deleteUserWorkspaceTransaction`, soft-deleting a `userWorkspace`
     retains its `core."roleTarget"` row, and `RoleService.buildRoleTargetsRebindToDefaultRole`
     only skips `apiKeyId` when `!activeApiKeyIds.has(targetId)`
     (`revokedAt !== null`) and `agentId` when `softDeletedAgentIds.has(targetId)`
     (`deletedAt !== null`), always creating a replacement `roleTarget` for
     every `userWorkspaceId` in `flatRoleTargetsToDelete`.
   - Therefore, in `runAuditedRoleMutation` for `request.action === 'delete'`:
     - `userWorkspaceId` targets in `beforeTargets`: lock `core."userWorkspace"`
       (`FOR SHARE`), verify every referenced row exists, and require a
       replacement `create` `roleTarget` pointing to `defaultRoleId` (with
       `defaultRole.canBeAssignedToUsers === true`).
     - `apiKeyId` targets in `beforeTargets`: lock `core."apiKey"` (`FOR SHARE`),
       verify every referenced row exists, and require a replacement `create`
       `roleTarget` pointing to `defaultRoleId` iff `revokedAt === null` (with
       `defaultRole.canBeAssignedToApiKeys === true`), while requiring no
       replacement when `revokedAt !== null`.
     - `agentId` targets in `beforeTargets`: lock `core.agent` (`FOR SHARE`),
       verify every referenced row exists, and require a replacement `create`
       `roleTarget` pointing to `defaultRoleId` iff `deletedAt === null` (with
       `input.agentUniversalIdentifier === agent.universalIdentifier` and
       `defaultRole.canBeAssignedToAgents === true`), while requiring no
       replacement when `deletedAt !== null`.

3. **`AiAgentRoleService` and `ApiKeyRoleService` Signatures and Callers:**
   - `RoleService.deleteRole`, `AiAgentRoleService.removeRoleFromAgent`, and
     `ApiKeyRoleService.assignRoleToApiKey` have no internal callers in `src/`
     and must require `auditIdentity: RoleUpdateAuditIdentity`.
   - `AiAgentRoleService.assignRoleToAgent` has one internal caller in
     `WorkflowVersionStepOperationsWorkspaceService` (`workflow-version-step-operations.workspace-service.ts:1131`)
     that passes `{ agentId: newAgent.id, roleId, workspaceId }`. Making
     `auditIdentity?: RoleUpdateAuditIdentity` optional on `assignRoleToAgent`
     while checking `Object.hasOwn(args, 'auditIdentity')` ensures any caller
     that passes the `auditIdentity` property (including `auditIdentity: undefined`)
     must provide a valid authenticated identity and run inside
     `withRoleAssignmentAudit`, while preserving internal workflow step
     duplication without modification.
   - All public/AI entrypoints must capture input scalars and validate
     `auditIdentity` (`captureRoleAuditIdentity` + `captureRoleAuditOperation`)
     before the first `await`.
