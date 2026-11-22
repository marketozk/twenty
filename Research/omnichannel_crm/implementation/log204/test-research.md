# LOG-204 Test Research

## New PostgreSQL Test Suite
`packages/twenty-server/test/fork-migration/crm-audit-public-attribution-and-crud.postgres-spec.ts`

Built on the real PostgreSQL 17 harness (`createOmniNativeMessageFixture` with `coreSchema: 'fork'` + provisioned `core."userWorkspace"` table and `GRANT SELECT` to `f.roleName`), covering:

1. **ALS `correlationId`, `causationId`, impersonation (same-workspace and cross-workspace server-level admin), `viaApplication` / `application` delegation, `actingAgent` -> `initiator: application`, `application + req.agentId`, `apiKey`, and `system` (including unauthenticated and workspace-less requests) across public CRM mutations (`CREATE_ONE`, `UPDATE_ONE`, `DESTROY_ONE`, `MERGE_MANY`) and `ShareWithService` Branch A**:
   - Regular user request inside `withCrmAuditRequest`: `actor: workspaceMember`, `initiator: null`, request `correlationId`.
   - Same-workspace and cross-workspace server-level impersonated user request (`impersonationContext: { impersonatorUserWorkspaceId }` backed by real `core."userWorkspace"` row): `actor: workspaceMember`, `initiator: { kind: 'coreUser', id: impersonatorUserId }`, request `correlationId`.
   - Missing or soft-deleted `core."userWorkspace"` row for `impersonatorUserWorkspaceId`: fails closed (`'Native audit impersonation initiator unavailable'`), rolls back mutation, `0` audit rows.
   - `user` auth with `viaApplication` (and `application`): `actor: { kind: 'application', id: appId }`, `initiator: { kind: 'workspaceMember', id: memberId }`, request `correlationId`.
   - `application` auth with `actingAgent`: `actor: { kind: 'agent', id: agentId }`, `initiator: { kind: 'application', id: appId }`, request `correlationId`.
   - `application` auth with `req.agentId` (no `actingAgent`): `actor: { kind: 'application', id: appId }`, `initiator: null`, request `correlationId`.
   - `apiKey` auth inside `withCrmAuditRequest`: `actor: { kind: 'apiKey', id }`, `initiator: null`, request `correlationId`.
   - `system` auth inside `withCrmAuditIdentity` (`correlationId` + `causationId`), inside unauthenticated `withCrmAuditRequest({ workspace })`, and inside workspace-less `withCrmAuditRequest({})`: succeeds with `actor: { kind: 'system', id: 'crm-api-update' }`, `initiator: null`, inheriting `correlationId`/`causationId` without failing on missing human principal; rejects cross-workspace `withCrmAuditRequest({ workspace: otherWs })`.
   - Branch A `runAuditedShareWithInsert` inside `withNativeCrmAuditTransaction` under impersonation, `viaApplication`, and `application + req.agentId`: company + `recordShare` entries share ONE `operationId`, matching `actor`, `initiator`, and `correlationId`.

2. **Fail-closed ALS conflict detection & nested scope poisoning**:
   - Workspace mismatch in ALS -> rejects before mutation (`0` audit rows).
   - App-only ALS + plain `user` auth (M2), app+agent-only ALS + plain `user` auth (M2), ambient user/apiKey/application/agent/principal mismatch -> rejects before mutation (`0` audit rows).
   - Conflicting `auth.application` vs `auth.viaApplication`, empty `auth.user.id: ''`, `auth.agentId` without `application` on `user`, impersonation combined with `viaApplication` or non-user `auth` -> rejects.
   - Nested public mutation inside proven outer `withNativeCrmAuditTransaction` when ALS switches to a different impersonator, different `correlationId`, newly added ALS over uncorrelated scope, or masked ALS (`withCrmAuditIdentity(ws, undefined)`) inside ALS-correlated scope -> fails closed and poisons/rolls back entire outer transaction (`0` audit rows, DB unchanged); explicit `options.correlationId` outside ALS still allows nested calls without ALS (M3).

3. **`NativeTransactionOutcomeUnknownError` propagation across all 7 remaining mutating `record-crud` services**:
   - Exercises real lost `COMMIT` ACK through PostgreSQL 17 on all 7 services (`CreateRecordService`, `CreateManyRecordsService`, `UpdateRecordService`, `UpdateManyRecordsService`, `DeleteManyRecordsService`, `UpsertRecordService`, `UpsertManyRecordsService`), verifying each rethrows `NativeTransactionOutcomeUnknownError` instead of returning `{ success: false }`, issues exactly 1 `COMMIT` and 0 `ROLLBACK`, preserves committed DB + audit rows, and skips events/post-query hooks.

## Existing Suites to Verify
- `test/fork-migration/crm-audit-native-company.postgres-spec.ts`
- `test/fork-migration/crm-audit-public-update.postgres-spec.ts`
- `test/fork-migration/crm-audit-public-destroy.postgres-spec.ts`
- `test/fork-migration/crm-audit-public-merge.postgres-spec.ts`
- `test/fork-migration/crm-audit-record-share-writers.postgres-spec.ts`
- `test/fork-migration/crm-audit-role-update.postgres-spec.ts`
- Full PostgreSQL regression suite on Schrodinger.
