# Next: explicit application sources, then connected-account deletion

Request and lifecycle queue attribution is ready. Before switching the manifest
account deletion caller, cover the remaining real install/upgrade entry points:

- PreInstalledAppsService install/backfill: workspace-scoped named system policy.
- InstallApplicationCommand: named operator command after dry-run/confirmation.
- UpgradeWorkspaceApplicationJob: named worker, without inventing publishing user.
- OAuth authorization code: retain the verified issuing user and impersonator;
  validate the retained workspace/user after code/client/PKCE/single-use checks.
  Check current membership before auto-install. Legacy codes cannot reconstruct
  impersonation; require authorization again where installation needs provenance.

OAuth auto-install currently falls back to a bare application after any install
error. Install and upgrade also have compensation/error-rewrite paths. Before a
strict destructive owner is connected, unknown commit outcomes and attribution
refusals must bypass unsafe fallback/compensation. Test the actual call sites.

Then implement [the closed account deletion owner](../log123/next-boundary.md):
actual connectedAccount/channel/folder FK graph, exact DELETE RETURNING, strict
audit rollback, retained omni refusal, fresh caller checks and no events after
unknown COMMIT. This does not make external provider effects atomic.

ROB765 remains In Progress. MCP, remaining native/system writers, real shares,
public destroy/merge, post-rollback failed/denied audit and health remain open.
