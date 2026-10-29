# LOG131 — empty native thread cleanup

This internal owner accepts at most 500 captured candidate IDs and the original
issued strict/exclusive system scope. It keeps soft-deleted roots and every thread
with any message, including soft-deleted messages. It snapshots and locks four
actual tables: messageThread, messageThreadTarget, messageChannelMessageAssociation
and its folder junction. A protected child retains its whole parent graph.

The metadata relation association.messageThreadId is real even though absent from
the old TypeScript entity. Tests deliberately associate a message from a different
thread with an empty candidate thread. Only the latter thread and its dependent
target/association/junction disappear; the message, participant and original
thread remain unchanged. Manual targets are included in the actual cascade audit.

Review identified a schema-drift race: without the message→thread FK, a new message
could arrive after the final emptiness check without waiting on the root lock.
The owner requires all expected actual FK edges under table locks before proceeding.
Unknown populated mutating edges still refuse deletion. Tests remove and restore
the exact PostgreSQL definitions and exercise both real FK lock orders.

Final review identified deferred constraint triggers as a separate boundary: they
could restore a deleted row at COMMIT after final readback. Both this owner and the
LOG130 channel-association owner now execute SET CONSTRAINTS ALL IMMEDIATE after
audit flush and before final verification. This drains deferred effects and makes
them visible to the existing exact graph/ownership checks.

These are internal terminal mutation operations: their transaction-owning caller
must propagate errors and must not mutate the validated graph afterwards. The
channel-cleanup service directly returns its owner. The new thread owner is not
yet wired into the whole orphan sweep; that integration also requires audited
message/participant deletion and target reconciliation in a coordinated transaction.
No public caller-controlled scope, bypass grant, or generic messaging audit
allowlist is added.

Existing after-commit callback behavior is unchanged. This slice does not implement
durable dispatch, the full orphan sweep, calendar cleanup or production rollout.
Verification is recorded in results.json when complete.
