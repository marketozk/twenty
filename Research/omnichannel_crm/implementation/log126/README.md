# LOG126 — no automatic retry after committed or uncertain transaction effects

The actual BullMQ worker now calls discard and rethrows the original error for
NativeTransactionOutcomeUnknownError, OmniCoreTransactionOutcomeUnknownError and
CoreAuditPostCommitError. Remaining attempts/backoff do not replay those failures;
the job remains visibly failed. Ordinary failures retain their existing retries.

Explorer reporting cannot replace these errors if telemetry fails. The shared
classifier distinguishes unknown from confirmed-commit post-hook failure and uses
exact classes, not message/name/commitConfirmed duck typing. The postcommit class
now lives in a leaf module with the original export retained. Application install
and upgrade also refuse compensation or fallible telemetry replacement in all three
cases; temporary package cleanup still runs without masking the original outcome.

Actual Redis/driver/explorer tests verify one attempt, original failed reason,
no delayed/waiting/active retry, restart after persisted failure and a healthy marker
processed by the replacement worker. A real PostgreSQL INSERT plus failing
after-commit subscriber remains saved while Redis records one failed attempt.
Existing application tests cover compensation, cleanup and error propagation.

This does not prevent stalled delivery after a process crash before failed state is
saved, manual retry/new enqueue or a later scheduled occurrence. Durable command
reconciliation remains distinct. Tests use a unique isolated Redis prefix; live
workers/customer messages are untouched. No build/deployment or GitHub Actions.

[Design](design.md), [review](review.md), [results](results.json),
[source hashes](source-snapshot.json), [next boundary](next-boundary.md).
ROB765 remains In Progress.
