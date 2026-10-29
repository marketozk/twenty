# LOG124 — immutable audit attribution for requests and application jobs

The existing workspace authentication middleware now snapshots hydrated IDs into
a separate leaf audit AsyncLocalStorage. It performs no extra database lookups and
preserves the existing authentication middleware behavior. Only primitive IDs,
an impersonator membership ID and a generated correlation ID are retained; request
objects, tokens, headers and body-selected actors are excluded.

Consumers validate the workspace, principal and impersonation when they need audit
identity. Nested contexts restore their parent; parallel requests remain isolated.
Application/agent attribution retains the actual initiator. This context provides
attribution, never authorization or a fence for detached work after a response.

ApplicationLifecycleJobService captures resolved identity before its first lookup
for install, upgrade and uninstall. Queue payloads preserve that snapshot; the
existing in-flight deduplication leaves the old job untouched. All three handlers
validate/copy their payload identity before calling the unchanged domain service.
Legacy jobs explicitly mask ambient identity instead of borrowing another caller.
Explicit named system contexts can similarly replace an ambient request scope.

This is a prerequisite, not account-delete coverage. No destructive owner is
switched yet. OAuth, preinstalled apps, automatic upgrade and command sources need
their explicit provenance wrappers next. MCP is not covered by this middleware.

[Design](design.md), [review](review.md), [results](results.json),
[source hashes](source-snapshot.json), [next boundary](next-boundary.md).

No production deployment, customer messages or GitHub Actions. Tests distinguish
real queue/middleware orchestration from unrelated DI adapters and full HTTP.
