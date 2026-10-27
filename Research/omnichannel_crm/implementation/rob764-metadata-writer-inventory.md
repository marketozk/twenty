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

- LOG056: message/calendar sync status batches, atomic folder reset/auth failure,
  postcommit actual-ID effects, captured credential-failure parent, import unknown
  commit propagation, and Microsoft reset after commit with actual channel IDs.

- LOG057: cursor final writes and atomic folder/channel reset, fresh DB cursor
  comparison; resolver settings + derived pending action in one UPDATE, locked
  account administration recheck. The group worker cleanup remains below.

- LOG058: atomic temporary count/retry/stage, fresh threshold, message import
  completion parent pin and pending/reset, fresh relaunch CAS, committed accepted
  CLI scheduling IDs. Intermediate legacy list-fetch cache lifecycle is not SQL-atomic.

- LOG059: generic folder create/update/setSyncStatus/delete use the fresh account/channel/folder owner, current custodian, stable locks and same-manager readback. Background orchestration remains below.

## Remaining owners, in implementation order

Paths below are relative to `packages/twenty-server/src`.

| Owner | Observed gap / required check |
|---|---|
| `modules/messaging/message-import-manager/services/messaging-process-group-email-actions.service.ts` | Cleanup/final reset writes still need current parent/action guards and atomic channel/folder finalizer. Resolver marker/settings now atomic (LOG057); do not hold a new core transaction across existing nested cleanup transactions. |
| Folder-action and sync-folder background writers | Generic metadata create/update/setSyncStatus/delete protected in LOG059. Multi-step background cleanup, folder discovery and final pending/cursor reset still need captured parent/action checks across their own transaction boundaries. |
| Legacy list-fetch downstream cache/cleanup callbacks | Final completion is parent-pinned (LOG058); intermediate cache mutations and cleanup are separate. Review with group/folder scope before claiming complete callback lifecycle protection. |
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
