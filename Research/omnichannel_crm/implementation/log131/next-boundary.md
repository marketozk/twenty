# Next: orphan messages, target reconciliation, then the closed sweep owner

The next bounded deletion owner accepts at most 500 message candidates and returns
actual deletedMessageIds plus affectedThreadIds from the deleted before-images.
Any association referencing a message, including a soft-deleted association,
retains that message. This makes the normal deletion graph Message→Participant;
association/junction records block deletion rather than disappearing implicitly.
Soft-deleted messages remain, preserving the former root selection behavior.

Require the actual association→message FK for concurrent reference fencing and
participant→message CASCADE for the audited child effect. Preserve retained roots
and participants, active workspace, exact snapshots and RETURNING, late ownership,
deferred-trigger draining and full rollback. Use the existing cleanup fixture and
both real PostgreSQL lock orders. Do not infer affectedThreadIds from all candidates.

ParticipantTargetReconciliationService uses live messages/participants and current
Person/Company/Opportunity links to compute desired targets. Reuse its existing
computeTargetReconciliationOperations rules: preserve tombstones, retain obsolete
manual assignments while clearing their automatic flag, and remove obsolete
non-manual targets. Audit actual INSERT conflict outcomes, UPDATE postimages and
DELETE RETURNING; do not substitute the preselected rows for actual effects.

Full sweep integration requires a closed transaction-owning orchestrator. Existing
terminal primitives must not be naively followed by mutations of their validated
graph. Private mutation stages should share one audit context and final effect
validators controlled by that orchestrator: perform all writes, verify, flush once,
drain deferred effects, verify again, then commit. Do not expose caller-controlled
mutation callbacks or optional skip-audit modes. Splitting the current whole-sweep
transaction into separate commits would change its existing atomicity contract.

Five call sites need captured attribution when connected: channel-cleanup job,
account-cleanup job, blocklist job, reset-channel command and remove-orphans command.
The account job currently sweeps the whole workspace. The remove-orphans command
must stop swallowing failures, particularly unknown commit outcomes. None of this
integration is claimed by LOG131; the current public behavior is unchanged.
