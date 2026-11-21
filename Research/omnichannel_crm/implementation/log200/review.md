# LOG-200 Code Review

Date: 2026-11-21
Scope: Independent review of `LOG-200` (`ShareWithService.insertRecordSharesForCreatedRecords` and `WorkflowRunRecordShareService` transactional `recordShare` audit)
Verdict: **PASS** (after fixing 1 Blocker, 3 Majors, and 4 Minors)

## Summary of Independent Findings and Resolutions

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| B-1 | Blocker | Inside `withNativeCrmAuditTransaction` (Branch A of `ShareWithService`), `WorkspaceRepository.insert`/`delete` on system object `recordShare` called `getNativeCrmAuditContext(executor)` and `assertNativeCrmAuditWriteSupported(...)`, which rejected system object `recordShare` when executing inside a real native-audited `createMany` transaction. | Added `delegatedRecordShareExecutors` WeakSet, `isDelegatedRecordShareAuditWrite(executor, objectMetadataNameSingular)`, and `runDelegatedRecordShareWrite` callback from `runInNativeCrmAuditScopeIfPresent` in `native-crm-audit-transaction.ts`; updated `getNativeCrmAuditContext(executor, objectMetadataNameSingular?)` to return `undefined` only during delegated `recordShare` writes; passed `metadata.nameSingular` (only when `shape.tableName === 'recordShare'`) in `native-crm-audit-record.ts:172` and `this.options.flatObjectMetadata.nameSingular` at all 12 call sites in `workspace-repository.ts`; wrapped Branch A `execute()` in `runDelegatedRecordShareWrite`. Other system objects remain rejected. |
| M-1 | Major | Ambient ALS principal/initiator consistency gaps: (1) `resolveShareWithStandaloneOperation` did not reject OAuth-user `initiator` on `application` or any `initiator` on `apiKey`, nor verify `application` `initiator` matches `appId` when `actor.kind === 'agent'`; (2) Branch A only checked ambient ALS for `authContext.type === 'user'` (and one-way `initiator`), skipping `application`/`apiKey`. | Hardened `resolveShareWithStandaloneOperation` to enforce exact `actor` + `initiator` invariants for `application`, `actingAgent`, and `apiKey`. Extended Branch A (`runAuditedShareWithInsert`) to enforce two-way `initiator` equality for `user` and run the full ambient consistency check for `application` and `apiKey` as well. |
| M-2 | Major | `runAuditedWorkflowRunShareSync` locked `core.workspace` with `FOR NO KEY UPDATE` (`verifyWorkspaceActive(..., true)`), unnecessarily serializing concurrent workflow run share syncs in the same workspace. | Switched `runAuditedWorkflowRunShareSync` to `verifyWorkspaceKeyShare(executor, validated.workspaceId)` (`FOR KEY SHARE`), matching `ShareWithService` while keeping post-flush active verification. |
| M-3 | Major | Test suite lacked coverage for real `assertNativeCrmAuditWriteSupported` + `getNativeCrmAuditContext` inside Branch A, `system` authContext, two standalone `ShareWithService` calls sharing `correlationId`, `pendingActivationUser` fail-closed, Branch A error latching via `runNativeCrmAuditWrite`, and standalone `ShareWithService` rollback on flush failure / post-flush drift. | Expanded `crm-audit-record-share-writers.postgres-spec.ts` to cover all of the above plus M-1, m-1, m-3, and m-4 invariants against real PostgreSQL 17. |
| m-1 | Minor | `withNativeCrmAuditTransaction` did not reject a `scope` already registered in `standaloneShareWithScopes`. | Added `|| standaloneShareWithScopes.has(scope)` to the conflict guard in `native-crm-audit-transaction.ts`. |
| m-2 | Minor | Branch A of `runAuditedShareWithInsert` did not set `SET LOCAL lock_timeout = '8s'` before acquiring `FOR KEY SHARE` / `FOR UPDATE`. | Added `await executor.query("SET LOCAL lock_timeout = '8s'")` before `verifyWorkspaceKeyShare` in Branch A. |
| m-3 | Minor | `validateWorkflowRunShareSyncAuditInput` allowed `auditImpersonatorUserWorkspaceId` alongside non-user actors (`system`, `apiKey`, `application`). | Added explicit rejection when `auditImpersonatorUserWorkspaceId` is paired with an actor other than `coreUser` or `workspaceMember`. |
| m-4 | Minor | `runAuditedWorkflowRunShareSync` did not validate before `execute()` that every row in `desiredShares` satisfies `isManagedWorkflowRunShare`, allowing an unmanaged desired share to reach `execute()` before failing on post-check. | Added pre-`execute()` validation over `expectedByUniqueKey.values()` rejecting any unmanaged desired grant fail-closed before calling `execute()`. |

## Post-Fix Verification

- Enterprise dependency guard (`check_enterprise_dependencies.py --verify-baseline`): `pass` (`0` violations across `34806` code files / `21464` runtime files / `137701` edges).
- Fork migration source guard (`check_fork_migration_sources.py` locally and on Schrodinger): `Verified 10 fork migration source(s)`.
- Python guard unit tests (`scripts/omnichannel/test_*.py`): `33/33` PASS.
- Targeted PostgreSQL suites (6 suites including `crm-audit-record-share-writers.postgres-spec.ts` and `crm-audit-public-update.postgres-spec.ts`): `6/6` suites, `166/166` tests PASS (`31.274s`).
- Differential TypeScript typecheck: `pass-no-new-diagnostics` (`509` root files, baseline `283`, current `275`, `0` new diagnostics, `0` changed-code diagnostics).
- Full PostgreSQL regression suite and SHA-256 snapshot verification: recorded in `results.json` and `regression.log`.
