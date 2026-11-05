# LOG156 independent owner implementation review

Reviewed the audited role deletion and agent/API-key role assignment
implementation (`crm-audit-transaction-context.ts`, `role-update-audit.ts`,
`role-assignment-audit.ts`, `WorkspaceMigrationRunnerService`, `RoleService`,
`RoleResolver`, `DeleteRoleTool`, `AiAgentRoleService`, `ApiKeyRoleService`,
and `ApiKeyResolver`), Enterprise dependency isolation, unit tool tests, and
PostgreSQL integration test suites against
`Research/omnichannel_crm/implementation/log156/design.md` and
`Research/omnichannel_crm/implementation/log156/design-review.md`. No source or
runtime files were modified during this review.

## Verdict

No remaining blocking defects, race conditions, SQL injection or authority
bypass vectors, or Enterprise dependency violations were identified in the
inspected working tree changes:

- `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/role-update-audit.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/role-assignment-audit.ts`
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service.ts`
- `packages/twenty-server/src/engine/metadata-modules/role/role.service.ts`
- `packages/twenty-server/src/engine/metadata-modules/role/role.resolver.ts`
- `packages/twenty-server/src/engine/metadata-modules/role/tools/delete-role.tool.ts`
- `packages/twenty-server/src/engine/metadata-modules/role/tools/__tests__/role-tools.spec.ts`
- `packages/twenty-server/src/engine/metadata-modules/ai/ai-agent-role/ai-agent-role.service.ts`
- `packages/twenty-server/src/engine/core-modules/api-key/services/api-key-role.service.ts`
- `packages/twenty-server/src/engine/core-modules/api-key/api-key.resolver.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-role-delete-and-targets.postgres-spec.ts`

All three implementation refinements raised in `design-review.md` and all four
review check items are accurately implemented.

## Verification of design-review.md findings and review checks

1. **Strict Enterprise dependency isolation (`scripts/omnichannel/check_enterprise_dependencies.py`):**
   Running `scripts/omnichannel/check_enterprise_dependencies.py --verify-baseline`
   reports `"status": "pass"` with zero violations (`{}`). All LOG156 modules
   import only OSS runtime/audit/metadata modules and project request auth
   fields structurally via `roleAuditIdentityFromRequest` without importing
   Enterprise-reachable auth or billing graphs.
2. **`runAuditedRoleDelete` (`role-update-audit.ts`) locking, target rebind verification, caller lockout, atomic audit, and post-flush verification:**
   - Resolves `application`, `deletedRoleUniversalIdentifier -> request.roleId`,
     `plannedTargetDeletes` (`mappings.targets`), and `plannedTargetCreates`
     (`mappings.roles` and `mappings.agents`) before `await work(runner)` mutates
     `allFlatEntityMaps` in place, rejecting duplicate target action IDs or
     universal identifiers and requiring exactly one `role` `delete` plus
     bounded `roleTarget` `delete`/`create` actions.
   - Inside `runInCoreAuditTransaction` with `SET LOCAL lock_timeout = '8s'`:
     - Locks `core.workspace` `FOR NO KEY UPDATE`, verifying `deletedAt === null`,
       valid UUID `defaultRoleId !== request.roleId`, and that every planned
       replacement `roleTarget` points to `defaultRoleId`.
     - Locks `core.application` `FOR SHARE` via `verifyRoleAuditApplication`,
       verifying workspace ownership, `universalIdentifier`, and
       `deletedAt === null`.
     - Locks `core.role` rows for `[request.roleId, defaultRoleId]`
       (`ORDER BY id FOR UPDATE`), verifying both exist, `beforeRole` matches
       `deletedRoleUniversalIdentifier`, has `isEditable === true`, and is
       neither the standard Admin role nor the standard Member role.
     - Enforces caller lockout under DB locks by rejecting if
       `request.actingRoleIds?.includes(request.roleId)` or if
       `request.actingUserWorkspaceId` has any live `core."roleTarget"` row for
       `request.roleId` (`FOR SHARE`).
     - Locks all `core."roleTarget"` rows matching
       `"workspaceId"=$1 AND ("roleId"=$2 OR id=ANY($3::uuid[]))`
       (`ORDER BY id FOR UPDATE`) and verifies an exact 1-to-1 match with
       `plannedTargetDeletes` so `ON DELETE CASCADE` on `core."roleTarget"."roleId"`
       cannot silently delete an unplanned or unaudited `roleTarget` row.
     - Locks referenced `core."userWorkspace"`, `core."apiKey"`, and
       `core.agent` rows (`ORDER BY id FOR SHARE`), verifying all referenced
       owners exist in the workspace and checking target rebind rules:
       all referenced `userWorkspaceId` targets (`defaultRole.canBeAssignedToUsers === true`),
       all `apiKeyId` targets with `revokedAt === null`
       (`defaultRole.canBeAssignedToApiKeys === true`), and all `agentId`
       targets with `deletedAt === null`
       (`defaultRole.canBeAssignedToAgents === true` and matching
       `agentUniversalIdentifier`) must be rebound to `defaultRoleId`, while
       revoked API keys (`revokedAt !== null`) and soft-deleted agents
       (`deletedAt !== null`) are not rebound.
     - Executes `await work(runner)`, verifies `request.roleId` is absent from
       `core.role`, all deleted `roleTarget` rows are absent from
       `core."roleTarget"`, and all created `roleTarget` rows match the planned
       scalar fields and microsecond `createdAt`/`updatedAt` timestamps.
     - Records `roleTarget` (`delete` and `create`) and `role` (`delete`, with
       `label`, `description`, and `icon` redacted) audit entries in
       `CrmAuditTransactionContext`, flushes before `COMMIT`, and re-verifies
       that deleted rows did not reappear and `defaultRole`, created
       `roleTarget` rows, locked target owners, and `core.application` did not
       drift during flush.
3. **`runAuditedRoleAssignment` (`role-assignment-audit.ts`) locking, target verification, atomic audit, and post-flush verification:**
   - Supports `targetKind: 'userWorkspace' | 'agent' | 'apiKey'` and
     `mode: 'assign' | 'remove'`, rejecting nested or conflicting role mutation
     and assignment audit scopes.
   - On `mode === 'remove'` (`targetKind === 'agent'`):
     - Requires a single `roleTarget` `delete` action resolving via
       `mappings.targets` to `request.roleTargetId`.
     - Inside `runInCoreAuditTransaction`: locks `core.workspace`
       (`FOR NO KEY UPDATE`), `core.application` (`FOR SHARE`), `core.agent`
       (`FOR SHARE`, verifying `deletedAt === null`), `core."roleTarget"`
       (`WHERE "workspaceId"=$1 AND "agentId"=$2 FOR UPDATE`, verifying single
       row matching `request.roleTargetId`, `deletedUniversalIdentifier`, and
       null `userWorkspaceId`/`apiKeyId`), and source `core.role` (`FOR SHARE`).
     - Executes `await work(runner)`, verifies the `roleTarget` row is removed,
       records a `roleTarget` `delete` audit entry with
       `before: { roleId, agentId }` and `after: null`, flushes, and re-verifies
       post-flush target absence, role snapshot, agent snapshot, and
       application ownership.
   - On `mode === 'assign'` (`'userWorkspace'`, `'agent'`, `'apiKey'`):
     - Requires one `roleTarget` `create` action (and at most one preceding
       `roleTarget` `delete` action), resolving role and agent universal
       identifiers from `mappings` before `await work(runner)` runs.
     - Inside `runInCoreAuditTransaction`: locks `core.workspace`
       (`FOR NO KEY UPDATE`), `core.application` (`FOR SHARE`), and the target
       owner (`core."userWorkspace"` + workspace `"workspaceMember"` `FOR SHARE`
       for `'userWorkspace'`, `core.agent` `FOR SHARE` with `deletedAt === null`
       and matching `universalIdentifier` for `'agent'`, or `core."apiKey"`
       `FOR SHARE` with `revokedAt === null` for `'apiKey'`).
     - Locks `core."roleTarget"` (`WHERE "workspaceId"=$1 AND ${targetColumn}=$2 FOR UPDATE`),
       verifies the existing row matches `deletes`, locks `core.role`
       (`ORDER BY id FOR SHARE`), verifies `destination[assignabilityColumn] === true`
       (`canBeAssignedToUsers`, `canBeAssignedToAgents`, or
       `canBeAssignedToApiKeys`), and preserves self-role-change and last-admin
       protection for `'userWorkspace'`.
     - Executes `await work(runner)`, verifies post-work `core."roleTarget"`
       scalar fields and microsecond `createdAt`/`updatedAt` timestamps and old
       target deletion, records `roleTarget` `delete` (when replacing) and
       `create` audit entries (`{ roleId, userWorkspaceId }`,
       `{ roleId, agentId }`, or `{ roleId, apiKeyId }`), flushes, and
       re-verifies post-flush `roleTarget`, `role`, target owner, and
       application state.
4. **Pre-`await` capture and validation of `auditIdentity` across all entrypoints:**
   - `RoleResolver.deleteOneRole` captures
     `const auditIdentity = roleAuditIdentityFromRequest(context.req)` before
     `await this.getActingRoleIds(...)`.
   - `DeleteRoleTool.execute` constructs `auditIdentity: { auth: context.authContext!, agentId: context.agentId }`
     and computes `actingRoleIds` synchronously before calling
     `this.roleService.deleteRole(...)`.
   - `RoleService.deleteRole` captures scalar arguments and clones
     `actingRoleIds` synchronously, then immediately invokes
     `withRoleDeleteAudit`, which validates `actingRoleIds`,
     `actingUserWorkspaceId`, `roleId`, `workspaceId`, and
     `captureRoleAuditOperation(workspaceId, identity)` synchronously before the
     first `await` (`this.deleteManyRoles`).
   - `RoleResolver.assignRoleToAgent`, `RoleResolver.removeRoleFromAgent`, and
     `ApiKeyResolver.assignRoleToApiKey` evaluate
     `roleAuditIdentityFromRequest(context.req)` synchronously before calling
     their service methods.
   - `AiAgentRoleService.assignRoleToAgent` checks
     `Object.hasOwn(args, 'auditIdentity') || args.auditIdentity !== undefined`
     and runs `captureRoleAuditIdentity` + `captureRoleAuditOperation`
     synchronously before `await this.validateAssignRoleInput(...)` (preserving
     internal workflow step duplication when `auditIdentity` is omitted while
     rejecting `auditIdentity: undefined`).
   - `AiAgentRoleService.removeRoleFromAgent` and
     `ApiKeyRoleService.assignRoleToApiKey` capture scalar inputs and run
     `captureRoleAuditIdentity` + `captureRoleAuditOperation` synchronously
     before their first `await`.

## Security, transactional integrity and test coverage checks

1. **SQL injection and identifier safety:**
   All SQL queries in `role-update-audit.ts` and `role-assignment-audit.ts` use
   parameterized placeholders (`$1..$N`), strict UUID validation (`isUUID`),
   fixed column whitelists (`"userWorkspaceId"`, `"agentId"`, `"apiKeyId"`), and
   `dataSource.driver.escape(workspace.databaseSchema)` for workspace member
   schema qualification.
2. **Pre-commit drift and lost-ACK protection:**
   Both `runAuditedRoleDelete` and `runAuditedRoleAssignment` re-verify locked
   role, roleTarget, target owner, and application snapshots after
   `audit.flush()` and before `COMMIT`, and `WorkspaceMigrationRunnerService`
   always invalidates `rolesPermissions` and flat entity caches in `finally`
   even if the `COMMIT` acknowledgement is lost.
3. **Unit and PostgreSQL integration test coverage:**
   - `role-tools.spec.ts` verifies that `DeleteRoleTool` forwards `roleId`,
     `workspaceId`, `actingUserWorkspaceId`, `auditIdentity`, and
     `actingRoleIds` to `RoleService.deleteRole`.
   - `crm-audit-role-delete-and-targets.postgres-spec.ts` verifies against real
     PostgreSQL: role deletion with active member/agent/API-key rebind and
     revoked/soft-deleted target skipping, redaction of role `label` and
     `description`, rejection of non-editable/admin/default/caller-locked/unplanned
     deletes, full rollback on audit/handler/SQL/deferred/trigger failures,
     commit preservation and cache invalidation on lost `COMMIT` ACK, and
     audited agent and API-key role assignment, replacement, same-role no-op,
     removal, and DB-locked target/assignability rejection.
