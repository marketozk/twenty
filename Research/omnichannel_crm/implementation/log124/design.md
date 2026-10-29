# LOG124 — audit attribution across request and application job boundaries

Prerequisite to LOG123's next account-delete owner. The actual deletion callers
include authenticated account/email-group endpoints, application manifest apply
and an upgrade command. The manifest path spans more than thirteen internal
install/sync methods; manually forwarding identity through all of them would add
cross-cutting parameters without changing their domain behavior.

Research: WorkspaceAuthContextMiddleware runs after awaited authentication
hydration for GraphQL/Metadata/AdminPanel and after RestCoreMiddleware for migrated
REST (app.module.ts). Existing workspace auth storage omits impersonation.
The API usage storage is Enterprise and is excluded. ApplicationLifecycleJobService
serializes only target identifiers today; TriggerInstall/Upgrade jobs do not retain
the initiating user. Target application ownership is not caller attribution.

Decision: add a small leaf AsyncLocalStorage for immutable audit attribution.
The existing auth middleware snapshots only server-hydrated primitive identifiers,
without DB calls or new authorization failures. Audit consumers validate workspace
and identities and resolve impersonation before external effects. The context is
not permission evidence and does not introduce a revocation fence.

Queue boundaries serialize a resolved identity and restore it explicitly in the
handler. Missing legacy payload must clear any ambient identity, not borrow it.
Deduplication retains the original job and its identity. Explicit named system
operations can replace the ambient identity for their workspace. Uninstall shares
the same queue boundary even though its mutation audit is still a later owner.

Verification: concurrent workspace isolation, frozen request snapshots, nested
restoration on throw, foreign/missing identity, impersonation and application/agent
attribution, real middleware adapters, serialized job restoration and deduplication.
Existing request authorization, job IDs, queue/progress behavior stay unchanged.

This slice does not switch account deletion yet. OAuth auto-install, preinstalled
apps and automatic upgrade/command wrappers must be wired before that switch.
OAuth is outside this middleware and needs verified retained code provenance;
MCP is not claimed covered by request middleware. Old user jobs cannot gain a
made-up initiator. Destructive owners will fail closed when attribution is missing.
