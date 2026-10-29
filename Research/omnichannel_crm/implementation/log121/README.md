# LOG121 — private native member deletion audit

`UserService.removeUserFromWorkspaceAndPotentiallyDeleteWorkspace` now deletes the
exact captured native member id/user inside an issued strict workspace transaction
with exclusive native ownership lock. Its captured LOG117 identity is copied; the
native owner receives a distinct operation id and keeps the common correlation.

The private helper validates standard metadata identity and follows actual database
FKs. It locks and rereads children before collecting known CASCADE and SET NULL
effects, including the transitive agent thread/message/turn/part/reaction/attachment
graph. Snapshots use existing field metadata IDs, numeric precision and value
redaction. The ordinary public audit object predicate is unchanged.

Mandatory before/after checks are outside the journal savepoint. Journal failure
rolls back only audit writes and checks actual effects again; deletion survives.
Actual deletion corruption aborts the transaction. Lost COMMIT acknowledgement is
reported as unknown without retry or confirmed-success callbacks. Missing identity
produces an explicit unavailable-audit log rather than inventing an actor.

The audit helper uses a structural scope and metadata projection registered by the
existing WorkspaceDataSource capability owner. This avoids a new dependency on the
full ORM/Enterprise graph; the dependency baseline is unchanged.

Verification: [results](results.json), [review](review.md),
[source hashes](source-snapshot.json). New PostgreSQL cases cover the standard FK
graph, mixed-path transitive UPDATE rejection, actual triggers, issued scope,
identity, actual FK waits in both orders and unknown commit. Existing orchestration
tests use adapters; this is not a full HTTP or entire removal transaction test.

Physical file cleanup, connected-account/share transfers, later history cleanup,
whole-request revocation and atomicity across all removal owners remain separate.
No production deployment, customer messages or GitHub Actions.

Continue with [connected-account ownership transfer](next-boundary.md).
