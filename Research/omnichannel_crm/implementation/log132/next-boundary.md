# Next — target reconciliation and the closed orphan sweep

Reuse ParticipantTargetReconciliationService and its pure
computeTargetReconciliationOperations policy: live messages/participants and
people; company/opportunity links; preserve tombstones and manual assignments.

Audit actual INSERT conflict outcomes, UPDATE postimages and DELETE RETURNING.
Preserve source rows and retained targets; fence concurrent child references,
late ownership and deferred triggers. Do not introduce arbitrary mutation callbacks
or caller-selected skip-audit modes.

The complete sweep must own one strict/exclusive transaction and one audit context.
Private stages must retain validators until all mutations, then verify, flush once,
drain deferred effects, verify again and commit. Existing terminal LOG131/132
primitives cannot simply be chained and then modified.

Collect actual affectedThreadIds across message pages. Reconcile surviving affected
threads once, before empty-thread cleanup captures its final target snapshots.
This avoids repeating target changes for every message page; review and test the
resulting event behavior explicitly. Preserve the existing whole-sweep atomicity.

Wire captured system attribution at channel/account/blocklist jobs and reset/remove
commands; remove-orphans command must propagate failures, including unknown COMMIT.
Do not infer customer acceptance from isolated database tests.
