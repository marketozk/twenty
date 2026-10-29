# LOG122 — connected-account ownership transfer audit

The existing transfer method now owns its final database mutation through the
strict core audit transaction adapter. It retains the native ownership fence,
checks the active workspace and both same-workspace memberships under locks, then
locks accounts and current message/calendar channels before snapshots and writes.
The ordinary/omni ownership refusal stays in the same transaction.

Actual postconditions include the captured destination, cleared credentials,
preserved-or-new archive date, disabled channel synchronization and expiration of
pending subscriptions. All other account/channel fields must stay unchanged.
Memberships and actual effects are checked again before and after journal writes.
Audit failure rolls back only its savepoint, preserving credential revocation;
mandatory mutation corruption aborts the owner.

The two production removal callers forward trusted attribution through the
custodian service. IDs and attribution are copied before awaits. Each transfer
gets a distinct operation id while preserving actor/initiator/correlation. New
catalog entries use administrative access and credential-presence booleans, never
tokens, connection parameters, handles or provider claims.

Postcondition equality uses exact PostgreSQL JSONB text, including numeric values
above 2^53; parsed JavaScript values are not the authority for unchanged fields.
Unchanged semantic channel snapshots do not create empty audit entries.

Verification: [results](results.json), [review](review.md),
[source hashes](source-snapshot.json). Real PostgreSQL tests exercise the actual
metadata service. API/custodian orchestration tests use explicit DI adapters and
do not establish full HTTP acceptance.

Webhook stopping remains before the database owner; OAuth revoke remains after a
known commit. Unknown commit does not retry or invoke the later revoke. External
revocation failure can still follow a successful database transfer; no new durable
external reconciliation guarantee is claimed. No production deployment or Actions.

Continue with [connected-account disconnection](next-boundary.md).
