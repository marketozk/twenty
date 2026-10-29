# Next: stop automatic retries of uncertain transactions

UpgradeWorkspaceApplicationJob has retryLimit=2. BullMQDriver currently forwards
all handler errors without distinguishing confirmed failure from unknown COMMIT.
Before enabling the account-delete owner, preserve both known outcome error types
and discard automatic retry for those failures. Ordinary known failures retain
existing retry configuration. Verify the actual driver and an isolated Redis worker.
Do not equate this with reconciliation after worker crash, stalled redelivery or
manual retry; those boundaries need explicit inspection and durable ownership.

Then connect the [account deletion owner](../log123/next-boundary.md), with LOG124
request/job identity and LOG125 OAuth/system sources. Existing legacy jobs without
identity must not silently invent a user. Remaining native writers, real shares,
public destroy/merge, failed/denied audit, health, full HTTP and deployment stay open.
