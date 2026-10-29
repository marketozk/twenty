# LOG130 — native channel association cleanup

The actual channel-deletion job now supplies a captured, named system operation.
Its first cleanup stage uses the original issued strict/exclusive workspace scope.
The owner checks the active workspace and absent core channel, locks the native
association/folder-junction graph, checks retained ownership and actual incoming
foreign keys, and records actual DELETE RETURNING effects in the same transaction.
The ordinary orphan sweep remains a separate, not-yet-audited stage.

Independent review found two missing final checks: ownership could appear inside a
DELETE/audit trigger, and a delayed job could reach a soft-deleted workspace through
cached metadata. The owner now locks the active workspace and rechecks its state,
retained ownership and exact remaining graph both before and after audit flush.

The original draft suppressed native events. This was removed: existing events
are queued until commit. Review also found that the repository filtered deleted
event IDs by actual RETURNING only when its generic native audit context existed.
Hard-delete now always obtains an internal returned ID, emits only actual effects,
and removes that internal field from results when the caller did not request it.
This preserves caller-selected return columns, including an empty selection.

Soft-deleted root associations remain untouched, matching the former repository
find behavior. They still participate in locked snapshots and graph verification.
No new generic messaging audit allowlist or native-write bypass grant is introduced.
The structural scope port avoids importing the entire repository graph into the
audit primitive; issuance still checks the original scope identity.

While researching the next orphan stage, review found a real metadata relation
missing from the association TypeScript entity: messageThreadId. The shared native
ownership helper checked only messageId/channelId, so a direct reference to a
protected conversation could be missed. It now checks that thread ID and selects
it when checking a junction through its association. A null-message association
pointing to a protected thread is covered explicitly; the production entity is
not expanded merely to make this internal guard work.

The FK race guarantee depends on the actual association→junction constraint.
The owner now requires that exact CASCADE edge, not just the absence of unknown
populated edges. Tests remove the real constraint with and without an existing
child and require refusal, then restore its exact PostgreSQL definition. This
prevents accepting a drifted schema where parent locks cannot fence child inserts.

WorkspaceDataSource intentionally logs ordinary after-commit callback failures and
preserves the committed result. This existing contract is retained and tested,
including committed journal visibility and no events after rollback. It does not
make event delivery durable or await asynchronous EventEmitter2 listeners.

Initial PostgreSQL tests stopped at the new workspace lock: the isolated cleanup
fixture granted SELECT but lacked the UPDATE privilege required for a row lock.
The fixture now grants a single-column UPDATE privilege; application privileges
and append-only audit protections are unchanged. Initial failure evidence is kept
separately from the final run.

The next targeted run exposed a diagnostic bug: comparing a newly non-null
PostgreSQL Date through canonicalAuditJson produced its generic JSON error.
Workspace verification now directly checks the captured ID and null deletedAt;
the regression confirms the intended lifecycle refusal and full rollback.

Verification results are recorded in results.json after completion. No full HTTP,
image build, production deployment or customer messaging is claimed by this slice.

The initial typecheck found two test-only return-type errors: the fixture context
can be synchronous, while the race helper required a Promise. The cleanup test
wrapper is now explicitly async. Final differential checking reports no new or
changed-file diagnostics; existing baseline diagnostics remain, so this is not a
clean full-server typecheck. Final regression includes the direct-thread and
missing-FK corrections; earlier runs are not substituted for the final snapshot.
