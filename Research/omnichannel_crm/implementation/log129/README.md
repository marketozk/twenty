# LOG129 — production account deletion with atomic audit

The production account service now uses the closed four-table deletion owner.
Administrative deletion keeps its captured caller; email-group deletion additionally
pins its channel and handle. Manifest deletion pins the owner application/provider
selection. The unchanged historical scope-repair command runs through its one-shot
execution wrapper and cannot be re-entered from a provider hook.

Initial permission, membership and retained-account/folder checks precede external
provider effects. The transaction rechecks current permission inputs and actual graph.
Manifest, email-group and scope repair require complete deletion inside that transaction.
An administrative batch reports actual deleted IDs; a skipped single deletion cannot
return a successful DTO. Events use committed RETURNING IDs. Synchronous dispatch
failure is classified as confirmed-postcommit failure rather than safe to retry.

The actual metadata provider-delete handler locks its captured provider ID and refuses
all remaining account references before deleting the provider. Tests cover concurrent
FK insert/reparent in both orders and an account inserted between cleanup and provider
transactions. This prevents a subsequent unaudited account cascade.

Tests exercise the real service, historical command, upgrade runner, resolver,
email-group and manifest methods, plus real PostgreSQL ownership/concurrency/effect
checks. Unrelated DI/entity/planner dependencies are explicit test adapters. The full
HTTP integration suite and historical application boot suite were not executed.

[Results](results.json), [review](review.md), [source hashes](source-snapshot.json),
[next implementation boundary](next-boundary.md).

Limits: role-policy caches are unchanged; provider hooks/revocation/subscription
effects cannot be rolled back with the DB. Async native cleanup and event delivery
remain separate. No full build/deployment or GitHub Actions. ROB765 stays In Progress.
