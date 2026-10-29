# Следующий участок: person-company targets

Read-only source findings; implementation and acceptance remain pending.

`ParticipantTargetPersonListener` queues `ReconcilePersonCompanyTargetsJob` only when companyId changes from null/undefined to a defined value. Replacement/removal, Opportunity changes and Person delete/restore are not selected. Preserve this trigger coverage unless a separate correction is justified.

`reconcileTargetsForPeople` has one production caller (that job) and one existing PostgreSQL test. It processes messageParticipant, then calendarEventParticipant, chunks person IDs and keyset-pages participants in separate ordinary transactions. Each page derives targets from all live participants of its parent events/threads. It has no trusted original actor and no ACTIVE precheck. Do not claim such a precheck already exists.

Calendar target derivation can reuse LOG144/145 graph, source locks, actual-effect proof and target planner without rematching participant links. The selector must be current live Participant.personId, with current parent/selector revalidation and original-ID proof. Keep source hints separate from authority. Per-page atomicity is the existing operational model; durable queue/recovery remains a separate gap.

The old two-object method cannot run unchanged after a new calendar pass: that would repeat an unaudited calendar writer. Its calendar branch must be replaced, while messaging remains explicitly accounted for rather than silently claimed covered.

## Dependency constraint requiring design work

The job currently imports only ParticipantTargetReconciliationService, which already depends on WorkspaceOrmManager. MatchParticipantService imports that target service. Injecting MatchParticipantService back into the target service creates a cycle; adding it directly to the job adds a new enterprise-reaching dependency edge. The guard compares new edges even when the source already reaches enterprise code (`check_enterprise_dependencies.py::inventory/violations`). Do not change the pinned baseline or hide the dependency through opaque token lookup.

Before implementation, select a proper reusable structural target-proof helper or an owner in the existing target service using its current dependencies. Reuse pure `computeTargetReconciliationOperations` and existing native audit primitives. Avoid duplicating the whole matching service or adding callback-based public transaction stages. Exact helper imports must pass the actual dependency guard; this note is not a successful design or runtime proof.

Acceptance must include actual calendar targets with unchanged participant links, manual/tombstone policy, current Person-linked selection, actual skipped writes, audit/deferred rollback, unsafe outcomes and messaging controls. No live deployment or customer-message change follows from this work.

Design follow-up: [selected design](next-design.md) and [independent review](next-design-review.md). Keep the owner in the existing TargetService and share only structural read-only proof calculations. Full operation validation before legacy messaging will reuse a pure extraction of the existing audit-context constructor validation, preserving its accepted principals and identifiers. No fake executor or narrower identity policy. Implementation/guard/runtime verification remain pending.
