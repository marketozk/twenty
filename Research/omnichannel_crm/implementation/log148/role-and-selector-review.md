# LOG148 role grants and selector preflight

Read-only review of repository sources and committed operational evidence.
No runtime inspection or database changes were performed.

## Runtime grants

The accepted LOG088 application smoke setup creates a distinct runtime role and
grants SELECT, INSERT, UPDATE and DELETE on all core and workspace tables.
It then revokes writes on core.forkMigrationLedger and grants only SELECT/INSERT
on crm_audit.crmAuditEntry. The new SHARE lock on core.messageChannel is compatible
with that existing table-level UPDATE grant profile.

The small native-message fixture instead grants SELECT on all core tables.
The cleanup fixture adds UPDATE(deletedAt) on core.workspace. It does not give
table-level UPDATE on core.messageChannel. Adding the specific messageChannel
grant in a test fixture establishes parity with the accepted application profile.
Do not turn that fixture gap into a broad production GRANT recommendation.

LOCK TABLE authority must be checked with the real PostgreSQL statement. A column
UPDATE grant used for row locking is not equivalent to a table-level UPDATE grant
for a stronger table lock. The targeted test should exercise the actual runtime
role and leave the append-only audit and migration-ledger restrictions in place.

compose.fork.yaml injects PG_RUNTIME_DATABASE_URL separately into server and
worker. The secret is external to the repository. These sources establish the
intended profile and the prior smoke profile, but cannot prove today's live
application role grants. Verify the configured role read-only before deployment.

## Existing lock precedent

delete-native-calendar-channel-associations-with-audit.ts already locks
core.calendarChannel IN SHARE MODE to protect a missing channel against raw
creation, with the existing eight-second lock timeout. It explicitly recognizes
the cross-workspace channel-write serialization. The proposed bounded rematch
page uses the same physical absence-protection principle for current APP policy.

Reusing a row-only or advisory-only policy would leave missing/new raw channels
or associations unprotected unless all writers participate. The inspected code
does not establish such universal participation. Keep the scoped page and current
lock timeout, and test real blocking plus rollback on timeout.

## Selector-validation precedent

CalendarEventParticipantMatchParticipantJob copies both arrays and captures its
system identity before awaiting the workspace lookup. Its page method validates
one selected mode at a time. It therefore provides copying and actor-capture
precedent, but does not prove validation of both modes before the first write.

ReconcilePersonCompanyTargetsJob copies one person-ID array and supplies named
system identity. Its service validates the operation and the full ID array before
performing writes. This is the closest existing complete-input preflight pattern.

For the new messaging job validate both arrays and all their element types before
the first await. Validate UUIDs for members, preserve arbitrary string email input
as currently supported, normalize/copy through the closed selector capture, and
then start person pages. A malformed member UUID should fail before any person
page commits. Do not introduce a 500-selector bound inherited from unrelated
cleanup helpers, since the rematch input had no such supported-input restriction.

## Source anchors

- Research/omnichannel_crm/implementation/log088/smoke.py::grant
- ops/omnichannel/compose.fork.yaml and README.md
- test/fork-migration/omni-native-message.fixture.ts::initialize
- test/fork-migration/omni-native-cleanup.fixture.ts::initialize
- engine/core-modules/crm-audit/delete-native-calendar-channel-associations-with-audit.ts
- CalendarEventParticipantMatchParticipantJob::handle
- MatchParticipantService::rematchCalendarParticipantsWithAudit
- ReconcilePersonCompanyTargetsJob::handle
- ParticipantTargetReconciliationService::reconcileTargetsForPeople

Source paths below packages/twenty-server use their existing module directories.
