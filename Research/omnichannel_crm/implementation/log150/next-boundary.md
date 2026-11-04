# Next boundary after LOG150 - durable post-save matching intent and recovery

Read-only boundary analysis for the step following LOG150. No runtime or
acceptance claim is made here.

## Why LOG150 unlocks durable matching intent

Before LOG150, `MessagingSaveMessagesAndEnqueueContactCreationService` built its
returned `messageExternalIdsAndIdsMap`, `messageExternalIdToMessageThreadIdMap`
and `savedMessageParticipants` from unverified ORM accumulator plans and `find`
re-reads without an atomic audit owner. LOG150 replaces that initial save
transaction with a closed owner that verifies actual `RETURNING` IDs, complete
PostgreSQL row images, read-only `MessageThreadTarget` and source invariants,
and origin authority before `COMMIT`.

Once the initial save transaction produces a verified actual-save manifest, the
remaining gap between the initial save commit and post-save participant/target
matching (`LOG149`) is durability across process crashes, queue failures or
post-save matching failures.

## The recovery problem

1. The initial save commits new or identity-updated `messageParticipant` rows
   along with `message` and `messageThread` rows.
2. If contact-creation queue enqueue or `matchMessageParticipants` fails after
   that commit, a subsequent retry of the same message batch sees the previously
   saved participants as already existing and unchanged.
3. Because `prepareMessageParticipantsWithinTransaction` / `saveMessageParticipants`
   returns only newly inserted or identity-updated rows, a naive re-save produces
   an empty touched-participant list and therefore refreshes `messageThreadTarget`
   without matching the originally inserted participants to `person` or
   `workspaceMember`.
4. Broadening import matching to rediscover every historical participant under
   the saved Messages would overwrite manually maintained historical links and
   violate the selector contract established in LOG149.

## Recommended next slice (LOG151)

Persist the verified `MessageImportMatchingManifest` and captured origin
attribution inside the same initial save transaction (`LOG150`) as a durable
post-save matching intent in `core.deferredWorkspaceMigrationAction` (following
the `LOG114` core-table precedent without introducing a new database migration),
and advance or complete that intent as pages commit in `LOG149`:

- **Atomic intent creation:** When the verified save manifest has non-empty
  `messages` or `participants`, insert a `PENDING` deferred action record in
  `core.deferredWorkspaceMigrationAction` inside the `LOG150` save transaction
  and verify its returned row before `COMMIT`.
- **Page-level progress receipt:** Update or complete the persisted intent inside
  each `LOG149` page transaction (or record page progress) so a crash after page
  1 commits does not re-run page 1 or lose page 2.
- **Unsafe-outcome fencing:** If a page fails with
  `NativeTransactionOutcomeUnknownError` or `CoreAuditPostCommitError`, mark the
  intent as requiring reconciliation rather than allowing blind automatic retry.
- **Replay authority recheck:** Replaying a pending intent re-runs the current
  authority proof (`provider`, `inbound`, `sent`, `sent-tool`, `application`)
  while preserving the original captured actor, initiator and `correlationId`.
