# LOG119 — membership creation/deactivation fence

UserWorkspaceService.create now checks and locks the active core user in the same
transaction as membership INSERT. The lock serializes against LOG118 deactivation:
creator first makes removal see the new membership; deactivator first makes creation
reject the deleted user. Actual inserted identity, workspace and active state are
verified. Standalone creation uses the existing strict core transaction owner.

Signup's supplied runner stays on its own connection, so an uncommitted new user is
visible. Inactive, released or foreign runners are rejected before avatar preparation
and checked again after it. Avatar I/O remains outside the short standalone SQL
transaction. Scalar request values are captured before that await.

Locale changes use a narrow UPDATE with deletedAt IS NULL; they cannot restore or
reinsert a removed membership. Missing/removed targets stay no-ops without invalidation.

23 new PostgreSQL cases; 45 targeted tests/2 suites PASS. General regression:
1343 tests/44 suites PASS (209.429s). The final targeted rerun uses the actual ru-RU
locale enum after typechecking caught three fixture-only ru literals.

See [results](results.json), [independent review](review.md), [next boundary](next-boundary.md).
ROB765 remains In Progress. No deployment or full HTTP/signup acceptance is claimed.
Caller-owned COMMIT behavior remains with the existing signup transaction; global
account revocation and native membership/shares are not covered by these two methods.
