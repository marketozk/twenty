# LOG-074: current-run native provider-result apply

Message and calendar aggregates copy run/account/channel before await and validate
scope. Within the existing native transaction/shared ownership fence, account SHARE
and channel UPDATE locks protect fresh parent, enabled flag, exact stage/microsecond
run and complete ordinary ownership check. A declined proof returns before native
reads/writes and postcommit work; import callers stop before completion. Strict
unknown commit propagates without enqueue/rematch.

Calendar pre-read/build/write, including existing participants and other-channel
metadata, now use the same native scope; no nested native transaction. No-run
ordinary and APP targets-only paths retain their contract. Nullable message
participant address/name remain null in native rows; only addressable contacts enter
the contact queue, where missing display name becomes empty string as required.

Full fork 2443 Jest/76 suites +26 guards=2469 PASS; 29 new PostgreSQL cases. Typecheck 294 roots:188/187,0 new/changed-code. Seven migrations unchanged.
Tests cover stale parent/run/stage, disabled/native/derived ownership, aggregate
rollback, real COMMIT lost ACK, same-channel serialization, two-channel calendar
sharing, run UPDATE waiting for native COMMIT, nullable participant identities.
Initial type gate found an existing nullable mismatch in the changed method; fixed
and rechecked. Local/test-source LF hashes match. Scoped independent review found
no remaining issue; reviewer ran no tests. Queue/matcher/provider use explicit doubles.

Limits: provider association/orphan cleanup and Redis publication/requeue do not yet
carry run proof. Contact creation and matching after accepted COMMIT are outside run
protection. No full server typecheck/ROB764 Done/live transport acceptance claim.
Ordinary email cache retains legacy delivery semantics (phase_1_data step 3; spec §15.18); this does not require a new durable email pipeline. Verify delayed callbacks cannot mutate omni.
Next: guarded native cleanup, Redis and postcommit ownership review, then final
stage acceptance inventory. Demo/SaleBot unchanged; no Actions. Skills ai-dev-workflow,
behavioral-guardrails, server-schrodinger; scoped read-only research/review.

[Tests](tests.txt), [verification](verification.json), [source hashes](source-snapshot.json), [typecheck](typecheck-differential.json).

[Remaining inventory](../rob764-metadata-writer-inventory.md). Rollback all affected files together from one Git revision; mixed worker versions are not verified. Rollback removes run guards.
