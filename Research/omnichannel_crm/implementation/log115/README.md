# LOG115 — core membership audit owner

Status: scoped verification passed. 103 targeted tests / 3 suites, including 25 new
cases; 1216 regression tests / 38 suites (205.942s). 26 guards passed; 10 migration
checksums unchanged. Differential types: 351/353 roots, 188/188 prior diagnostics,
zero new or changed-code diagnostics. Five local/remote source hashes match.
Full-server typecheck is not clean. No phase acceptance or deployment claimed.
[Results](results.json), [source hashes](source-snapshot.json), [types](typecheck-differential.json).

The complete core FK inventory was read from the existing isolated native database,
not the demo: seven membership references (five CASCADE, two SET NULL), plus recursive
navigation folder CASCADE. This matches current entity definitions. RoleTarget deletion
is explicit, without a membership FK. No additional incoming FKs to the cascaded child
tables were present in that pinned test schema.

Implemented on the LOG114 transaction owner: validate/copy a trusted operation, capture
actual membership and fixed child effects under locks, collect navigation descendants
to a locked fixed point, perform the existing cleanup, verify actual effects and append
audit within a security-first savepoint. Audit failure must leave removal and durable
reconciliation intact, with an explicit error signal; unknown COMMIT never retries.
OTP/application values and credential hashes are excluded from audit snapshots.

This slice first supplies the transaction/audit primitive with explicit operation input.
The subsequent entry-point wiring captures request attribution before native removal,
resolves impersonation while membership still exists, uses coreUser for multi-workspace
self deletion and explicit system attribution for jobs/teardown. Until that wiring and
its checks pass, automatic membership audit is not claimed.

Alternatives rejected: separate audit transaction can lose correspondence with cleanup;
ordinary fail-closed audit can resurrect revoked access; calling the session-revoke
owner would describe DELETE as UPDATE and open another transaction. Existing strict
owner, append-only audit and session security-first savepoint patterns are reused.

Checks passed: fixed real FK effects, navigation descendants of another/NULL owner,
foreign workspace rejection, soft/no-op behavior, exact administrative descriptors,
secret exclusion, audit insert failure and late audit corruption, skipped writes,
unknown commit and recovery intent retention. Full public removal/transfers and global
last-admin fencing remain outside this bounded owner.

Known dependency scopes and actual effects are mandatory cleanup checks outside the
audit savepoints. Failure to read/verify those rows refuses unchecked deletion. The FK
coverage query runs in a later savepoint: schema drift makes journal coverage explicitly
unavailable, without releasing captured locks or skipping known scope/effect checks.
Only audit append is skipped in that case. Unknown FK effects are not claimed audited.
Journal INSERT/privilege/verification failures roll back only the journal savepoint;
membership removal and the existing reconciliation intent remain together. Failure is
reported as MEMBERSHIP_CLEANUP_AUDIT_UNAVAILABLE with the validated operation ID.

Read-only independent review found and corrected two issues before publication:
repeated soft-delete verification now pins the first post-cleanup snapshot (including
microsecond timestamps); unsupported FK coverage can no longer bypass known tenant
scope checks. Both fixes have negative PostgreSQL tests. Scope-read denial is also
tested separately from journal denial. See [review](review.md).

The new fixture uses real PostgreSQL FKs, the production strict transaction owner and
append-only audit runtime role. Its core tables/entity schemas and recovery-intent
adapter are synthetic. LOG114 tests separately exercise the actual service/deferred
runner; no full HTTP/bootstrap/native-share acceptance is inferred from these tests.
