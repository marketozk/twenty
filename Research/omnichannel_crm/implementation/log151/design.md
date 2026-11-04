# LOG151 - durable post-save message matching intent and page-progress recovery

Proposed concrete design incorporating independent review (`design-review.md`).
Source inspection used the LOG150 closed ordinary Message save owner, LOG149
post-save matching owner, LOG114 `core.deferredWorkspaceMigrationAction`
precedent and existing recovery services. No repository or runtime changes are
claimed by this document.

## Problem and scope

`MessagingSaveMessagesAndEnqueueContactCreationService.saveMessagesAndEnqueueContactCreation`
commits initial Message/Thread/Association/Participant/Folder rows in
`saveOrdinaryMessageBatchWithAudit` (LOG150), then enqueues contact creation and
invokes `matchMessageParticipants` (LOG149). Because
`prepareMessageParticipantsWithinTransaction` returns only newly inserted or
identity-updated participants, a crash, contact-queue failure or matching error
after the initial save commit loses the touched-participant set on a naive
re-save: the second save sees those participants as already existing and
unchanged, producing an empty touched list.

Broadening import matching to rediscover all historical participants under saved
Messages would overwrite manually maintained links. Conversely, delegating
directly to `DeferredWorkspaceMigrationActionRunnerService` without page-level
receipt ownership would leave a crash window between a committed matching page
and the runner's post-handler `DELETE`, and would automatically retry
`NativeTransactionOutcomeUnknownError` or `CoreAuditPostCommitError` contrary to
the unsafe-outcome contract (LOG126).

This slice closes the durable touched-set recovery gap by:

1. Persisting the verified bounded matching pages and captured origin context as
   a durable intent in `core.deferredWorkspaceMigrationAction` inside the
   initial `saveOrdinaryMessageBatchWithAudit` transaction before `COMMIT`.
2. Coordinating in-band and recovery execution via atomic `status = 'IN_PROGRESS'`
   claims and advancing `nextPageIndex` (for intermediate pages) or deleting the
   completed intent row (for the final page) inside each strict/exclusive page
   transaction in `applyNativeMessageImportMatchingWithAudit`.
3. Fencing `NativeTransactionOutcomeUnknownError` and `CoreAuditPostCommitError`
   into `status = 'FAILED'` with `jsonb_set(payload, '{unsafeOutcome}', ...)`
   so ambiguous commits preserve committed `nextPageIndex` and are never
   blindly retried.
4. Providing `reconcileMessageImportMatchingIntentsWithAudit` (and
   `MessagingMessageParticipantService.reconcileMessageImportMatchingIntents`)
   that claims pending intents, re-verifies current workspace/account/channel
   authority while preserving original actor/initiator/`correlationId`, and
   resumes from `nextPageIndex`.

## Alternatives considered

1. **Reconstruct touched participants by rematching all participants of saved
   Messages on retry:** Rejected. Overwrites manual historical links and breaks
   the explicit-selector invariant established in LOG149.
2. **Use `DeferredWorkspaceMigrationActionRunnerService` unmodified:** Rejected.
   Deletes the action row in a separate connection after the handler finishes
   (leaving a duplicate-execution crash window after final page commit), resets
   `PENDING` on any thrown error (violating LOG126 unsafe-outcome fencing), and
   pulls Enterprise-reaching metadata cache imports into the messaging graph.
3. **Transactional intent creation in LOG150 + atomic page-progress/delete in
   LOG149 + unsafe-outcome fencing in `core.deferredWorkspaceMigrationAction`:**
   Selected. Requires no new database migration, reuses the existing core table,
   eliminates the post-commit delete crash window, and preserves exact page
   progress, unsafe-outcome fencing and clean Enterprise dependency boundaries.

## Payload and pure contract (`message-import-matching-context.ts`)

Add `MESSAGE_IMPORT_MATCHING_INTENT_NAME = 'reconcile_messageImportMatching'` and
pure helpers in `message-import-matching-context.ts`:

- `buildMessageImportMatchingPages(manifest: MessageImportMatchingManifest)`:
  Splits `manifest` into bounded immutable pages (first participant pages of up
  to 200 touched participants with their explicit Message/Thread pairs in
  `'both'` mode, then remaining explicit Message references in target-only pages
  of up to 200).
- `MessageImportMatchingIntentPayload`:
  - `version: 1`
  - `context: MessageImportMatchingContext` (captured operation actor,
    initiator, `correlationId` and authority descriptor)
  - `pages: readonly MessageImportMatchingManifest[]` (non-empty bounded pages)
  - `nextPageIndex: number` (`0 <= nextPageIndex < pages.length`)
  - `unsafeOutcome?: Readonly<{ pageIndex: number; reason: string }>`
- `captureMessageImportMatchingIntentPayload(input: unknown)`:
  Validates structural shape, UUIDs, channel/mode agreement, page bounds (200),
  `nextPageIndex` bounds and optional `unsafeOutcome`, returning a deeply frozen
  payload. No message body or participant display name is stored in the payload.

## Atomic intent creation in `saveOrdinaryMessageBatchWithAudit`

Inside `saveOrdinaryMessageBatchWithAudit`, after Stage 5 (`folderPlan`) and
before `finishMessageSaveAudit`:

1. Build `messageReferences` from `messageExternalIdsAndIdsMap` and
   `messageExternalIdToMessageThreadIdMap` filtered by
   `participantsWithMessageId.map(({ messageId }) => messageId)`, then build
   `manifest = captureMessageImportMatchingManifest(...)` with
   `savedMessageParticipants`.
2. Compute `pages = buildMessageImportMatchingPages(manifest)`.
3. When `pages.length > 0`:
   - Allocate `intentId = randomUUID()` and build `payload` with
     `nextPageIndex: 0`.
   - Insert into `core."deferredWorkspaceMigrationAction"` with
     `id = intentId`, `"workspaceId" = workspaceId`,
     `"applicationUniversalIdentifier" = TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER`,
     `name = MESSAGE_IMPORT_MATCHING_INTENT_NAME`, `payload`, `position = 0`,
     `status = 'PENDING'`, `attempts = 0`.
   - Require `RETURNING id` to match `intentId`.
   - Register a validator in `state.validators` (executed before `audit.flush()`
     and after `SET CONSTRAINTS ALL IMMEDIATE`) that re-reads the row from
     `core."deferredWorkspaceMigrationAction"` and verifies `workspaceId`,
     `applicationUniversalIdentifier`, `name`, `status = 'PENDING'`,
     `attempts = 0`, `lastError = null`, `startedAt = null` and
     `canonicalAuditJson(payload)`.
4. When `pages.length === 0`, no intent row is inserted (`intentId = undefined`).
5. Return `manifest` and `intentId` from `saveOrdinaryMessageBatchWithAudit` and
   pass `intentId` into `this.messageParticipantService.matchMessageParticipants`.

## Atomic page progress and completion in `native-message-cleanup-with-audit.ts`

Extend `applyNativeMessageImportMatchingWithAudit` with optional
`intent?: Readonly<{ intentId: string; pageIndex: number; totalPages: number; isRecoveryReplay?: boolean }>`.

Inside `executeNativeMessageMatchingWithAudit` when `imported?.intent` is supplied:

1. Lock the intent row in `core."deferredWorkspaceMigrationAction"` `FOR UPDATE`
   scoped by `id`, `"workspaceId"` and `name = MESSAGE_IMPORT_MATCHING_INTENT_NAME`.
2. Verify `status === 'IN_PROGRESS'`, validate `payload` via
   `captureMessageImportMatchingIntentPayload`, verify `unsafeOutcome` is
   absent, `nextPageIndex === intent.pageIndex`,
   `pages.length === intent.totalPages`, and verify that `pages[intent.pageIndex]`,
   `context.authority` and `context.operation` (`workspaceId`, `actor`,
   `initiator`, `correlationId`) match the current page invocation.
3. Run `captureMessageImportAuthorityProof`:
   - During in-band execution (`!isRecoveryReplay`), `provider` authority runs
     `lockOrdinaryNativeSyncRun(scope, authority.run)`. If the run is stale,
     update the intent row back to `status = 'PENDING', "startedAt" = null, "updatedAt" = now()`
     (verifying `RETURNING id`) and return `{ nextCursor: null, outcome: 'stale-run' }`
     so recovery can reconcile the already-committed participants.
   - During recovery replay (`isRecoveryReplay === true`), `provider` authority
     locks and verifies live `connectedAccount` and `messageChannel` rows
     (`connectedAccountId`, `channelType`, `isSyncEnabled = true`, non-APP
     provider/type) and non-omni ownership (`findOmniOwnedConnectedAccountIds`
     and `findOmniOwnedMessageChannelIds`) without requiring the historical
     `syncStageStartedAt` timestamp. All other authorities (`inbound`, `sent`,
     `sent-tool`, `application`) run their full current authority proof
     unchanged.
4. Before `finalizeSession(session)`:
   - If `intent.pageIndex + 1 < intent.totalPages`:
     Update `core."deferredWorkspaceMigrationAction"` setting `payload` with
     `nextPageIndex: intent.pageIndex + 1` and `"updatedAt" = now()`, verify
     `RETURNING id`, and register a post-drain validator in `session.validators`
     confirming the updated `payload` and `status = 'IN_PROGRESS'` after
     `SET CONSTRAINTS ALL IMMEDIATE`.
   - If `intent.pageIndex + 1 === intent.totalPages`:
     Delete the row from `core."deferredWorkspaceMigrationAction"`, verify
     `RETURNING id`, and register a post-drain validator in `session.validators`
     confirming the row remains absent after `SET CONSTRAINTS ALL IMMEDIATE`.

## In-band coordination, unsafe-outcome fencing and recovery (`MatchParticipantService`)

In `MatchParticipantService.matchMessageImportParticipantsWithAudit`:

- Accept optional `intentId?: string`.
- When `intentId` is supplied, atomically claim `status = 'IN_PROGRESS'`
  (`WHERE id = $1 AND "workspaceId" = $2 AND name = $3 AND status = 'PENDING' AND NOT (payload ? 'unsafeOutcome') RETURNING id, payload`).
  If the claim returns 0 rows (because a concurrent recovery worker claimed or
  completed the intent while `contacts.add` was running), check the row under an
  exclusive workspace transaction: if deleted, return `'applied'`; if `PENDING`
  without `unsafeOutcome`, claim `IN_PROGRESS` and resume from
  `payload.nextPageIndex`; otherwise throw.
- Execute remaining pages sequentially. If a page throws an error and `intentId`
  is present:
  - If `isTransactionUnsafeToRetry(error)`: update any remaining row for
    `intentId` via `jsonb_set(payload, '{unsafeOutcome}', $5::jsonb, true)` with
    `status = 'FAILED'` and `lastError = error.message`, then rethrow `error`.
  - For ordinary errors, reset any remaining `IN_PROGRESS` row back to
    `status = 'PENDING', "startedAt" = null, "lastError" = error.message` and
    rethrow `error`.

In `MatchParticipantService.reconcileMessageImportMatchingIntentsWithAudit`
(and `MessagingMessageParticipantService.reconcileMessageImportMatchingIntents`):

- Query `core."deferredWorkspaceMigrationAction"` for `workspaceId`,
  `name = MESSAGE_IMPORT_MATCHING_INTENT_NAME`, `status = 'PENDING'` and
  `NOT (payload ? 'unsafeOutcome')` (and optional `id = intentId`), ordered by
  `"createdAt" ASC, position ASC, id ASC`.
- Atomically claim each row via
  `UPDATE ... SET status = 'IN_PROGRESS', attempts = attempts + 1, "startedAt" = now(), "updatedAt" = now() WHERE id = $1 AND "workspaceId" = $2 AND name = $3 AND status = 'PENDING' AND NOT (payload ? 'unsafeOutcome') RETURNING id, payload, attempts`.
- Validate `payload = captureMessageImportMatchingIntentPayload(row.payload)`
  (if invalid or containing `unsafeOutcome`, mark `status = 'FAILED'` and throw).
- Execute remaining pages from `payload.nextPageIndex` to
  `payload.pages.length - 1` with `isRecoveryReplay: true`.
- If a page fails during recovery:
  - If `isTransactionUnsafeToRetry(error)`: mark the remaining row `FAILED` with
    `jsonb_set(payload, '{unsafeOutcome}', ...)` and rethrow.
  - Otherwise, update the row from `IN_PROGRESS` to
    `attempts >= DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS ? 'FAILED' : 'PENDING'`
    with `"startedAt" = null, "lastError" = error.message` (retaining the latest
    committed `nextPageIndex` in `payload`) and rethrow.
