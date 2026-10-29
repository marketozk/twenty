# Next — native workspaceMember cleanup audit

The three source-confirmed old User full-save writers are now narrow active-row
updates. Continue the native deletion boundary identified in
[LOG117](../log117/next-boundary.md): private workspaceMember deletion, known system
and transitive FK effects, trusted LOG117 identity and security-first journal behavior.

Use the existing strict WorkspaceTransactionScope, its repository and
createCrmAuditWorkspaceExecutor. Ordinary options.nativeAudit is fail-closed and
derives a different actor, so it must not simply be enabled for security cleanup.
Keep the global public metadata predicate unchanged; this is a private DELETE-only
entrypoint with exact standard metadata and target id/user identity checks.

Actual member/child effects must be verified outside the audit savepoint and after
its rollback; unknown commit must not retry. Reuse the existing safe native field-ID
snapshot representation and current-administrative deleted-record descriptor.
Connected-account and record-share transfers remain separate owners.

Other confirmed residuals: request.user admin authorization freshness, whole
in-flight request fencing, real native share cleanup, public DESTROY/MERGE and the
remaining ROB765 acceptance matrix. Do not mark those complete from these updates.
