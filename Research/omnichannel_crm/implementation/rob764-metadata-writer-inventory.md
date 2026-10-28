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

- LOG060: group worker captured parent/action/settings/microsecond timestamp, guarded strict native chunks, stale stop, atomic finalizer and native unknown propagation. Prior committed chunks are not rolled back.

- LOG061: folder action current parent/action/exact versions, same-native-transaction cleanup pages, exclusive deletion finalizer, current-hierarchy import finalizer and strict selected Gmail label. Previously committed pages remain committed. Legacy direct deletion call contract unchanged.

- LOG062: folder discovery captures fresh identity/policy/folder set before network; applies only an unchanged snapshot in one ordinary transaction and returns stored pending actions. Null stops downstream list-fetch; initial ongoing status precedes discovery. IMAP unknown commit propagates.

- LOG063: seven provider writers use complete derived ownership under shared fence/account write lock; Google/MS/IMAP strict outer owners, same-manager app readback, fresh SSO scopes and unknown commit propagation. IMAP archived re-enable pins child parent. Postcommit reset/enqueue remains below.

- LOG064: reconnect reset/schedule atomically checks captured parent and current eligibility; accepted IDs only, queued expected-parent and guarded current read. Postcommit cache provenance remains below.

- LOG065: all five message cache owners use account-scoped v2 keys; captured-account clear/progress, legacy-only old cleanup and guarded legacy reset/refetch preserving pending actions. No same-account request isolation or cross-store atomicity claim.

- LOG066: four direct schedulers use guarded accepted descriptors; two import jobs check current expected parent/stage, two watchdogs recheck timestamp/stage under the same owner. SQL/queue are not atomic.

- LOG067: message list cron/CLI preserve accepted account; webhook reads scheduled current owner. Member blocklist resets pin account/custodian, global scope supersedes member. Per-account member resets are not one atomic batch. Fresh full fork suite recorded.

- LOG068: notification account pin before scheduling, qualified queue dedup with legacy compatibility, calendar current scheduled read and pinned IMPORT_PENDING inline gate. Provider internals and Microsoft subscription lifecycle remain below.

- LOG069: all four calendar cache owners use captured account v2 key; retained legacy reset/refetch before fetch/import, known-commit deletion only. Cursor/notfound/unknown error reset/flush parent-pinned. Successful callback/native lifecycle remains below.

- LOG070: Microsoft lifecycle and subscription claim/renew/delete/clear/recovery compare captured account/externalId/clientState/status/expiry under existing owner lock; OAuth unknown commit propagates without failure mutation. Local CAS only, external operations are not fenced.

- LOG071: direct message/calendar import admission is atomic, current entities are loaded under lock; exact DB run token guards completion/failure/retry/reset. Legacy recovery token copied before cache awaits. Redis side effects, scheduling producers and native apply remain separate below.

- LOG072: message list-fetch/recent onboarding claim current account/stage atomically. Recent handoff rotates proof once, finishes or recovers through full fetch without syncedAt. Cursor and scheduling callbacks carry proof; job no longer retries errors without owner. Redis/native apply remains below.

- LOG073: calendar list-fetch atomic admission and fresh entities, run-guarded legacy/error path, cursor+status finalization in one owner transaction. Declined result stops webhook inline import. Native association/orphan cleanup and Redis side effects remain below.

- LOG074: native message/calendar aggregate locks exact current run within existing strict native transaction; calendar reads/build/writes use that owner. Decline stops completion and postcommit jobs; accepted postcommit effects still have no run proof. Full fork regression refreshed.

## Remaining owners, in implementation order

Paths below are relative to `packages/twenty-server/src`.

| Owner | Observed gap / required check |
|---|---|
| Message run side effects | Admission, recent/full distinction and cursor/scheduling metadata callbacks covered by LOG071–072. Native save is covered by LOG074. Account-scoped Redis publication/requeue/monitoring, native cleanup and accepted postcommit effects still need final contract coverage. |

| Calendar provider native side effects | Metadata stage/cursor/run callbacks covered by LOG071/073. CalendarFetchEventsService association deletion/orphan cleanup still require run guard inside their native transaction; Redis publication remains outside SQL. |
| Native provider cleanup and postcommit effects | Aggregate run guard covered by LOG074. Message/calendar association + orphan cleanup require proof inside their native owner. Accepted contact creation/rematch postcommit effects currently have no run proof. |
| Legacy list-fetch downstream cache/cleanup callbacks | Final completion is parent-pinned (LOG058); intermediate cache mutations and cleanup are separate. Review with group/folder scope before claiming complete callback lifecycle protection. |

## Required evidence

- Pause an external response, enroll/reparent, then resume: no protected local write.
- Actual PostgreSQL bootstrap/write serialization and ordinary behavior regression.
- Mixed batches exclude protected IDs from writes, broadcast, reconnect list and jobs.
- Keep unreadable ownership failures visible; no fallback that permits the write.
- Inspect call sites, existing transactions and lock order before adding a wrapper.
- Reconcile the final inventory with T05/T22 and run the relevant acceptance set.

Known current limits are retained until their code and tests pass. Nothing here
enables the public API, own ACL, transport, automation or a domain purge operation.
