# LOG125 — trusted application sources and unknown outcome propagation

Preinstalled policy installs, backfill, CLI installs and automatic upgrade workers
now establish explicit workspace-scoped system attribution. Human lifecycle jobs
keep LOG124 identity. System worker identity does not claim a human publisher.

OAuth authorization captures verified user/workspace and impersonator before the
first await; issuance copies and validates this identity into existing token JSONB.
Exchange keeps client/redirect/PKCE/atomic single-use checks, validates the persisted
identity against token user/workspace, and checks current membership before install.
The exchange request cannot select an actor. Old five-minute codes without identity
require authorization again; existing refresh/access tokens are not changed.

Only LOCAL/OAUTH_ONLY registrations can create a bare application without package
installation. Packaged installation errors and missing installation results surface
instead of silently creating a bare app and granting tokens.

Both NativeTransactionOutcomeUnknownError and OmniCoreTransactionOutcomeUnknownError
pass through installation and upgrade without compensating uninstall, fallible
failure telemetry or type replacement. Package cleanup still runs; its failure
cannot replace the unknown outcome. A real PostgreSQL DELETE/COMMIT followed by
injected ACK loss was routed through the actual manifest migration and install
methods; committed effect, no compensation and no second migration were verified.
Unrelated DI and manifest-plan generation are explicit test adapters, not full HTTP.

Important remaining boundary: automatic upgrade jobs currently allow retries.
The queue driver must stop retrying recognized unknown outcomes before the new
strict connected-account deletion owner is enabled. A process crash/stalled job
and manual retry require separate reconciliation; this slice does not claim that.

[Design](design.md), [review](review.md), [results](results.json),
[source snapshot](source-snapshot.json), [next boundary](next-boundary.md).
ROB765 remains In Progress. No deployment or GitHub Actions.
