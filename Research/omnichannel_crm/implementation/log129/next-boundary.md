# Next: audit native message-channel association cleanup

Actual path: MessagingMessageCleanerMessageChannelListener enqueues
MessagingMessageChannelDeletionCleanupJob with workspace/channel IDs. The job first
calls MessagingMessageCleanerService.deleteMessageChannelMessageAssociationsByChannelId,
then runs cleanOrphanMessagesAndThreads separately. The current association cleanup
has scoped repositories, keyset pagination and retained-message guards, but no audit
context or strict commit. Its folder-junction FK cascades must be covered too.

Implement a narrow owner for messageChannelMessageAssociation plus
messageChannelMessageAssociationMessageFolder and connect this service method.
Reuse runInWorkspaceTransaction with strict commit and exclusive native ownership,
getIssuedNativeCleanupMetadata, readNativeCrmAuditRows/captureNativeCrmAuditSnapshot,
createCrmAuditWorkspaceExecutor, and the existing repository/ownership constraints.
Record crmRecord/delete with actual objectMetadataId and the established deleted-record
administration descriptor. Inspect actual incoming FKs; reject unsupported populated
mutating edges. Verify actual DELETE RETURNING and graph effects before and after
audit flush. Audit failure rolls this cleanup back.

Check that the core channel is absent under the ownership fence. A delayed deletion
job must not clean a recreated ordinary channel with the same ID. Generate a named
system-worker audit operation at the job boundary; do not invent the deleting user's
identity. Queue payloads currently carry no initiator/correlation. If adding these,
use the already established captured server identity conventions, not browser input.

Acceptance: real PostgreSQL association/junction audit, retained ownership markers,
protected first page and ordinary later page, actual partial/skip effects, both orders
of relevant FK insert/reparent races, audit failure/corruption rollback, unknown COMMIT,
idempotent empty rerun, recreated-channel refusal and safe identity/diff contents.
Reuse omni-native-cleanup.fixture.ts and current keyset/cascade tests.

Keep the remaining scope explicit: Message/Thread orphan deletion and target
reconciliation have additional writes; calendar cleanup is separate. Connected-account
jobs actually sweep workspace-wide orphans rather than using the account ID. They
are not covered by this association owner. EventEmitter2.emit does not await async
listeners, and commit/listener/Redis delivery is not atomic. This slice audits a job
that runs; it does not establish durable dispatch or complete account cleanup.
