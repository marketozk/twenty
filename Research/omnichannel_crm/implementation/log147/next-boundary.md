# LOG148 next boundary: messaging rematch before contact creation

Read-only source review after the LOG147 implementation was imported. No checkout edits or runtime verification. Parent-reported LOG147 test results are separate evidence. ROB765's sole acceptance table remains `Research/omnichannel_crm/implementation/rob765-progress.md`; this report proposes the next slice, not completion of its matching/contact-creation row.

## Recommendation

Next migrate the single production caller `MessageParticipantMatchParticipantJob`, with its existing personOnly and workspaceMemberOnly modes, to closed 200-participant audited pages. Reuse the existing native cleanup session and private target stage for person matching. Member-only pages must not invoke target reconciliation or mutate Person links. Keep the job's existing MatchParticipantService dependency and add no providers. Leave import matching and automatic contact creation as explicit later slices.

The strictly smallest branch is workspaceMemberOnly: it needs one participant field and no target writer. However, migrating both modes of this same small job is a coherent next caller boundary: one trusted identity, one copied selector payload, person pages then member pages, one correlation. It avoids pretending the job is covered after only one branch. A separate preliminary member-only slice is optional, not a new requirement.

Automatic contact creation is not a prerequisite: it produces Person changes which enqueue rematch through existing listeners. Making that downstream rematch audited first reduces the number of unowned follow-on effects when contact creation is migrated later.

## Actual remaining call graph

Paths below are relative to `packages/twenty-server`.

| Caller | Actual flow | Authority / transaction / outcome today |
|---|---|---|
| `modules/messaging/message-participant-manager/jobs/message-participant-match-participant.job.ts::handle` | `matchParticipantsForPeople` then `matchParticipantsForWorkspaceMembers` | Job accepts workspace and selector payload; no copied immutable operation, no job ACTIVE check, no explicit catch. Each generic method enters SYSTEM context and an ordinary transaction with default options |
| Person listener in the same module | Person CREATED with email; UPDATED when emails change (before+after addresses); DESTROYED with previous emails -> rematch job | Event payload becomes queue selector, not authenticated human attribution. No additional restore/delete trigger should be invented |
| WorkspaceMember listener in the same module | CREATED with userEmail and ACTIVE workspace; UPDATED when userEmail changes -> same job | ACTIVE check is only in created listener. Job/update path do not repeat it; do not claim otherwise |
| `services/messaging-message-participant.service.ts::matchMessageParticipants` | SYSTEM lite context -> generic `matchParticipants`, with no transactionScope | Only production caller found is aggregate below; matching updates and targets are not one explicit audited transaction |
| `modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service.ts::saveMessagesAndEnqueueContactCreation` | save message graph transaction -> enqueue contacts if enabled -> match participants (APP targetsOnly; others both fields) | Copies account/channel/expectedRun, but has no matching audit-operation parameter. Save has strict outcome only when expectedRun exists, otherwise default; post-save matching happens after save commit and queue add. Matching error does not undo the saved messages |
| Aggregate callers | `MessagingMessagesImportService`, `InboundEmailImportService`, `SentMessagePersistenceService`, `ApplicationMessageIngestionService` | Provider import, inbound email, sent message and ordinary APP ingestion have distinct request/system authority. Capturing a job actor at the low-level import wrapper would falsely replace these origins |
| `CreateCompanyAndContactJob` | `CreateCompanyAndPersonService.createCompaniesAndPeopleAndUpdateParticipants` | Serialized ConnectedAccount snapshot + contacts + FieldActorSource; no immutable audit identity or live connected-account validation in this job |

`WorkspaceDataSource.transaction` creates a native audit context only when `options.nativeAudit` is provided. Default SYSTEM transactions are not automatically audited merely because repository audit hooks exist. The rematch calls inspected here pass no nativeAudit options and no closed terminal owner.

## Generic matching semantics which must survive

Source: `modules/match-participant/match-participant.service.ts` around `matchParticipants`, `matchParticipantsForPeople`, `matchParticipantsForWorkspaceMembers`, `withoutAppChannelParticipants`.

- Person rematch discovers live participants by `LOWER(handle)` in the deduplicated lowercase before/after email set. It removes participants associated with any APP message channel, then removes actual omni-owned message IDs through the generic matcher.
- APP filtering is ONLY on the person rematch path. Member rematch does not call `withoutAppChannelParticipants`. An ordinary unowned APP participant is currently eligible for member rematch. Do not apply a blanket APP exclusion while claiming unchanged behavior.
- Member rematch selects participants whose CURRENT workspaceMemberId is one of the supplied IDs. It then overwrites that field with null in an in-memory copy before passing it to `matchParticipants`. This repeats the synthetic-null comparison defect fixed for calendar: no current email match can look like a no-op and retain the real stale DB link; an unchanged match can cause unnecessary update. New audited code must compare against the actual captured DB member value. No-match clears; equal actual value emits no update/audit.
- Generic Person query uses `addPersonEmailFiltersToQueryBuilder`, which deliberately calls `.withDeleted()`, and sorts by createdAt ASC. `findPersonByPrimaryOrAdditionalEmail` chooses primary-email match before additional-email match. This can attach a soft-deleted Person; target derivation subsequently excludes deleted people. Preserve that distinction unless a separate correction is explicitly approved.
- Primary email SQL matching is lowercase. Additional-email candidate SQL uses JSON containment with the lowercase input, while the in-memory finder lowercases entries. Do not silently normalize this asymmetry or change tie-breaking as part of auditing.
- WorkspaceMember query uses userEmail ANY with original handles; the final comparison is exact/case-sensitive. Do not silently lower it.
- Generic matching writes both personId and workspaceMemberId in updateMany even in one-field modes, but logically retains the opposite value. The new owner should update only the permitted field and prove the opposite field unchanged, avoiding stale-copy overwrites.
- personOnly reconciles targets globally over all live person-linked participants of the affected Thread; workspaceMemberOnly performs no target DML. APP targetsOnly import preserves caller-supplied links and only derives targets.
- Actual omni ownership is Conversation/MessageLink/AccountBinding based; APP channel type alone is not omni ownership.

## Proposed owner reuse and proof boundary

The existing `engine/core-modules/crm-audit/native-message-cleanup-with-audit.ts` already owns strict/exclusive issued-scope validation, private session, target stage, shared audit, deferred drain and target proof. LOG147 added a closed person-target selector page without exposing a mutable session. Extend through another narrowly typed closed messaging-rematch page, not a callback or public unflushed stage.

Suggested flow: job captures trusted named system identity and both selector arrays before await -> MatchParticipantService page adapter enters SYSTEM strict/exclusive -> new closed native owner captures immutable selector -> source/metadata fences -> bounded discovery -> parent-first graph locks -> exact current selector and original Participant/Message/Thread revalidation -> participant actual-effect update + audit -> existing private target stage only for person mode -> one finalize -> return discovered cursor.

Participant/source proof cannot be bolted onto the terminal public target function afterward. `reconcileTargetsStage` is private precisely so the same owner can compose before flush. In person mode it should receive only admitted affected threads while retaining the full-thread target derivation. A participant moved since discovery must not authorize either former-thread target cleanup or new-thread following. Keep full original-ID/absence proof through audit and deferred drain, including skipped hints, as in LOG147. Member-only must not read target state as a precondition for updating links unnecessarily.

Sources are read-only: WorkspaceMember for member matching; Person plus Company/Opportunity for person matching/target derivation. Use sorted source SHARE fences before discovery for absence protection, rather than claiming row locks protect non-existing email matches. APP policy additionally depends on current `core.messageChannel` and workspace `messageChannelMessageAssociation`; existing person filtering reads core repository outside the participant transaction. A new closed owner must capture and recheck the actual current APP-association policy on its executor and fence concurrent relevant channel/association changes. The exact minimal physical lock/proof design is still a DESIGN item, not established by this read-only report. Preserve scope semantics and avoid locking a child before discovering/locking its parent.

Reuse pure target planner and existing audit/actual-FK/generated primitives. Calendar matching implementation is an example of correct actual-member comparison, source proof and postimage handling, but copying its entire roughly 900-line owner or genericizing every calendar/email graph is not justified. The native target module already includes WorkspaceMember in its metadata type union; that fact alone does not implement a matching writer. A narrow participant stage still needs actual RETURNING, expected postimage, incoming ON UPDATE effects and final source proof.

The job has no current ACTIVE precheck; the native session checks existence/deletedAt, not activationStatus. Keep the existing job activation behavior unless separately chosen. Fresh page operation IDs, shared correlation, errors/unsafe outcomes propagated, no replay, people-before-member order and full-page cursor even all skipped are required. Earlier committed pages remain committed.

## Why contact creation is a separate later lane

`modules/contact-creation-manager/services/create-company-and-contact.service.ts` uses 100-contact batches. It reads UserWorkspace/account-owner membership, workspace internal-message policy, all WorkspaceMembers, and existing People including deleted records. It filters self/internal contacts, deduplicates handles, determines create/restore/name enrichment, then delegates to separate Company and Person services using SYSTEM repositories without a shared transactionScope.

- `CreateCompanyService.createOrRestoreCompanies`: domain primary/secondary matching including deleted companies, external HTTP company-info lookup with existing fallback, Company save, restoration update, position allocation.
- `CreatePersonService`: create with position allocation, restore by clearing deletedAt and possibly changing companyId, name-enrichment updates. All are separate context/repository calls.
- The aggregate's method name says UpdateParticipants, but it does not directly invoke matching or write participant links. Person events/listeners supply the follow-on rematch.
- Batch handling skips duplicate errors and captures other errors without rethrowing, then continues. Once audited/strict operations are added, unknown/confirmed commit failures must not be swallowed as a generic batch failure. This requires explicit orchestration review, not simply adding an audit option.
- Queue data contains a stale ConnectedAccount object and FieldActorSource for record createdBy metadata, not an authenticated audit principal. Fresh ownership/import-policy decisions and actor capture must be designed; createdBy is not a substitute for operation attribution.
- External enrichment must not be moved inside long held DB locks. Compute external suggestions first, then revalidate DB inputs and perform a bounded owned write. This is a recommendation for the later design, not an implemented transaction model.

Thus do rematch first, then separately cover import matching and the normal message-save audit boundary, then contact creation's Company/Person lifecycle. Import matching may be split from save, preserving the current commit-before-matching and queue-before-matching contract; do not assert that audited matching makes ordinary message import save audited.

## Required verification for the proposed rematch caller

- Actual job and page adapter: capture data/identity before first await, immutable payload, same correlation/fresh operation, person pages then member pages, errors and real lost COMMIT ACK stop continuation without retry.
- 200 candidate keyset pages, all-skipped full page, missing/deleted/moved parent, exact selector changed, full original-ID/absence proof through audit/deferred triggers.
- Actual-member regression: stale link clears, equal current match is no-op, replacement matches exact case, Person links and all targets unchanged in member-only mode.
- Person matching: primary precedence, additional-email candidate behavior, createdAt precedence, soft-deleted Person matching vs live-only target derivation; global other-participant targets retained; manual/tombstone/actual-effect behavior.
- Person-only APP exclusion, ordinary APP member eligibility, omni ownership from each path, current APP-association/channel-policy races and ownership changes during audit.
- Source absence blocking via raw writers, actual source immutability, skipped updates, generated refusal or verified generated handling, incoming update CASCADE refusal, audit/deferred rollback and strict outcome propagation.
- Regressions: `test/fork-migration/omni-native-reconciliation.postgres-spec.ts` (generic controls), LOG147 native-person targets, native-target owner suite, LOG144/145 calendar matching, current job entrypoint controls. Import tests still must prove save commit precedes matching; no calendar/import behavior should move accidentally.

## Dependency/license constraints

Keep the existing job -> MatchParticipantService edge. MatchParticipantService already depends on TargetService and WorkspaceOrmManager, while TargetService imports the native target facade after LOG147. Introducing reverse injection would create cycles; injecting another service into the job can add a new enterprise-reaching edge. A leaf export and structural scope types in the existing native owner are preferable, but do not guarantee guard acceptance. Run the actual enterprise dependency guard without baseline changes or opaque lookup. Type-only entity/querybuilder imports also count in the guard; prefer structural source records for any shared pure matching helper, and avoid importing the entity-typed email-querybuilder helper into the native owner. No commercial feature or license bypass is needed for this audited system writer.

The proposed owner/APP policy design still needs its own concrete design/review before implementation. This report selects the next caller and records facts; it does not claim new source locks, runtime semantics or tests already exist.
