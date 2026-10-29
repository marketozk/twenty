# LOG144 bounded follow-up review

Read-only. Reviewed updated transient-database-error integration observer and current MatchParticipantService closed matching owner. No edits/runtime tests.

## Observer correction

The new `observedSaveScope` is assigned inside the first actual Participant writer invocation, not repository discovery. Later matching scopes still execute their real repositories, but no longer call the save-specific observer. Every current caller of this helper imports a fresh event/attendee or an existing event with a newly added attendee, so a save Participant write occurs first. Thus the current rollback injection, backend-PID and read/write/match-order assertions retain their intended scope. A future zero-participant-write save fixture should not reuse this observer as a generic save marker; that is not a failing assumption in the present tests.

## Closed owner

No additional concrete blocker found in the requested generated/default image and authority paths.

- Input IDs and operation are captured before awaits; original issued SYSTEM scope is checked, strict/exclusive transaction is owned internally, and workspace liveness is checked under lock and again after writes/audit.
- Source-table SHARE locks precede discovery/graph rows. Event parents precede child snapshots. Fixed source selectors plus original IDs and full graph rereads catch retained-row changes and new matching candidates introduced by same-transaction triggers.
- Moved requested Participant IDs remain snapshotted but are excluded from link updates unless their current parent is among supplied eventIds. Desired targets still include all live participants of those events, not merely updated candidates.
- `insertMatchingTargets` assigns UUIDs, computes expected images before INSERT, derives actual rows from RETURNING, compares complete JSON-text images and rejects inserted tombstones. Skipped rows remain absent; conflict-created extra rows are detected by graph reread.
- `castMatchingImage` reads actual column default/generated expressions, casts through the actual PostgreSQL row type, preserves before-image precision, applies only declared fields and server updatedAt, then recomputes generated columns against the resulting image. The standard target fields are UUID relations/assignment flags plus base timestamps; supplied IDs avoid reevaluating their UUID default. Non-deterministic custom defaults can conservatively fail equality rather than be accepted as an unverified trigger mutation. No claim of arbitrary volatile-default compatibility.
- Actual UPDATE RETURNING controls adoption of expected Participant/Target images; DELETE RETURNING controls removal. Incoming referential update effects and populated mutating target-delete references are checked before writes. Source/current graph validation precedes each phase and runs again after the single flush and deferred-constraint drain.
- Save and matching operation IDs are distinct; matching preserves actor/initiator/correlation and causation back to the committed save. Matching remains an internal import mutation authority, not a newly exposed user-edit API.

Actual PG/type/dependency checks remain the acceptance gate; this source review did not run them.
