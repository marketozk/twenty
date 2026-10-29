# LOG117 — trusted membership cleanup attribution

Scoped implementation verified; ROB-765 remains In Progress. No deployment.

Three public resolver roots capture trusted authentication before their first
business await. User sessions use coreUser; delegated application/OAuth uses
application actor and coreUser initiator; impersonation resolves its core initiator
before deletion. API keys and explicitly named system jobs retain their identity.
Self-account cleanup fans out with a common correlation and distinct operations.
Identity objects are copied/frozen and workspace scope is checked before effects.

All known production callers pass an explicit identity parameter. Runtime legacy
absence reaches the security cleanup owner with an explicit
MEMBERSHIP_CLEANUP_AUDIT_IDENTITY_UNAVAILABLE error, without invented attribution.
An explicitly invalid/foreign identity is rejected. The core service now invokes
the LOG115 primitive; journal availability never substitutes for scope validation.

Hard workspace teardown forwards exact IDs of retained memberships. Target reads
include deleted rows only on the hard path; active other memberships determine
whether to disable the core user. A target's expected user is checked under the
membership lock, including concurrent rebind after an earlier target lookup.

Checks: 134 targeted tests / 5 suites plus 8 actual resolver/orchestration cases;
1296 regression tests / 42 suites pass (208.326s). 46 new cases. 26 guards pass;
10 migration checksums unchanged. Types: 363/366 roots, 190/190 existing diagnostics,
zero new or changed-code errors. Six diagnostics in unchanged baseline method bodies
remain; this is not a clean full-server typecheck. All 17 source hashes match.
[Results](results.json), [review](review.md), [next boundary](next-boundary.md).

Boundaries: API decorators, unrelated DI, signature/session resolution, account/share
transfers and native database deletion are adapters in the entrypoint tests.
Actual core membership/FK/audit and lost COMMIT acknowledgement use PostgreSQL.
The full public removal is not one transaction. CoreUser softDelete itself, native
member/transfer actor attribution, global last-admin/concurrent-sign-in fencing
and real native shares remain separate coverage. Internal post-hook auth context
does not carry impersonation context; public native deletion is guarded separately.
