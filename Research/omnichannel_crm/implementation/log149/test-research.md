# LOG149 test research

Read-only source review against the checkout running LOG148 verification and the
proposed TEMP/log149-design.md. No source/runtime changes or new test results.

## Existing tests and their actual boundaries

| Existing file | Reusable coverage | Gap for this slice |
|---|---|---|
| test/fork-migration/ordinary-native-sync-run.postgres-spec.ts | Real aggregate save, real Message/Participant/folder services, strict expectedRun authorization, null identities, no-run callers, APP targetsOnly argument, concurrent replay | beforeEach replaces matchMessageParticipants with a resolved spy. The suite proves save and handoff behavior, not matching transaction effects |
| test/fork-migration/omni-sync-status.postgres-spec.ts | Actual provider importer methods instantiated with collaborators, unknown outcomes, requeue/status handling and channel/run races | Add only new confirmed-postcommit classification and attribution/descriptor propagation cases |
| test/fork-migration/omni-app-ingestion-guard.spec.ts | Actual application ingestion service, owned-channel rejection, identity validation, cache lock and result mapping | Aggregate is mocked, core query returns synthetic ownership, invocation has no real request audit context |
| test/fork-migration/crm-audit-sent-draft-entrypoints.spec.ts | Actual resolver control flow and workspace auth ALS, draft capture-before-await, exact cleanup target, provider success despite unknown/confirmed cleanup errors and failing logger | Capture currently covers drafts. Its explicit non-draft-no-cleanup-identity test must evolve to general send attribution while retaining the non-draft principal contract |
| src/modules/messaging/message-outbound-manager/resolvers/__tests__/send-email.resolver.spec.ts | Translation/error responses and linking sent thread to a record | Preserve these controls, update changed mock method signatures only |
| test/integration/resend/suites/inbound-email-reply-threading.integration-spec.ts | Actual full Nest inbound service, references/reply threading and channel separation | Depends on integration environment and covers reply behavior, not new matching/audit authority |
| test/integration/resend/suites/inbound-email-body-text.integration-spec.ts and inbound-email-exclude-group-emails.integration-spec.ts | Body and spam/group-email behavior | Keep as compatibility controls rather than copying their large setup |
| test/fork-migration/crm-audit-attribution-context.spec.ts | Actual audit ALS capture, concurrent context separation, application/agent/API key attribution and initiator preservation | Reuse the setup pattern at new origins, not mock capture as proof of real actor extraction |
| test/fork-migration/crm-audit-native-message-rematch.postgres-spec.ts | LOG148 actual Participant/Target proof, raw SHARE blocking, generated afterimages/FK refusal, deferred effects and ACK loss | Preserve as regression for the extracted private stage. Add import-specific tests rather than copying all rematch cases |

## Fixture choice

Use the existing real native message fixture for the new closed import owner.
Required workspace tables are the LOG148 person-mode graph plus WorkspaceMember,
with actual standard FK actions. Cleanup fixture provides the graph and genuine
binding/link/conversation markers. Its core schema needs explicit extension for
new authority descriptors.

ordinary-native-sync-run has a useful existing core-schema setup. It adds account
workspace/provider/applicationId/connectionProviderId/aliases/archivedAt and channel
account/sync/stage/startedAt, and grants runtime writes on core tables. It does not
already supply the complete sent/app user/member/application authority schema.
Create only the exact additional columns/rows read by the reviewed owner. Existing
core user/membership/sent-cleanup PG tests are patterns for those rows and grants.
Do not assume the tiny cleanup account/channel tables are full entity fixtures.

Prefer one new PG owner suite for all discriminated authority descriptors with
shared real dataSource. Use separate small origin/aggregate orchestration tests
where queue/provider services are mocked. At least one real aggregate test should
construct the real matcher instead of the current matchMessages resolved spy.
The full HTTP guards remain a separate acceptance boundary.

## New explicit-selection tests

1. Save results contain two participants in one message, but only one is touched.
   Both-fields matching updates only the touched participant. Preserve the other
   participant's manually maintained Person/Member links, while targets derive
   from both current rows. This is the essential selector regression.
2. Empty touched Participant list with nonempty Message references refreshes
   targets. No Participant DML or audit may be invented. Empty both sets is a
   validated no-op.
3. An identity-updated existing participant is included even though its row was
   not newly inserted. A structurally unchanged row is omitted. Verify this by
   invoking real saveMessageParticipants/aggregate, not handcrafting both lists.
4. Both Person and Member change in one transaction and one Participant diff.
   Audit failure rolls both back together with target effects. Reuse existing
   matching behavior controls for primary/additional/case/withDeleted semantics.
5. APP targetsOnly retains non-email handles and caller-supplied Person/Member
   references. Member matching source reads are unnecessary for target refresh. Standard ORM relationship metadata remains available.
   A channel type change cannot convert the captured mode silently.
6. Equal duplicate manifest references deduplicate. Conflicting duplicate IDs,
   foreign workspace references or Participant Message IDs outside the explicit
   pair set fail before any dependent save/matching write.
7. More than 200 touched participants sharing one Message preserve all touched
   IDs across pages. A separate untouched Message still gets its target-only
   page. More than 200 explicit Messages with zero touched participants paginate
   independently. Distinct page operations retain the captured correlation.

## Admission and original-reference proof

Use explicit save-derived Message/Thread pairs as independently authorized roots.
A touched Participant moved or manually relinked after capture is skipped, but
its original still-admitted Message may refresh targets using the actual current
graph. This intentionally differs from LOG147/148 selector-root admission.

Move an explicit Message to another Thread after capture. Neither follow the new
parent nor clear targets under the stale parent unless another independent valid
Message reference admits it. Keep an unrelated admitted reference to force audit
and deferred finalization while mutating the skipped original again.

Cover Participant saved handle/Person/Member drift, original row absence and
deferred resurrection. Match candidates only from admitted touched rows. Initial
Target and source proof must reject Participant-triggered changes before the
target stage captures its baseline. These are the import-specific variants of
the existing LOG148 proof tests.

## Authority matrix in real PostgreSQL

- Provider uses actual lockOrdinaryNativeSyncRun. Change startedAt/stage/channel
  account/sync eligibility in the gap after save and before matching. Stale matching
  produces the agreed no-apply outcome and prevents false completion status. Test
  type/mode agreement and retained current account/channel images after deferred
  triggers. Preserve microsecond startedAt equality through actual SQL types.
- Inbound resolves EMAIL_GROUP recipient/channel/account. Change the recipient
  handle or relation before matching, or during audit. Require explicit failure.
  isSyncEnabled=false must preserve the existing inbound eligibility described by
  the design. Check source cleanup occurs only after successful import completion.
- Sent includes current member, optional effective user and current account scope.
  Test private owner vs WORKSPACE scope, deactivated user/member, account transfer,
  and mismatch after provider send. Record the match failure separately while the
  external send response remains successful. Test descriptor provenance with
  user/API/OAuth/application non-draft request identities supported by the guard.
- Application requires its current application/account/channel workspace relation,
  APP type, app provider and sync enabled. An absent request member keeps the
  existing background-application private-account behavior. A supplied foreign
  or removed member fails. Test another application, account transfer and late
  authority mutation. Avoid inventing an application-state gate in tests.
- Every explicit Message requires an association with the captured exact channel.
  A Message belonging only to another channel is rejected/skipped according to
  the reviewed outcome contract. New, moved, deleted and deferred Association
  rows need the same current policy proof and raw-writer blocking checks.

## Origin and orchestration cases

Capture identity/authority before external awaits, then mutate original request
objects or ALS payloads inside the first await. Verify the captured operation,
initiator and descriptor reach save/matching unchanged. Missing operation fails
before save. Browser message participant IDs cannot change the audit actor.

For sent non-draft cases, install actual request audit ALS. The old test invoking
the resolver with no request context while skipping cleanup attribution no longer
establishes the new attribution contract. Exercise the supported principal types
through actual captureCurrentCrmAuditIdentity patterns and keep guards/decorators
substituted only as in the existing resolver suite. Test account-owner ID differs
from the authenticated application/API identity so actor reconstruction is caught.

For application tests, reuse existing cache/ownership controls and wrap the call
in actual withCrmAuditRequest/captureCrmAuditRequest. A mocked capture return alone
cannot prove trusted application/agent/initiator selection. Provider/inbound get
named system actors from their actual entry points and resolved workspace.

Assert order using real save visibility and call sequence. COMMIT must precede
contact queue add, which precedes matching. A queue failure leaves saved rows and
does not start matching. A matching rollback leaves the earlier save committed.
The incoming manifest must be captured before queue waits can mutate the saved
result objects.

## Unsafe outcomes and recovery gap

Provider catches must propagate unknown and confirmed-postcommit errors before
requeue, exception handler and completion-monitor updates. Ordinary failures
keep existing provider handling. Exercise both full and recent import entry
points without duplicating all provider fetch/filter tests.

Sent failure tests should cover matching ordinary error, unknown COMMIT ACK and
confirmed-postcommit error after actual provider success. Assert send called once,
successful external response retained and no recovery path calls send again.
Logging failure must also preserve that response, as existing draft tests prove.
Inbound failure blocks external source cleanup. Application failure propagates.

Keep an explicit regression documenting the lost touched-set recovery gap.
First save commits and matching fails. Identical second save returns no touched
participants. Its target-only refresh must not silently rematch historical rows.
Record the unmatched links as pending durable recovery, rather than asserting the
overall import succeeded. This test prevents an unsafe broad-rematch shortcut.

## Verification scope

Run new PG owner cases, actual aggregate/entry adapters and affected existing
fork suites first. Include LOG148 rematch regression after private-stage extraction.
Then differential types and dependency guard with unchanged baseline, migration
checksums and approved broader fork pattern. Full Resend integration suites need
their own environment and must be distinguished from the isolated tests.

The new touched-set, current authority, page and irreversible-send cases are the
specific missing coverage. Existing exhaustive generated/FK/source tests should
be reused wherever the private stage's contract remains identical.
