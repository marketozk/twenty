# LOG126 — automatic retry boundary for unknown transactions

BullMQDriver sees the original handler error. For either verified unknown outcome
class, or an exact CoreAuditPostCommitError after a confirmed COMMIT, call synchronous
job.discard() then rethrow that same error. BullMQ persists
failed without normal attempts/backoff retry. Known failures keep existing behavior.
Keep a narrow unknown predicate and a shared unsafe-to-retry predicate. Preserve
the original application alias. Move CoreAuditPostCommitError into a leaf with a
re-export at its original path; class identity and external imports remain intact.

MessageQueueExplorer reports exceptions before rethrowing. Protect the original
unknown error from a failing reporter, otherwise the driver cannot identify it.
SyncDriver already has no automatic retry and remains unchanged. Install/upgrade
must also avoid compensation for confirmed postcommit failure. A real PG subscriber
failure after INSERT/COMMIT and a Redis worker verify the saved effect with one try.

Verify actual driver and actual explorer against isolated Redis: both classes,
ordinary retry/success, reporter failure, original reason and restart after failed
is persisted. Existing queue configuration and lifecycle behavior must remain intact.

This is not durable quarantine/exactly-once: crash before failed persistence,
stalled delivery, manual retry/new enqueue and another scheduled occurrence remain
separate reconciliation boundaries. No changes to the live worker or customer queues.
