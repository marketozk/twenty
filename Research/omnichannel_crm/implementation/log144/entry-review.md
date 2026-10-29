# LOG144 coordinator entry review

Read-only review of current dirty CalendarSaveEventsService, CalendarEventParticipantService and crm-audit-calendar-matching-entrypoints.spec.ts. Also checked their actual callers and existing calendar integration interception. No edits or runtime tests.

## Production result

No concrete blocker found in these three changes.

- SaveService passes its **captured actual save operation** after the save transaction returns (save service 545–565). That operation was copied and given its fresh ID before the first await (145–153), and the same operation is used by the save audit context (648). The coordinator's causationId therefore identifies the committed save operation rather than the caller's replaced original ID.
- ParticipantService captures actor, initiator, parent operation ID, correlation, all ID arrays, contact flag, linked contact values and account aliases before executeInWorkspaceContext (68–84). It creates a distinct matching operation and rejects absent/foreign workspace scope before reads/enqueue. Current sole production caller is SaveService; synthetic malformed actor/UUID input is not a demonstrated accepted public route.
- Existing enqueue-before-matching order remains unchanged. Queue failure prevents matcher invocation. Matching failure is not swallowed; ordinary failure is wrapped by SaveService as postcommit, while unsafe outcomes preserve their existing instance. No new retry or compensation occurs.
- Matching receives requested participant IDs and all returned event IDs, including empty participantIds. It no longer trusts earlier mutable Person/Member links or handles from the coordinator's prequeue lookup; the new closed owner must re-read them. The old queue payload's freshness/authority limitations remain explicitly outside LOG144.
- Search found no second production call requiring an auditOperation update. Existing two direct coordinator integration wrappers forward the args object, so the added field is preserved automatically. Fork-migration save suites replace the whole coordinator, so they do not need a new matcher stub method on their unused dependency.
- The new entry suite tests the real coordinator with isolated queue/matcher adapters and verifies capture, exact operation lineage, empty IDs, order, missing/foreign scope and ordinary/unknown failures. This is entry behavior evidence, not a substitute for actual matching PG acceptance.

## Actionable existing test-contract issue

`test/integration/google/calendar/transient-database-error.integration-spec.ts:44–97::observeParticipantWrites` identifies the save transaction solely by `commitOutcome==='strict' && nativeOwnershipLock==='exclusive'`. Its comment (60–61) explicitly assumes matching transactions do not have those options. LOG144 intentionally makes matching strict/exclusive too, so this observer now instruments both save and matching Participant writes.

Consequences: a matching update can add an unexpected `write` after the expected `['read','write','match']` assertion (274–324), overwrite the recorded save backend PID in the postcommit-boundary test, or receive a save-only injected failure in the wrong committed unit. Some current random-email fixtures may happen to generate no matching update, which would hide the broadened interception rather than make it correct.

Minimal correction: disarm the save-write observer at the existing coordinator entry boundary before delegating to the real coordinator, or explicitly restrict it to the first admitted save transaction in that import invocation. Keep matching's new transaction exercised separately. Do not weaken strict/exclusive options, skip the integration assertions, or mock the new owner to make this pass. A fixture with an actual Person/Member match should prove that the save observer excludes the later matching write.

## Remaining verification

The new closed matcher implementation and actual PG graph/authority proof were not part of this narrow review. Typecheck, entry tests and matching PG checks still determine acceptance. No runtime success is claimed here.
