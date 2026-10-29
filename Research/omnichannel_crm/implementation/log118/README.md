# LOG118 — core account deactivation audit

Scoped implementation verified. ROB-765 remains In Progress. No deployment.

Three existing core.user softDelete callers now use a strict core transaction owner:
self-account deletion, conditional deactivation after removing one membership, and
workspace teardown. It locks the exact user, reads active memberships afresh, verifies
the actual soft-delete and immutable first after snapshot, and invalidates cache in
finally including unknown COMMIT. Already deleted/missing users are no-ops.

Audit uses trusted actor/initiator/correlation from LOG117 and a separate operation
for this separate transaction. Only deletion-field metadata is allowed in the journal,
not email/password or other user content. A journal failure rolls back its savepoint
without restoring access; actual mutation corruption rolls back the transaction.
Workspace-less users report missing audit scope explicitly, with no fabricated tenant.

Current checks: 52 tests/3 suites, including 22 new PostgreSQL cases and 2 new caller
cases. Real core user/audit SQL and lost COMMIT ACK are tested; resolver collaborators
in the existing root fixtures are adapters. No full HTTP/native-share acceptance.

Full regression: 1320 tests/43 suites PASS (209.159s). 26 guards PASS; 10 migration
checksums unchanged. Types: 357/359 roots, 189/189 existing diagnostics, zero new and
zero changed-file diagnostics; not a clean full-server typecheck. Eight uploaded
source hashes match. [Results](results.json), [review](review.md),
[next boundary](next-boundary.md).

This does not claim bilateral membership-creation/deactivation serialization:
UserWorkspaceService.create currently relies only on the FK. A creator can wait for
deactivation and then insert against an existing soft-deleted user. The next boundary
must lock/check active user in the same membership-creation transaction. No extra
final SELECT in this owner can repair that opposite ordering.
