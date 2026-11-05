# LOG156 test research

Read-only test boundary analysis for audited role delete and agent/API-key role
assignment after LOG155 publication (`59a3acac`). No runtime results are claimed
here.

## Existing test suites and compatibility

1. `test/fork-migration/crm-audit-role-update.postgres-spec.ts` (`LOG111`, `LOG112`):
   - Tests `RoleService.updateRole`, `RoleService.createAuditedRole`,
     `UpdateRoleTool`, `CreateRoleTool`, `WorkspaceMigrationRunnerService`,
     `CreateRoleActionHandlerService`, and `UpdateRoleActionHandlerService`
     against real PostgreSQL (`core.role`, `core.application`,
     `core.userWorkspace`, `crm_audit."crmAuditEntry"`).
   - Extending `role-update-audit.ts` with `withRoleDeleteAudit` and
     `request.action === 'delete'` preserves all existing `'create'` and
     `'update'` assertions in `crm-audit-role-update.postgres-spec.ts`.
2. `test/fork-migration/crm-audit-role-assignment.postgres-spec.ts` (`LOG113`):
   - Tests `UserRoleService.assignRoleToWorkspaceMember`,
     `AssignRoleToWorkspaceMemberTool`, `RoleTargetService`,
     `WorkspaceMigrationRunnerService`, `CreateRoleTargetActionHandlerService`,
     and `DeleteRoleTargetActionHandlerService` against real PostgreSQL.
   - Keeping `projectRoleTarget` for `userWorkspace` targets as
     `{ roleId, userWorkspaceId }` (only including `agentId` or `apiKeyId` when
     non-null) preserves all existing assertions in
     `crm-audit-role-assignment.postgres-spec.ts`.
3. `src/engine/metadata-modules/role/tools/__tests__/role-tools.spec.ts`:
   - Updating `DeleteRoleTool.execute` to pass `actingUserWorkspaceId` and
     `auditIdentity` requires updating the `delete_role` unit expectation in
     `role-tools.spec.ts` to match `update_role` and `create_role`.

## New PostgreSQL cases required for LOG156

1. **Audited role deletion (`RoleService.deleteRole`, `DeleteRoleTool`, `runAuditedRoleMutation`):**
   - Deletes an editable custom role, rebinds assigned active `userWorkspace`,
     active `apiKey`, and active `agent` `roleTarget` rows to `defaultRoleId`,
     drops `roleTarget` rows for revoked `apiKey` or soft-deleted `agent`
     without rebinding, and writes atomic `roleTarget` (`delete` + `create`) and
     `role` (`delete`, boolean permissions in `before`, `label`/`description`/`icon`
     redacted) audit entries sharing one `operationId` before `COMMIT`.
   - Rejects deleting a non-editable role (`isEditable = false`), the workspace
     `defaultRoleId`, a role in `actingRoleIds` or assigned to
     `actingUserWorkspaceId` in `core."roleTarget"`, or a plan whose
     `roleTarget` delete/create set does not match live DB state (e.g. a
     concurrently added `roleTarget` or an active target omitted from rebind),
     with 0 DB mutations and 0 audit entries.
   - Rolls back `core.role`, `core."roleTarget"`, and `crm_audit."crmAuditEntry"`
     on SQL, handler, deferred-action, or post-flush trigger corruption, and
     preserves committed deletion + cache invalidation on lost `COMMIT` ACK
     (`NativeTransactionOutcomeUnknownError`).
2. **Audited agent and API-key role assignments (`AiAgentRoleService`, `ApiKeyRoleService`, `runAuditedRoleAssignment`):**
   - Replaces or creates an agent's `roleTarget` (`AiAgentRoleService.assignRoleToAgent`)
     and removes an agent's `roleTarget` (`AiAgentRoleService.removeRoleFromAgent`)
     with atomic `roleTarget` `delete`/`create` audit entries (`{ roleId, agentId }`),
     and skips mutation/audit on confirmed same-role no-op.
   - Replaces or creates an API key's `roleTarget`
     (`ApiKeyRoleService.assignRoleToApiKey`) with atomic `roleTarget`
     `delete`/`create` audit entries (`{ roleId, apiKeyId }`), and skips
     mutation/audit on confirmed same-role no-op.
   - Rejects assignment when `core.agent` is missing/foreign/soft-deleted or
     `destination.canBeAssignedToAgents === false`, or when `core."apiKey"` is
     missing/foreign/revoked or `destination.canBeAssignedToApiKeys === false`,
     or when post-flush trigger corruption mutates `core."roleTarget"`,
     `core.role`, `core.agent`, `core."apiKey"`, or `core.application`.
