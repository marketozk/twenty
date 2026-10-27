# ROB-764: remaining core metadata writer inventory

28.10.2026. This is a working T22 inventory, not an acceptance verdict.
Canonical lifecycle requirements remain in the implementation specification.

## Verified owners

- LOG052: pure DB account/channel metadata and APP channel mutations, ordered
  parent/channel locks and same-manager ownership/write boundary.
- LOG053: account identity immutable through generic metadata; new native bootstrap
  uses provider=app/null app-provider IDs. Ordinary provider writes match identity
  and exclude retained direct account bindings, including legacy provider types.
- LOG054: final disconnect/transfer/deleteMany transaction; native account network
  bypass; fresh locked child snapshot for truthful deletion events.

- LOG055: webhook message/calendar local status transactions, scoped snapshot parent
  pin, fresh full account ownership, and local commit errors separated from provider recovery.

## Remaining owners, in implementation order

Paths below are relative to `packages/twenty-server/src`.

| Owner | Observed gap / required check |
|---|---|
| `modules/messaging/common/services/message-channel-sync-status.service.ts` | Common update/broadcast, resetSyncStageStartedAt and conditional scheduling bypass final ownership. Existing pre-query exclusion is not atomic. Mixed batches must report only actual ordinary updates. |
| Same service + `modules/calendar/common/services/calendar-channel-sync-status.service.ts` | authFailed writes need account ownership, including an account owning another channel; not just the selected channel. |
| `modules/messaging/message-import-manager/services/messaging-process-group-email-actions.service.ts` + message-channel resolver | Pending action and cursor writes are separate; resolver writes pending action before protected metadata update. Move into an atomic owner, with current state checks. |
| `modules/messaging/message-import-manager/services/messaging-cursor.service.ts` | Channel/folder cursor writes after external work need final ownership protection. |
| Messaging import exception handler/messages-import/relaunch-failed job | Direct throttle/reset writes need the same final boundary. |
| `modules/messaging/message-import-manager/commands/messaging-trigger-message-list-fetch.command.ts` | Unfiltered channel selection → status update → enqueue. Protect owned APP channels and queue only admitted ordinary IDs. |
| `engine/metadata-modules/message-folder/message-folder-metadata.service.ts` and folder-action writers | update/setSyncStatus/delete/final cursor need current account/channel/folder ownership, not a point-in-time precheck. |
| Ordinary provider write predicate vs derived metadata ownership | LOG053 excludes direct retained bindings. Compare with `findOmniOwnedConnectedAccountIds` derived ownership through channel/message associations during final inventory; do not infer full derived-owner coverage from the direct-binding tests. |

## Required evidence

- Pause an external response, enroll/reparent, then resume: no protected local write.
- Actual PostgreSQL bootstrap/write serialization and ordinary behavior regression.
- Mixed batches exclude protected IDs from writes, broadcast, reconnect list and jobs.
- Keep unreadable ownership failures visible; no fallback that permits the write.
- Inspect call sites, existing transactions and lock order before adding a wrapper.
- Reconcile the final inventory with T05/T22 and run the relevant acceptance set.

Known current limits are retained until their code and tests pass. Nothing here
enables the public API, own ACL, transport, automation or a domain purge operation.
