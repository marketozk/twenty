# LOG-204 - ALS attribution propagation for public native CRM mutations and `record-crud` unknown-outcome propagation

## Scope
Closes two cross-cutting public CRM audit gaps under `ROB-765`:
1. Ambient ALS attribution propagation (`impersonatorUserWorkspaceId` -> `initiator`, `correlationId`, `causationId`, `viaApplication`/`application`/`agentId`, `actingAgent` -> `initiator: application`, and `system` trace) across all public native CRM mutations (`CREATE_ONE`, `CREATE_MANY`, `UPDATE_ONE`, `UPDATE_MANY`, `DELETE_ONE`, `DELETE_MANY`, `RESTORE_ONE`, `RESTORE_MANY`, `DESTROY_ONE`, `DESTROY_MANY`, `MERGE_MANY`) and Branch A `ShareWithService`.
2. Propagation of `NativeTransactionOutcomeUnknownError` without masking as `{ success: false }` across all 7 remaining mutating `record-crud` services (`CreateRecordService`, `CreateManyRecordsService`, `UpdateRecordService`, `UpdateManyRecordsService`, `DeleteManyRecordsService`, `UpsertRecordService`, `UpsertManyRecordsService`).

## Changed Files
- `packages/twenty-server/src/engine/core-modules/crm-audit/membership-cleanup-identity.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-attribution-context.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-transaction.ts`
- `packages/twenty-server/src/engine/twenty-orm/datasource/workspace-data-source.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/record-share-audit.ts`
- `packages/twenty-server/src/engine/core-modules/record-crud/services/create-record.service.ts`
- `packages/twenty-server/src/engine/core-modules/record-crud/services/create-many-records.service.ts`
- `packages/twenty-server/src/engine/core-modules/record-crud/services/update-record.service.ts`
- `packages/twenty-server/src/engine/core-modules/record-crud/services/update-many-records.service.ts`
- `packages/twenty-server/src/engine/core-modules/record-crud/services/delete-many-records.service.ts`
- `packages/twenty-server/src/engine/core-modules/record-crud/services/upsert-record.service.ts`
- `packages/twenty-server/src/engine/core-modules/record-crud/services/upsert-many-records.service.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-public-attribution-and-crud.postgres-spec.ts`

## Artifacts
- [design.md](design.md)
- [design-review.md](design-review.md)
- [test-research.md](test-research.md)
- [review.md](review.md)
- [results.json](results.json)
- [source-snapshot.json](source-snapshot.json)
- [next-boundary.md](next-boundary.md)
