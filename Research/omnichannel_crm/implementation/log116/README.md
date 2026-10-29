# LOG116 — active membership check after cached authentication

Scoped implementation verified. ROB-765 remains In Progress; no deployment claimed.

Source review after LOG115: hard membership deletion cascades userSession, and even a
session-cache hit rereads that DB row. Soft deletion keeps the session. JwtAuthStrategy
resolveUserContext previously accepted cached userWorkspace without a fresh membership
check; failed invalidation could preserve access. Reuse its existing repository to
require active membership for the exact user, membership ID and workspace before
returning authenticated context. Delegated applications with a user use the same check.
Keep workspace-agnostic, application-without-user, API-key paths and
existing guards unchanged. This is a read-time revocation check, not transaction-wide
authorization fencing against mutations already admitted before revocation.

Verify the actual JwtAuthStrategy with PostgreSQL membership and deliberately stale
caches: soft/hard deletion, foreign user/workspace, deleted cache values, DB failure,
valid control and repeated resolution. Existing strategy unit tests cover other token
paths. Automatic cleanup attribution wiring remains the next boundary from LOG115.

Results: 21 new PostgreSQL cases; 182 targeted tests/5 suites; 1237 regression
tests/39 suites; 29 existing authentication unit tests; 26 guards pass and 10
migration checksums unchanged. Differential types: 354/355 roots, 190 baseline /
184 current diagnostics, zero new or changed-file diagnostics. This is not a clean
full-server typecheck. Three uploaded source hashes match local files.

[Machine results](results.json), [review](review.md), [next boundary](next-boundary.md).
The isolated type checker now includes the already locked @types/passport-jwt 3.0.13
for both baseline and current sources. No project dependency or gate was relaxed.
