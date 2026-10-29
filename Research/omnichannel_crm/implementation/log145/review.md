# LOG145 independent implementation review

Read-only source review of the current working tree. No application files, runtime, test environment or Git state changed. Read CLAUDE.md, LOG145 research/design review, the matcher/job diff and focused PG/job tests.

## Verdict

No concrete blocking defect found in the reviewed change. Runtime and type acceptance remain parent-owned; this review does not claim that any tests passed.

## Verified source behavior

- `MatchParticipantService.rematchCalendarParticipantsWithAudit` captures and validates the closed selector, cursor, workspace and audit operation before awaiting context loading. Each page creates a fresh operation ID and preserves captured correlation/actor/initiator. It owns the strict/exclusive transaction; no public scope/callback is accepted.
- Page discovery occurs after `prepareCalendarMatching`, which checks the issued SYSTEM scope and obtains workspace/source/graph table locks. The discovery SELECT is unlocked, ordered by UUID, limited to 200 and uses the existing live handle/member-ID selector. Parent Event graph locks precede Participant locks through CALENDAR_SAVE_TABLES. Original discovered participant IDs remain in graph readback even after a move.
- `runCalendarMatchingStage` compares the locked participant's current parent with its exact discovered parent, then rechecks the current selector. Initial deletion/move/selector drift skips that participant. The cursor uses the final discovered ID, not affected/audited IDs; a full skipped or unchanged page therefore still progresses.
- Proof roots and target roots are separated. Rematch target roots are reduced to admitted current participants' parents. Both desired targets and existing targets are filtered by those roots, so excluded old-parent targets are retained rather than pruned accidentally. All live participants of admitted events contribute targets.
- Person-only writes only personId and retains workspaceMemberId. Member-only writes only workspaceMemberId and bypasses target planning/writes entirely while keeping graph/source validation. Comparing with the actual before-image explicitly fixes unmatched old member links and avoids equal-link writes. The member selector remains existing-linked-ID only; newly created members do not broaden discovery.
- Import delegates to the same private stage in both mode with its explicit event IDs, including the empty-participant/targets-only case. Existing helpers continue actual RETURNING, expected generated images, incoming FK guards, audit flush and deferred final proof. A direct source comparison confirmed the legacy `getParticipantRepository`-to-EOF suffix is unchanged from HEAD.
- `CalendarEventParticipantMatchParticipantJob` copies both arrays and creates the named worker identity before its workspace lookup. The ACTIVE precheck remains. Person pages run before member pages with independent cursors. There is no catch/retry/normalization around page calls, so ordinary/unknown/known-postcommit errors stop further pages and propagate as the same instance. Each page is independently committed; whole-job atomicity is not claimed.

## Test coverage reviewed

The added PG cases use the real matcher and existing LOG144 fixture. They demonstrate the legacy stale-member behavior before the new-owner correction, preserve opposite links/targets, exercise 201 candidates and a full skipped page, retain page-one commit after page-two audit failure, and check exact late-effect failure causes. The moved-parent test retains old-parent targets. Job tests exercise capture, ACTIVE, lane order/cursors and exact error propagation with a page adapter.

The seven-page job test proves orchestration beyond the import cap; it is not a 1000-event PostgreSQL performance or full application acceptance test. Concurrent raw matches inserted behind the cursor can require another job, consistent with the documented per-page scope. Source SHARE locks are workspace-table-wide and the page bounds discovered candidates rather than the entire graph of their events. These are explicit limits, not newly introduced completion claims.

## Parent execution evidence

The initial focused run passed all 85 cases in four suites, including 11 new actual PostgreSQL scenarios and 10 job entry scenarios. No first-run failure occurred. Dependency guard and 26 guard unit tests passed; 10 migration checksums are unchanged. Differential types passed on 424/425 roots with 225/225 diagnostics and no new or changed-file diagnostic. The root set differs from LOG144 because its application integration test is no longer changed/imported as an extra root; the lower baseline count does not mean those existing application diagnostics were fixed. Full-server typecheck is not claimed. Broad regression is recorded separately after completion.
