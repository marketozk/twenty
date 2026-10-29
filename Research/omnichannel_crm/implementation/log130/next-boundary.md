# Next: orphan message/thread cleanup and reconciliation

MessagingMessageCleanerService.cleanOrphanMessagesAndThreads currently deletes
ordinary messages with no associations, reconciles targets on surviving threads,
then deletes threads with no messages. The method still has no audit operation or
explicit strict/exclusive transaction. LOG130 covers only the preceding channel
association stage, not this sweep.

Actual call sites: channel-deletion cleanup job, connected-account cleanup job,
blocklist job, MessagingResetChannelCommand and MessagingMessageCleanerRemoveOrphansCommand.
The account job sweeps the workspace and does not select by account ID. The remove-
orphans command catches failures; unsafe transaction outcomes must remain explicit
when this path is connected to audited owners.

ParticipantTargetReconciliationService.reconcileMessageThreadTargets writes target
INSERT/UPDATE/DELETE, including isAutomaticallyAssigned. Preserve the existing
manual-assignment and tombstone rules from compute-target-reconciliation-operations.
Auditing only message deletion would leave part of the operation unaccounted for.

Important confirmed metadata edge: messageChannelMessageAssociation.messageThreadId
references messageThread with ON DELETE CASCADE, even though the TypeScript entity
does not declare this field. An empty thread can therefore still have associations
and folder junctions. Other edges include message→participant/association,
thread→message/target and association→folder junction. Inspect actual PostgreSQL
FKs and metadata; entity classes alone are insufficient.
Require the expected actual FKs before relying on parent row locks to fence new
child inserts. A missing constraint must refuse cleanup even when no child exists
at the initial read; ROW EXCLUSIVE alone does not prevent a later insertion.

Next bounded implementation: deletion of empty native threads with actual target,
association and junction cascades. Require an issued strict/exclusive system scope,
active workspace, row locks and no remaining messages; retain parents with any
protected child. Cover real RETURNING, exact snapshots, unsupported populated FKs,
late ownership, audit failure and both relevant FK race orders. Do not declare the
whole sweep connected until message/participant deletion and target reconciliation
also share its audit transaction.

Use omni-native-cleanup.fixture.ts/.postgres-spec.ts and
omni-native-reconciliation.fixture.ts/.postgres-spec.ts as existing executable
fixtures. Durable dispatch, calendar cleanup and general file cleanup remain
separate open requirements.
