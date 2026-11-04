# LOG151 independent design review

Reviewed `Research/omnichannel_crm/implementation/log151/design.md`,
`Research/omnichannel_crm/implementation/log151/test-research.md` and the
actual save, matching, authority-proof, deferred-action and PostgreSQL test
files after LOG150 (`c3478dde`). This report covers the proposed durable
post-save message matching intent and page-progress recovery slice (part of
ROB-765). Runtime and source implementation acceptance belong to the following
step.

## Verdict

The proposed Option 3 architecture is sound and closes the post-save
touched-participant durability gap without introducing a new database migration
or broadening replay to historical participants. Persisting the bounded page
manifest in `core."deferredWorkspaceMigrationAction"` inside
`saveOrdinaryMessageBatchWithAudit` and advancing `nextPageIndex` or deleting
the completed intent inside each strict/exclusive page transaction in
`executeNativeMessageMatchingWithAudit` eliminates the post-commit delete crash
window.

Five concrete source-level details require explicit handling during
implementation:

1. **In-band vs background recovery coordination via `status = 'IN_PROGRESS'`:**
   `saveOrdinaryMessageBatchWithAudit` commits the intent with
   `status = 'PENDING'` and `attempts = 0`. Before executing pages in-band,
   `matchMessageImportParticipantsWithAudit` must atomically claim
   `status = 'IN_PROGRESS'` (`WHERE status = 'PENDING' AND NOT (payload ? 'unsafeOutcome')`),
   require `status = 'IN_PROGRESS'` inside `executeNativeMessageMatchingWithAudit`,
   reset `status = 'PENDING'` if an in-band page returns `'stale-run'` or throws
   an ordinary error, and serialize under the exclusive workspace ownership lock
   if a background recovery worker already claimed or completed the intent
   during `contacts.add`.
2. **Manifest construction inside `saveOrdinaryMessageBatchWithAudit` when
   `savedMessageParticipants` is empty:**
   `messageReferences` must continue filtering `messageExternalIdsAndIdsMap` by
   `participantsWithMessageId.map(({ messageId }) => messageId)` so an identical
   retry with zero newly touched participants still produces its target-only
   refresh page (`participants: []`, `messages: [...]`) while the first save's
   `PENDING` intent preserves the touched participants.
3. **Preserving committed `nextPageIndex` during unsafe-outcome fencing:**
   When `isTransactionUnsafeToRetry(error)` is caught on `pageIndex`, the catch
   block must patch `unsafeOutcome` via
   `jsonb_set(payload, '{unsafeOutcome}', $5::jsonb, true)` rather than
   overwriting `payload` with a pre-page in-memory snapshot, and rethrow the
   original error instance unchanged.
4. **Defense-in-depth against external status resets on `unsafeOutcome` rows:**
   Exclude `payload ? 'unsafeOutcome'` in candidate `SELECT` and claim `UPDATE`
   predicates, and never reset a row with `unsafeOutcome` back to `'PENDING'`.
5. **Complete live `provider` authority checks during `isRecoveryReplay`:**
   When `isRecoveryReplay === true` bypasses `lockOrdinaryNativeSyncRun` for
   `provider` authority in `captureMessageImportAuthorityProof`, explicitly
   enforce `channel.isSyncEnabled === true`, `channel.type !== 'APP'`,
   `account.provider !== 'app'`, `findOmniOwnedConnectedAccountIds` and
   `findOmniOwnedMessageChannelIds`.

## Enterprise dependency and typecheck boundaries

- Accessing `core."deferredWorkspaceMigrationAction"` via `scope.executeRawQuery`
  and importing only `DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS` and
  `isTransactionUnsafeToRetry` avoids importing
  `DeferredWorkspaceMigrationActionRunnerService` or metadata cache types that
  reach Enterprise modules.
- Re-export `MESSAGE_IMPORT_MATCHING_INTENT_NAME`,
  `buildMessageImportMatchingPages`,
  `captureMessageImportMatchingIntentPayload` and
  `MessageImportMatchingIntentPayload` from
  `apply-native-message-import-matching-with-audit.ts` so unit and PostgreSQL
  tests share the single contract boundary.
