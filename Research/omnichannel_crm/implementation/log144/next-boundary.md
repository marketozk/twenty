# LOG145 — calendar rematch boundary (read-only research)

Checked current Twenty CRM source after LOG144 owner integration. No application/tests/remote operations executed. Paths below are relative to `packages/twenty-server/`.

## Recommended next slice

Move the two **calendar-only lanes of CalendarEventParticipantMatchParticipantJob** to a closed audited rematch entry in the existing MatchParticipantService. Reuse LOG144 private source/graph/image/audit machinery with a closed `personOnly` / `workspaceMemberOnly` mode; do not call the import public method unchanged, and do not expose its scope/context/callback. Keep messaging and Person-company target job migration separate and explicitly open.

This is the smallest coherent next production writer: one existing job, one existing service, focused tests. Its listeners already produce the required selection hints; no actor payload migration or new module dependency is necessary. Nine exact shapes and fixed table locks are already available in this service. No new global allowlist or generic transaction protocol is needed.

## Actual producers and selectors

- `src/modules/calendar/calendar-event-participant-manager/listeners/calendar-event-participant-person.listener.ts:30–118` queues CREATED (after emails), UPDATED only when emails changed (before+after emails), DESTROYED (before emails). It does **not** subscribe to soft DELETE/RESTORE. Preserve this event coverage in this slice.
- `.../calendar-event-participant-workspace-member.listener.ts:28–76` queues CREATED with a nonempty userEmail, and UPDATED when userEmail changed. Payload is workspaceMember **IDs**, not old/new email addresses. No deletion subscription exists here.
- `.../jobs/calendar-event-participant-match-participant.job.ts:13–18,33–62` payload is `{workspaceId, participantMatching:{personEmails,workspaceMemberIds}}`. It first reads core Workspace and returns unless activationStatus ACTIVE; then people lane, then member lane. There is no catch or error rewriting.
- `src/modules/match-participant/match-participant.service.ts:1209–1258`: people lane reads live Participants by `LOWER(handle)=ANY(lowercased personEmails)`. It does not select by existing personId; the current calendar branch of withoutAppChannelParticipants returns the rows unchanged. It runs `personOnly` and reconciles targets.
- Same file `:1171–1204`: member lane reads live Participants whose **existing workspaceMemberId** is in the supplied IDs. It does not discover unlinked participants with a matching email. It runs `workspaceMemberOnly`; personId and all targets are untouched (`:1025–1026`). A new member event with no existing links therefore currently does nothing.
- Generic matcher matching candidate query remains Person withDeleted + createdAt ASC + existing primary/additional email filter, Member live/exactcase (`:1074–1159`). Reuse unchanged LOG144 selectors, not a different SQL email-normalization policy.

### One real legacy member quirk to settle explicitly

The member wrapper replaces each selected input's workspaceMemberId with null before passing it to the generic matcher (`:1192–1202`). The generic matcher skips when its proposed links equal that synthetic input (`:1139–1143`). Consequently:

1. no current email match => proposed null equals synthetic null => **no UPDATE, old DB member link remains**;
2. any current match => UPDATE is attempted, even if it is the same actual member link.

A new owner comparing against the actual before-image clears an unmatched old link and suppresses the equal-link UPDATE. That is a behavioral change, not an audit-only migration. **Recommended bounded correction:** state it explicitly as the stale-member-link fix in LOG145; compare proposed member with the actual locked before-image, write NULL when no current member matches, and skip actual equal links. Keep the same existing-linked-ID candidate selector, Person untouched, and no target DML. Do not perpetuate the incorrect link silently, and do not broaden CREATED member discovery to unlinked participants. A before/after regression should first demonstrate the legacy no-match case retains the old non-null ID, then show the new owner clears only that selected link; an equal-link test should prove no new audit/timestamp noise.

## LOG144 reuse and bounded selection

`MatchParticipantService.matchCalendarImportParticipantsWithAudit:140–369` currently accepts exact participant/event IDs, changes **both** links, and reconciles targets. It owns SYSTEM context + strict/exclusive transaction, captures operation before await with fresh UUID, and limits event IDs to 1000. It is not a scope-taking stage. Empty participant IDs already perform targets-only reconciliation for supplied events, but that does not solve safe job event discovery or dual-projection job routing.

Factor only a **private** matching stage out of that method. Import continues its current both-link mode and public API. New calendar-rematch entry obtains/fixes eligible live participants and parent IDs under the same issued owner, and chooses a fixed mode from its closed request. It must retain skipped/original participant identities and recheck handle/member selector plus parent after parent/participant locking. Do not pass a mutable participant entity snapshot from the job and treat it as authority.

Job selectors can span arbitrarily many events, so simply collecting everything and calling the <=1000 import API is incorrect. Smallest bounded implementation is keyset candidate pages (200 IDs, matching existing reconciliation conventions) followed by a closed, freshly revalidated page owner. Read-only discovery is a hint; actual IDs/links/parents are loaded and checked inside that owner. Page cursor must advance over skipped candidates. Each page has its own complete audit/commit; do not advertise whole-job atomicity. Copy criteria/operation before the first await and never catch an unsafe outcome to continue to later pages/lane. If a single whole-job transaction is selected instead, it needs explicit private shared-session composition, not nested calls to a terminal public owner.

Existing LOG144 methods to reuse: prepareCalendarMatching (issued capability/nine shapes/source SHARE locks/event FKs); readMatchingGraph and original-ID proof; readMatchingCandidates/readMatchingSources; castMatchingImage; updateMatchingRecords; target planner/write helpers; finishMatchingAudit. Member-only still validates the retained five-table graph and sources but does not run target DML. Person-only preserves workspaceMemberId from DB. Matching mutations must not make later discovery adopt trigger changes before the existing proof runs.

## Attribution and unsafe outcomes

- `src/engine/workspace-event-emitter/types/workspace-event-batch.type.ts:3–8` contains name/workspace/object metadata/events, **no authenticated actor/initiator**. Current queue payload also lacks attribution. Do not invent the original user's identity from Person/Member records.
- Use existing named system operation pattern from `src/modules/calendar/calendar-event-cleaner/jobs/calendar-channel-deletion-cleanup.job.ts:31–48`: systemMembershipCleanupIdentity(workspaceId, CalendarEventParticipantMatchParticipantJob.name) + membershipCleanupOperation, captured before workspace lookup. Independent pages receive fresh operation IDs with shared invocation correlation. This identifies the actual background reconciliation worker; it does not attribute the originating edit to a user.
- Preserve current ACTIVE precheck, plus owner's fresh workspace tombstone guard; do not claim the precheck fences activationStatus updates.
- `src/engine/core-modules/message-queue/drivers/bullmq.driver.ts:305–318` discards automatic retry for isTransactionUnsafeToRetry and rethrows original. Explorer `:261–288` preserves unsafe error across telemetry failure. New job should allow the original native/core unknown or known-postcommit error through; no job-level success wrapper/retry. This does not cover process crash/stall or manual replay.

## Person-company target job: exact adjacent gap, not silently closed

- `src/modules/match-participant/listeners/participant-target-person.listener.ts:31–46` queues only **undefined/null companyId -> defined companyId**, typically enrichment. It does not queue company replacement/removal, Opportunity changes, Person delete/restore. Do not expand those product triggers incidentally.
- `.../jobs/reconcile-person-company-targets.job.ts:19–23` calls reconcileTargetsForPeople with `{workspaceId,personIds}`; no actor, workspace ACTIVE check, or catch.
- `participant-target-reconciliation.service.ts:43–97` loops **messageParticipant then calendarEventParticipant**, chunks people and keyset-pages live participants (QUERY_MAX_RECORDS), reconciles each page in a separate ordinary transaction. Calendar desired targets derive from ALL live participants of selected event IDs, live Person, company's ID even if Company tombstoned, and live Opportunity; manual flags/tombstones follow computeTargetReconciliationOperations (`:124–156,288–386,390–478`).
- Safe later calendar-only adaptation can use LOG144 private targets-only stage, with owner-side fresh Person-linked Participant discovery/original-ID proof, preserving actual-only target effects. But do **not** call new audited calendar lane and then old reconcileTargetsForPeople unchanged: that would run an unaudited second calendar writer.
- Split the old method into an explicitly messaging-only remaining path and the new closed calendar path at the job/service boundary. MatchParticipantService already injects ParticipantTargetReconciliationService; injecting it back in the latter would create a cycle. The existing job can inject both exported services (`match-participant.module.ts:12–18`) or the same-service owner can own the calendar method while the target service exposes a specific messaging-only entry. This migration is a separate small slice after rematch, and must state that message targets remain legacy until their owner lands.

## Focused acceptance

1. Actual calendar job -> actual closed owner for Person email create/change/destroy hints: only matching live handles, casing/additional/trashed-Person parity, unchanged Member links, all-event participant targets.
2. Member lane: existing-link selection only, exactcase/live Member lookup, unchanged Person/targets; demonstrate and explicitly fix the no-match stale-link bug above, and assert equal actual links become a no-op. A CREATED member with unlinked same-email participant remains unselected.
3. Both lanes in one job, >200 candidates/>1000 aggregate events, skipped/reparented participant progress, no duplicate target/audit effects on already-reconciled later pages. Atomicity asserted per admitted page, not whole job.
4. Candidate moved or handle/member changed before owner => fresh skip/reselection per declared policy; drift after locking/inside trigger => rollback, no audit. Source resurrection/new matching source after baseline cannot be adopted.
5. Unknown COMMIT and known-postcommit error preserve same instance and stop subsequent page/member lane. Actual Bull queue no-retry behavior is already LOG126 evidence; use focused adapter regression here, not duplicate its Redis suite.
6. Existing fixture `test/fork-migration/calendar-import-matching-audit.postgres-spec.ts` supplies actual nine-table owner and source-lock tests. `omni-native-reconciliation.postgres-spec.ts:314–390` preserves legacy calendar matching; `:395–508` covers legacy member/person/target entry behavior and omni exclusions. Keep messaging controls intact. Listener payload tests should use actual listener classes and only mock the queue boundary.

No runtime/test evidence is claimed by this report. LOG144 checks are parent-owned and separate.
