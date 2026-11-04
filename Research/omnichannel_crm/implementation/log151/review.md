# LOG151 independent owner implementation review

Reviewed the durable post-save message matching intent, atomic page-progress and
completion receipts, unsafe-outcome fencing, background recovery service and
unit/PostgreSQL test suites against
`Research/omnichannel_crm/implementation/log151/design.md` and
`Research/omnichannel_crm/implementation/log151/design-review.md`. No source or
runtime files were modified during this review.

## Verdict

No remaining blocking defects, race conditions, SQL injection or authority
bypass vectors, or rollback/audit gaps were identified in the inspected working
tree changes:

- `packages/twenty-server/src/engine/core-modules/crm-audit/message-import-matching-context.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/apply-native-message-import-matching-with-audit.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/message-import-authority-proof.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/native-message-cleanup-with-audit.ts`
- `packages/twenty-server/src/modules/match-participant/match-participant.service.ts`
- `packages/twenty-server/src/modules/messaging/message-participant-manager/services/messaging-message-participant.service.ts`
- `packages/twenty-server/src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service.ts`
- `packages/twenty-server/test/fork-migration/omni-native-message.fixture.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-message-import-matching.postgres-spec.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-message-import-orchestration.spec.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-message-import-recovery.postgres-spec.ts`

All five implementation details raised in `design-review.md` are accurately
implemented.

## Verification of design-review.md findings

1. **In-band vs background recovery coordination via `status = 'IN_PROGRESS'`:**
   `saveOrdinaryMessageBatchWithAudit` inserts the intent into
   `core."deferredWorkspaceMigrationAction"` with `status = 'PENDING'` and
   `attempts = 0` inside the initial strict/exclusive save transaction. Before
   executing pages in-band,
   `MatchParticipantService.claimInBandMessageImportMatchingIntent` atomically
   claims `status = 'IN_PROGRESS'`
   (`WHERE id = $1 AND "workspaceId" = $2 AND name = $3 AND status = 'PENDING' AND NOT (payload ? 'unsafeOutcome') RETURNING id, payload`)
   and verifies `payload` against the captured context and page list. If the
   fast-path claim returns 0 rows because a recovery worker claimed or finished
   the intent during `contacts.add`, `claimInBandMessageImportMatchingIntent`
   enters a `{ commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' }`
   transaction, locks the row `FOR UPDATE`, returns `completedByRecovery: true`
   when the row is already deleted, or claims `IN_PROGRESS` and resumes from
   `payload.nextPageIndex` when `status === 'PENDING'`. Inside
   `executeNativeMessageMatchingWithAudit`, the page transaction locks the
   intent row `FOR UPDATE`, requires `status === 'IN_PROGRESS'`, and resets
   `status = 'PENDING', "startedAt" = NULL, "updatedAt" = now()` (verifying
   `RETURNING id`) when an in-band provider run is stale. Ordinary page errors
   reset `IN_PROGRESS` rows back to `PENDING` in
   `releaseMessageImportMatchingIntentAfterError`.
2. **Manifest construction inside `saveOrdinaryMessageBatchWithAudit` when
   `savedMessageParticipants` is empty:**
   `messageReferences` continues filtering `messageExternalIdsAndIdsMap` by
   `participantsWithMessageId.map(({ messageId }) => messageId)`. An identical
   retry with zero newly touched participants still produces its target-only
   refresh page (`participants: []`, `messages: [...]`), while the first save's
   `PENDING` intent retains the original touched-participant set for recovery.
   Empty batches and messages without participants produce `pages.length === 0`
   and insert no intent row.
3. **Preserving committed `nextPageIndex` during unsafe-outcome fencing:**
   When `isTransactionUnsafeToRetry(error)`
   (`NativeTransactionOutcomeUnknownError` or `CoreAuditPostCommitError`) is
   caught on `pageIndex` during either in-band execution or recovery replay,
   `fenceUnsafeMessageImportMatchingIntent` updates any surviving intent row via
   `jsonb_set(payload, '{unsafeOutcome}', $5::jsonb, true)` with
   `status = 'FAILED'`, `"startedAt" = NULL` and `"lastError" = reason`, then
   rethrows the original `error` instance unchanged. Any `nextPageIndex` already
   committed in PostgreSQL is preserved rather than overwritten with a pre-page
   in-memory snapshot, and a final page whose `COMMIT` actually succeeded before
   ACK loss leaves no row behind because the `DELETE` committed inside that
   transaction.
4. **Defense-in-depth against external status resets on `unsafeOutcome` rows:**
   Candidate `SELECT` and claim `UPDATE` queries in
   `reconcileMessageImportMatchingIntentsWithAudit` and
   `claimInBandMessageImportMatchingIntent`, as well as
   `releaseMessageImportMatchingIntentAfterError`, include
   `NOT (payload ? 'unsafeOutcome')`, and both `verifyClaimedIntentPayload` and
   `executeNativeMessageMatchingWithAudit` reject any payload where
   `unsafeOutcome !== undefined` before authority checks or status resets can
   run.
5. **Complete live `provider` authority checks during `isRecoveryReplay`:**
   In `captureMessageImportAuthorityProof`, `isRecoveryReplay === true` bypasses
   only `lockOrdinaryNativeSyncRun` for `provider` authority while still locking
   `core."connectedAccount"` and `core."messageChannel"` `FOR SHARE`, enforcing
   `account.provider !== 'app'`, `channel.type !== 'APP'` and
   `channel.isSyncEnabled === true`, and verifying both
   `findOmniOwnedConnectedAccountIds` and `findOmniOwnedMessageChannelIds`
   initially and in `session.validators` after `SET CONSTRAINTS ALL IMMEDIATE`.

## Security, transactional integrity and boundary checks

1. **SQL injection and input validation:**
   All queries against `core."deferredWorkspaceMigrationAction"`,
   `core."connectedAccount"`, `core."messageChannel"` and workspace tables use
   parameterized `$1..$N` placeholders and quoted identifiers.
   `captureMessageImportMatchingIntentPayload` enforces strict key whitelisting,
   `version === 1`, lowercase UUID normalization, channel/mode agreement, page
   size bounds (`<= 200`), `nextPageIndex` bounds and frozen immutable object
   graphs; no message body or participant display name is persisted in the
   intent payload.
2. **Rollback and deferred constraint drain:**
   In `saveOrdinaryMessageBatchWithAudit`, the intent insert checks
   `RETURNING id` and registers a validator in `state.validators` that re-reads
   the row and compares all columns and `canonicalAuditJson(payload)` both
   before `state.audit.flush()` and after `SET CONSTRAINTS ALL IMMEDIATE`. In
   `executeNativeMessageMatchingWithAudit`, intermediate page updates and final
   page deletes check `RETURNING id` and register post-drain validators in
   `session.validators` verifying the updated payload (`status = 'IN_PROGRESS'`,
   `nextPageIndex = pageIndex + 1`) or row absence after
   `SET CONSTRAINTS ALL IMMEDIATE`.
3. **Enterprise dependency and export boundaries:**
   `MatchParticipantService` queries `core."deferredWorkspaceMigrationAction"`
   directly and imports only `DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS`
   and `isTransactionUnsafeToRetry`, avoiding
   `DeferredWorkspaceMigrationActionRunnerService` and Enterprise-reaching
   metadata cache imports. `apply-native-message-import-matching-with-audit.ts`
   re-exports the intent constants, builders and types cleanly.
