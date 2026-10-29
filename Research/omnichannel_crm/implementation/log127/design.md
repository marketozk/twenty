# LOG127 — closed connected-account deletion transaction

Close the four-table core graph (connectedAccount, messageChannel, calendarChannel,
messageFolder) before changing existing entry points. Reuse runInCoreAuditTransaction,
native-ownership fence, account locks, actual FK inventory and audit context. No
arbitrary mutation callback; only this owner issues DELETE. The caller must supply
trusted scoped attribution; authorization remains an entry-point responsibility.

Lock order: shared ownership fence, active workspace, four table ROW EXCLUSIVE locks
in stable order, sorted accounts, message/calendar channels, folders. Table locks
prevent concurrent FK DDL; row locks fence FK inserts and child reparenting. Children
are selected by parent without hiding foreign workspace rows. Missing requested roots
refuse via the existing account-lock contract. Empty requests have no effects.

Only the three known CASCADE edges are supported. Other populated CASCADE/SET NULL/
SET DEFAULT references refuse using the inventory's real columns, including composite
keys. RESTRICT/NO ACTION remain PostgreSQL constraints. Both account ownership and
folder ownership are checked: a folder may reference a protected message from another
channel. Retained bindings remain protected when inactive; SQL failures fail closed.

Exact database JSON text snapshots preserve values beyond JavaScript numeric precision.
Actual DELETE RETURNING defines deleted roots and expected descendants. Partial/skipped
roots must retain their entire exact graph. Readback uses original IDs OR original
parent IDs so reparented rows and extra children cannot disappear from verification.
Verify before and after audit.flush. Audit failure rolls destructive deletion back;
the security-first fallback of disconnect is deliberately inapplicable.

Audit contains safe ownership/sync flags, never credentials, handles, folder names,
cursors or provider JSON. Each invocation gets a fresh operation ID, like transfer;
this is not a replay/idempotency API. Reusing caller attribution after recreation
must create a second history, not deduplicate the second destructive operation.
Return only actual deleted IDs and account custodian IDs after confirmed commit.

Unknown commit and confirmed postcommit failure retain the existing strict-owner
error types and cannot report success. No provider calls or native cleanup events
are emitted here. Production call sites, fresh caller permissions and external
cleanup are the next integration boundary. No migration, build or deployment.
