# LOG126 review

Source inspection and independent read-only review confirmed BullMQ discard is
synchronous and stops the normal attempts/backoff path while retaining the original
error. Explorer telemetry could replace the domain error before the driver saw it;
the bounded catch now preserves known unsafe transaction errors if reporting fails.

Further inspection of runInCoreAuditTransaction found a third unsafe case:
CoreAuditPostCommitError after raw PostgreSQL COMMIT is confirmed but a TypeORM
afterTransactionCommit subscriber fails. It is committed, not unknown. The shared
unsafe-to-retry predicate recognizes the exact class in addition to two unknown
classes. The old unknown predicate retains its narrower meaning. Install/upgrade
also use the broader predicate to avoid compensating a confirmed committed effect.

Real Redis tests cover original failure reason, attemptsMade=1 despite attempts=3,
restart after failed is persisted and a healthy marker proving the new worker runs.
Ordinary failure retries and succeeds. A real PG INSERT plus throwing after-commit
subscriber verifies the saved row and one Redis invocation. Application tests cover
all three classes through compensation, telemetry, cleanup and upgrade propagation.

Initial type differential exposed an old unknown-to-Error mismatch inside the
edited explorer method. The capture predicate now narrows Error explicitly and
reports non-Error throws directly, retaining the original thrown value.

Limits: crash before failed is persisted, stalled redelivery, manual retry/new job
and future cron runs are not prevented. No durable command reconciliation is claimed.

Final independent review confirmed exact postcommit class identity, narrow/broad
classifiers and all four application/queue boundaries; no new blocker found.
The runtime BullMQ package was checked directly: 5.78.0.

Additional upstream driver suite initially had 2 progress failures/16 passes with
the isolated fork Jest defaults; the same failures reproduced on baseline126.
Its normal jest.config.mjs requires clearMocks and globally enabled fake timers.
With those two existing settings restored in an explicit test config, all 18 pass.
No driver/test implementation was changed to accommodate that harness mismatch.
