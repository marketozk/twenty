# LOG127 — atomic deletion of connected accounts and their core graph

Adds a closed deleteConnectedAccountsWithAudit primitive for connectedAccount,
messageChannel, calendarChannel and messageFolder. It owns its PostgreSQL transaction,
locks the graph, checks actual FK references and retained omnichannel ownership, then
audits only the rows actually deleted. Audit failure rolls back deletion.

Partial/skipped DELETE, reparented children, extra children, changes after audit and
JSONB precision loss are checked using exact database snapshots. Account ownership
alone is insufficient: folders linked to protected messages from other channels also
refuse. Unknown populated mutating FK edges fail closed; supported cascade graph is
explicit. PostgreSQL table locks freeze FK DDL during inventory and deletion.

Returned values contain actual IDs and custodians only, after confirmed commit.
Fresh operation IDs prevent second deletions after recreation from being deduplicated.
Existing strict owner preserves unknown-commit and confirmed-postcommit error types.

This is the tested primitive, not production caller integration. No provider revokes,
webhooks or native cleanup events are performed here. Caller authorization, API wiring,
full HTTP and deployment remain open. ROB-765 stays In Progress; no GitHub Actions.

[Design](design.md), [review](review.md), [results](results.json),
[source hashes](source-snapshot.json), [next integration boundary](next-boundary.md).
