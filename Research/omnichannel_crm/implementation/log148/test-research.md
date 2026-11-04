# LOG148 test research

Read-only source review in Twenty CRM at the LOG147 base. No runtime commands,
checkout changes or test results are claimed. This report supplies the focused
test plan for the new messaging rematch owner and existing job.

## Reusable fixture

Prefer `test/fork-migration/omni-native-cleanup.fixture.ts` for the new PostgreSQL
suite. It wraps `createOmniNativeMessageFixture` with real standard metadata,
standard FK delete actions, all fork migrations, unprivileged runtime pool and
real WorkspaceDataSource transactions. WorkspaceMember, Person, Company,
Opportunity, Thread, Message, Participant, Target and Association are available.
`seed('binding' | 'link' | 'conversation')` supplies ordinary and protected graphs.
Use its `seedNative` only for fixture construction. Execute tested operations
through the ordinary real dataSource transaction with strict/exclusive options.

The existing native-person-target suite already demonstrates this fixture with
actual audit rows, independent writer connections, deferred triggers and COMMIT
ACK interception. Add a focused new rematch suite rather than copying all target
owner cases. Retain existing target tests as regression coverage.

The alternative `omni-native-reconciliation.fixture.ts` exposes a real matcher,
but includes extra calendar tables and defaults FK deletion to NO ACTION. Its
generic behavior tests should remain regression controls. For actual new public
adapter verification, instantiate MatchParticipantService with the small real
WorkspaceOrmManager adapter pattern already used in calendar-import-matching-audit.
This exercises actual repositories and transaction scopes while substituting DI.

Base fixture grants SELECT on core tables. Cleanup fixture adds UPDATE(deletedAt)
on core.workspace so the existing workspace lock works. A new SHARE table lock
on core.messageChannel requires an applicable write privilege. Verify the actual
PostgreSQL error and grant the narrow corresponding fixture privilege explicitly.
Do not treat insufficient privilege as evidence that APP policy rejected a row.
The core channel table initially has id/workspaceId/type; cleanup adds handle and
connectedAccountId. The owner should select actual required policy fields and
full physical row JSON without assuming unrelated entity columns in this fixture.

## Focused functional cases

1. Member stale-link regression. A participant currently refers to selected old
   member, but its handle matches no live member. Clear the persisted link and
   record one Participant audit. Preserve its Person and all target images.
2. Member unchanged match. Current member email exactly equals handle. Verify
   no Participant update and no audit. This catches synthetic-null comparison.
3. Member replacement and case behavior. A selected old member changes email,
   another live member matches the exact original-case handle. Replace the link.
   A case-only email difference and a soft-deleted member must not match.
4. Person primary precedence. An older additional-email candidate and newer
   primary-email candidate match the handle. Primary wins. Within candidates of
   the same category use differing createdAt values to prove current ordering.
5. Additional-email SQL asymmetry. Lowercase additional entry is a candidate.
   An uppercase-only additional entry without another SQL matching address is
   not selected by current JSON containment. Also test a Person admitted by a
   different matching handle whose additional entry matches case-insensitively
   in the finder. Preserve the original candidate-query/finder composition.
6. Person soft-deleted selection. Matching may attach the deleted Person because
   candidate lookup uses withDeleted. Target derivation excludes that Person.
   Assert the distinction using actual link and target rows.
7. Person-only updates preserve member links. Reconcile all live participants
   of admitted threads so another person's targets survive. Include manual and
   tombstoned targets. Existing target suite covers broader DML effects.
8. APP policy matrix. Ordinary APP message excludes person-only rematch but
   remains eligible for member-only. A Thread containing APP and ordinary
   messages must use actual message associations. Omni-owned rows remain
   protected in both modes for binding, direct link and Conversation markers.

## Page selection and concurrency

- Use 201 deterministic participant UUIDs. Check two pages, independent cursors,
  shared correlation and fresh audit operation IDs on pages that actually write.
  For an entirely skipped first 200-row page, cursor must still reach its last
  discovered UUID and the second page must execute.
- After discovery and before parent locks, move a Participant to another Message,
  move Message to another Thread, change the selected member ID/handle, soft-delete
  or delete selected rows. Exact former-parent targets remain intact. A second
  admitted hint should still allow unrelated valid work in the same page.
- Original IDs need final proof. Move an original Message outside every admitted
  graph after discovery, then alter it again using a deferred audit trigger while
  another root writes. Require the specific source-proof refusal and full rollback.
  Repeat for an originally absent Participant resurrected at deferred drain.
- Source absence fences need real raw writers and pg_blocking_pids, not sleeps.
  Insert a Person/WorkspaceMember email match from an independent connection while
  the new page holds its source SHARE lock. Prove blocking, release the page, then
  verify deterministic matching on the next call.
- APP channel/association policy has separate fences. A raw channel-type UPDATE
  and a new APP association insert must wait for the page. Also seed a writer
  before page acquisition so its committed policy is read by the page. Same-
  transaction audit/deferred triggers can bypass their own locks, so mutate
  channel type and association membership there and require atomic refusal.

## Actual writes, proof composition and outcomes

- Member-only must avoid target planner and target DML. Parent design decision
  permits read-only Target metadata/snapshots to prove target immutability. Test
  a Participant UPDATE trigger that mutates a Target and require rollback.
  Member mode should not require matching-source Person/Company/Opportunity
  queries solely to choose a member. Existing opposite-field/source proof must
  retain actual Person values on Participant.
- Person-only participant effects must be verified BEFORE private target stage
  takes its source snapshot. Add an UPDATE trigger which rewrites an unexpected
  Participant field or inserts another Participant. The subsequent target stage
  must not legitimize that mutation by treating it as fresh baseline state.
- BEFORE UPDATE RETURN NULL proves skipped DML emits no false Participant audit
  and target derivation uses actual retained links. If a mixed page updates only
  some participants, audit exactly those RETURNING IDs.
- Use actual standard Participant generated-field metadata. Preserve its original
  physical definition in finally when replacing an expression for the test.
  Verify generated postimage behavior agreed in design, then a populated incoming
  ON UPDATE CASCADE dependant of an actually changed generated field. First prove
  the raw cascade in a separate rolled-back probe, then require the audited
  refusal with the expected cause and unchanged dependant/graph/audit rows.
- Audit append failure and deferred participant/source/target mutations roll back
  Participant updates and targets together. Assert all relevant graph snapshots,
  no audit, and no emitted success events.
- Real lost COMMIT ACK must throw only after executing the actual COMMIT. Assert
  committed data and audit remain, the same unknown-outcome reaches public adapter
  or job, later pages/modes do not run and no misleading success events appear.

## Job and adapter entry points

Use `crm-audit-calendar-rematch-entrypoints.spec.ts` as the small job-test pattern.
MessageParticipantMatchParticipantJob has only MatchParticipantService injection
and currently has no workspace ACTIVE lookup. Preserve that existing entry shape.
Check person pages before member pages, separate cursors, empty modes, more than
five full pages, a named system principal and shared correlation. Mutate payload
arrays/workspaceId inside the first awaited page stub and assert subsequent calls
retain captured values. Propagate ordinary, unknown and confirmed-postcommit error
objects by identity and stop continuation. Mock-based tests establish orchestration;
the PostgreSQL suite establishes actual owner authority and mutation behavior.

## Harness details which avoid known false failures

- Query interception supports both string+values and pg QueryConfig.values.
- Restore a pooled client's query spy in finally after each observed transaction,
  rather than waiting until afterEach when the public method pages repeatedly.
- Declare async wrappers explicitly because fixture.withContext has a generic
  value-or-Promise return type.
- Inject an error only in the intended operation. Source SHARE/COMMIT observers
  that match every strict transaction can hit the wrong mode or preliminary page.
- Match exact underlying causes and preserve initial failing logs. A generic
  rejects assertion can pass due to an unrelated schema/grant mistake.
- The minimal runtime role and full physical standard schema are valuable test
  contracts. Add required grants or tables explicitly with a recorded reason.

## Existing regression evidence to rerun

- `crm-audit-native-person-target-reconciliation.postgres-spec.ts` for LOG147.
- `crm-audit-native-target-reconciliation.postgres-spec.ts` for reused target stage.
- `omni-native-reconciliation.postgres-spec.ts` for generic person/member/APP controls.
- `calendar-import-matching-audit.postgres-spec.ts` and calendar rematch entrypoints
  for existing owner behavior and any shared pure matcher/type changes.
- Differential types, dependency guard without baseline changes, fork migration
  checksums, and broader approved fork-migration pattern after focused passes.

The proposed cases concern concrete new matching mutations, policy races and
failure composition. Existing generic cleanup tests need no duplicate copies.
