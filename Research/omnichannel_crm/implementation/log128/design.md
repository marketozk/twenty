# LOG128 — deletion selection and execution boundaries

The closed deletion owner now requires a captured discriminated boundary. It locks
active userWorkspace or selected connectionProvider prerequisites before locking
accounts and checks the deletion criterion on fresh account/channel rows. Raw
prerequisite snapshots are checked again through the existing post-audit verification.

Administration requires an active scoped membership and a permission callback receiving
only frozen id/userWorkspaceId/scope/provider values. No runner or arbitrary mutation
callback escapes. Email-group additionally pins channel ID, account ID and EMAIL_GROUP
type. Manifest selection pins provider IDs and their application/workspace ownership.
Scope repair pins account→provider links and requires the current scopes to differ.
IDs, maps and the callback are copied before the first await.

This boundary preserves the caller's permission policy; it does not implement the
future own ACL service or prove freshness of cache-backed role permissions. The caller
still must capture authenticated attribution and reject invalid requests before
provider side effects. These production callers are not switched in this change.

The historical 2.51 provider-scope command cannot be edited under CLAUDE.md. Both current
execution paths (base CLI runner and upgrade runner) wrap execution using its exact
registered metadata pair 2.51.0/1792675225627. This identifies the executing command,
not migration state. Other commands mask a surrounding repair source.

The scoped source is distinct from audit actor. It can be consumed only once, in its
workspace, while execution is active. finally revokes detached asynchronous descendants.
The service must consume it before any provider await, convert it to explicit captured
selection criteria and never infer authority from the system actor string. Named system
attribution uses the existing LOG124 context. Historical command sources stay unchanged.

Tests use real PostgreSQL owner/locks/audit and both actual runner methods. Unrelated
runner DI providers and chalk are adapted; the execution wrapper/metadata and identity
are real. Concurrent membership deactivation/provider scope updates are tested in both
orders with observed PostgreSQL lock waits, not timing-only sleeps.
