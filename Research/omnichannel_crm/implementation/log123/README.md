# LOG123 — connected-account disconnection audit

The sole production disconnection caller is ConnectedAccountResolver. It captures
server authentication and caller identifiers before awaits and preserves the
existing administration precheck. The metadata service also checks administration
before external effects, then repeats the existing rule against the fresh locked
account inside the final database owner. That owner locks the active workspace and
caller membership, account and current channels. An active transaction-bound
repository is refused before any provider effects.

The LOG122 owner now has two closed modes: transfer and disconnect. Existing
transfer behavior stays unchanged. Disconnect preserves the owner and original
archive date, clears credentials and authentication failures, disables channel
synchronization and expires pending subscriptions. Exact database text snapshots
check unchanged JSONB values and actual effects before and after journal writes.
Security-first savepoints preserve credential revocation if audit alone fails;
mandatory scope, permission and postcondition checks remain outside that fallback.

Authentication failure fields are redacted to changed-field names. Tokens,
parameters, provider diagnostics and claims are not copied into the audit log.
Delegated applications retain the human initiator. Server impersonation can cross
workspace boundaries: its initiating membership is resolved by its own ID.

The result is returned only after a confirmed commit. Provider hooks/revocation
and subscription cleanup already occur before the DB owner and cannot be rolled
back with it. Unknown commit raises the existing outcome-unknown error; it does
not automatically repeat provider work.

Tests use real PostgreSQL service/repository execution and separate explicit DI
adapters for resolver orchestration and ownership preflight. Neither those tests
nor rechecking existing PermissionsService establish full HTTP acceptance or a
global fence against concurrent role changes. No deployment or Actions.

Evidence: [results](results.json), [review](review.md),
[source snapshot](source-snapshot.json). Continue with [account deletion](next-boundary.md).
