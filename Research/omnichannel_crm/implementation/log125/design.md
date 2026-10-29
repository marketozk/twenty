# LOG125 — application entry-point attribution

Use the LOG124 leaf context at real source boundaries, not in the generic install
service: preinstalled policy, backfill, CLI installation and automatic upgrade.
Each system action receives its own scoped identity. Human lifecycle jobs retain
their already captured user identity. Automatic jobs identify the executing worker,
not an inferred human publisher.

OAuth code issuance snapshots verified user/workspace/impersonator before awaits.
The existing JSONB token context stores an immutable identity; no migration.
Exchange retains client, redirect, PKCE and atomic consume checks, validates that
the stored actor matches token user/workspace, then checks current membership before
auto-install. Old five-minute codes without attribution require fresh authorization.
This is not a membership lock through the whole install or a global role refresh.

Bare application creation is valid only for source types with no package install
(OAUTH_ONLY and LOCAL). A packaged install failure or missing installed record
must surface, not become a successful bare application/token grant.

Strict transaction unknown outcomes must remain identifiable through install and
upgrade: no compensating uninstall, telemetry replacement or bare OAuth fallback.
Temporary package cleanup may still run, but cannot replace an unknown outcome.
Account deletion itself is still a subsequent owner change.

Verification: real source methods with explicit unrelated DI adapters; concurrent
workspace system scopes, dry-run, issuer/impersonator round trip, bad/replayed code,
missing/foreign attribution, revoked membership, install failure/unknown outcome.
Then scoped regression, differential types and unchanged dependency/migration guards.
