# LOG114 — membership cleanup transaction and durable workflow reconciliation

Status: scoped checks passed; see results.json. ROB765 remains In Progress.

## Source findings and decision

`UserWorkspaceService.deleteUserWorkspace` deletes role targets and membership in
separate statements; membership criteria omit workspaceId. Workflow creator FKs
become NULL on deletion. A failure after deletion loses the original workflow IDs
on retry. Public removal also transfers ownership and deletes the native member
before this method; this change must not claim atomicity of that whole operation.

Use the existing strict core transaction owner, the same workspace fence as public
role assignment, and a membership row lock. Preserve soft-delete semantics and
TypeORM entity operations. Persist workflow reconciliation intents before deletion
in the existing deferred-action table through the same query runner. Keep immediate
share reconciliation after confirmed commit; durable intents allow replay after
crash, lost commit acknowledgement, or queue/share failure. The handler recomputes
current permissions with the existing workflow share service.

Alternatives rejected: a transaction without durable intents still loses workflow
IDs; a new queue/table duplicates the existing persisted deferred-action mechanism.
No new migration or background process is required. The new action is not gated by
the metadata deferred-actions feature flag and never uses best-effort in-process
execution. Existing recovery retries and FAILED/manual-retry semantics apply.

## Verification planned

- Real PostgreSQL hard/soft deletion, workspace isolation, targets and membership
  rollback together; deferred intent rollback on failure.
- Concurrent assignment/deletion uses the same workspace lock; legacy bulk writers
  and the earlier public native-member removal remain outside this guarantee.
- Lost COMMIT acknowledgement preserves committed intent, without rollback/retry.
- Immediate share failure and Redis failure leave recovery evidence in the DB;
  replay uses current workflow state and is safe when workflow/workspace is gone.
- Existing runner persistence/recovery and registered handler exercised with mocks
  limited to dependencies; broader regression, guards, differential types and source
  hashes before publication.

Audit of membership/FK side effects, public removal ownership, global last-admin
fencing and full runtime/HTTP acceptance remain subsequent work. This slice is a
reliability prerequisite, not completion of the employee lifecycle or ROB765.

## Implemented boundaries and review

Core cleanup locks workspace and membership, scopes both entity operations, verifies
hard/soft postconditions and durable-intent identity before commit. Silent skipped
DELETE/UPDATE/INSERT and rewritten/erased intent cause rollback. Fresh role assignment
and cleanup are tested concurrently in both orders using the real assignment owner.

The handler recomputes through `WorkflowRunRecordShareService`; it skips a missing
workflow or a workspace already marked for deletion. Teardown membership cleanup
does not create intents. Existing persisted worker execution, recovery scan, retry
limit and explicit FAILED/manual retry are reused. Reconciliation is at-least-once,
not exactly-once; successful jobs are removed and do not replace audit history.

The dependency guard initially rejected new broad metadata imports. The final code
keeps entity classes in the existing service, accepts structural entity targets in
the transaction helper, separates the leaf action-name type, and injects a narrow
share-service port. The handler lives in the existing workflow-share module; discovery
adds only that exact class to the existing allowlist. A small Nest application checks
actual module provider metadata, alias injection and real registry lookup. Enqueue
logic is shared with the existing runner without changing retry/deduplication settings.
No Enterprise guard/baseline or feature flag was weakened.

Read-only reviewer found missing write postconditions; these are fixed with negative
PostgreSQL regressions. A second pass verified module/worker availability, queue token
and discovery boundaries. Self-review added final durable-intent readback after DELETE.

The fixture uses real PostgreSQL, TypeORM deletes, strict transaction owner, actual
UserWorkspaceService method, deferred persistence/runner/recovery, handler and Nest
registration. Native share replacements themselves are a spy, and transport/registry
dependencies are adapters. Full HTTP removal, ownership transfers, native member
deletion and audit of all membership FK effects are not accepted by these tests.
The last built/deployed candidate remains LOG088; this slice is not deployed.

1191 tests/37 suites PASS (203.747s); 78 targeted/2 suites PASS, 39 новых cases. 26 guards PASS; 10 migration checksums неизменны. Types 355/360 roots, 188/188 прежних диагностик, 0 новых/changed-code. 12 local/remote source hashes совпадают.

Full-server typecheck не чистый. [Результаты](results.json), [review](review.md), [следующая граница](next-boundary.md).
