# LOG-202 Test Research

## New PostgreSQL Test Suite
`packages/twenty-server/test/fork-migration/crm-audit-public-destroy.postgres-spec.ts`

Built on the real PostgreSQL 17 harness (`createOmniNativeMessageFixture` + `addCustomCrmMetadata` + `CommonDestroyOneQueryRunnerService` + `CommonDestroyManyQueryRunnerService` + `DeleteRecordService`), covering:

1. **Public `destroyOne` and `destroyMany` across covered standard (`company`, `person`, `opportunity`) and custom (`customCase`) objects**:
   - Destroys both live rows and already soft-deleted (`deletedAt IS NOT NULL`) rows.
   - Verifies actual physical deletion, `action: 'delete'`, `securityDescriptor: { resourceKind: 'crmRecord', resourceId, objectMetadataId, deletedRecord: { access: 'currentWorkspaceAdministration' } }`, redaction of private values, `actor` across `user`, `apiKey`, `application`, `actingAgent`, and `system` (`systemActorId: 'crm-api-destroy'`), `releaseRecordStock`, `managerPort.getRepository` never called, and post-query hooks invoked after commit.
   - Verifies `selectedFields` without `id` (`{ name: true }`) still audits and returns cleanly.
   - Verifies unmatched `destroyOne` throws `RECORD_NOT_FOUND` (`0` audit rows, no post-query hooks, no stock release with `quantity > 0`) and unmatched `destroyMany` returns `[]` (`0` audit rows, no stock release with `quantity > 0`).
   - Verifies `CommonDestroyOneQueryRunnerService.validate` rejects remote objects, missing `id`, and invalid UUIDs.

2. **Direct FK effects (`ON DELETE SET NULL` and `ON DELETE CASCADE`), `BEFORE DELETE` trigger skip, and fail-closed boundaries**:
   - `destroyOne` / `destroyMany` on `company` with direct `ON DELETE SET NULL` (`person` / `opportunity`) and `ON DELETE CASCADE` (`customCase`): commits parent `delete` + child `update`/`delete` under ONE `operationId`, and loads `ONE_TO_MANY` nested relations on the same transaction repository.
   - Refuses uncovered FK child table (`delete_child` with `CASCADE`/`SET NULL`/`RESTRICT`), non-empty `FILES` on parent or CASCADE child, and `OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND` protected parent before mutation with `0` audit rows and no post-query hooks.
   - `BEFORE DELETE` trigger returning `NULL`: `destroyOne` throws `RECORD_NOT_FOUND` (`0` audit, `0` events, no stock release with `quantity > 0`); `destroyMany` on 2 rows with 1 skipped deletes, returns, and audits only the 1 actually deleted row.

3. **RLS predicates, relation-traversal filters, nested relation reads, visibility restrictions, and inherited scope poisoning**:
   - `destroyMany` with relation-traversal filter (`filter: { company: { name: { eq: ... } } }` on `person`) exercises `hasRelationTraversal === true` + `addRowAccessCondition` and audits exact deleted rows.
   - Partial/denied RLS predicates: `destroyOne` on an RLS-hidden row throws `RECORD_NOT_FOUND` with `0` audit rows; `destroyMany` on 2 rows where RLS allows 1 deletes and audits only the 1 allowed row.
   - Inside an outer `withNativeCrmAuditTransaction` that updates `company.name = 'uncommitted parent'`, `destroyOne` on `person` with `selectedFields: { id: true, company: { id: true, name: true } }` reads `'uncommitted parent'` via `queryRunnerContext.repository` (without calling `managerPort.getRepository`), runs `CommonRecordVisibilityService.applyVisibilityRestrictions` on nested records, records both parent `update` and `person` `delete` under ONE `operationId`, and defers post-query hooks until outer commit.
   - Inherited scope fail-closed & poisoning: rejects unproven external `transactionScope`, `runInStandaloneShareWithScope`, shallow-copied `{ ...scope }`, expired scope, wrong actor/workspaceId (and poisons outer transaction when caller catches), `RECORD_NOT_FOUND` inside outer scope, and uncovered object (`task` works normally outside scope with `0` audit rows, fails closed and poisons inside proven outer scope).

4. **Permission denial, real audit INSERT failure rollback, lost `COMMIT` ACK, and `DeleteRecordService(soft: false)`**:
   - Permission denial (`canDestroyObjectRecords: false`) leaves DB unchanged with `0` audit rows and no events/hooks.
   - Trigger failure on `crm_audit."crmAuditEntry"` rolls back physical deletion completely, emits `0` events, skips `releaseRecordStock` and post-query hooks.
   - Simulated lost `COMMIT` ACK throws `NativeTransactionOutcomeUnknownError` without `ROLLBACK` or retry, leaves committed deletion + audit row intact, and skips post-query hooks / event emission - both directly on `CommonDestroyOneQueryRunnerService` and through `DeleteRecordService.execute({ soft: false })` (proving `DeleteRecordService` rethrows `NativeTransactionOutcomeUnknownError` instead of returning `{ success: false }`).

## Existing Suites to Verify
- `test/fork-migration/crm-audit-public-update.postgres-spec.ts`
- `test/fork-migration/crm-audit-native-delete.postgres-spec.ts`
- `test/fork-migration/crm-audit-delete-set-null.postgres-spec.ts`
- `test/fork-migration/omni-detached-parent-delete.postgres-spec.ts`
- Full PostgreSQL regression suite on Schrodinger.
