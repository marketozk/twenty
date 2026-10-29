# Next: closed connected-account deletion audit owner

Implement and verify the four-table core graph primitive before switching callers:
connectedAccount, messageChannel, calendarChannel and messageFolder. Reuse strict
core transaction and shared native-ownership fence. Capture exact DB snapshots,
lock actual children against reparenting, inspect real incoming FK inventory and
refuse unsupported populated mutating references. Retained omni resources refuse.

Require a trusted scoped operation. Verify exact DELETE RETURNING and final absence,
persist redacted deletion events in the same transaction, verify again after audit.
Journal failure rolls back ordinary destructive deletion (no security-first fallback).
Actual effects, not stale requested IDs, define eventual cleanup events.

Then wire each production caller with captured identity and its existing/fresh
permission contract: authenticated deletion, email-group deletion, manifest sync,
provider-scope command. LOG124/125 cover request/queue/OAuth/system attribution.
Legacy identity-less jobs cannot invent a principal. External revoke/hooks and
postcommit native cleanup remain separate from the core transaction.

See [caller/FK investigation](../log123/next-boundary.md). Remaining generic native
writers, real shares/files, public destroy/merge, denied/failed audit, health,
full HTTP and deployment still require acceptance.
