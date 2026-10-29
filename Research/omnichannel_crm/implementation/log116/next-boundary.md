# Next boundary: automatic membership attribution

The fresh membership authentication read is implemented; the remaining attribution
plan is [LOG115](../log115/next-boundary.md). Follow the existing request guards and
capture primitives before awaits/native deletion. Additional source facts:

- OAuth-only clients use request.application just like other applications; principal
  classification distinguishes sourceType, not a separate request.oauthClient field.
- UserResolver.deleteUser uses the authenticated coreUser. For self deletion across
  workspaces, create workspace operations with a common correlation.
- deleteUserFromWorkspace admits applications/OAuth-only with a user, preserves the
  existing application-self-delete restriction, and has AuthIsUserSession already.
- WorkspaceResolver.deleteCurrentWorkspace permits API keys and OAuth-only clients
  with or without a user. Its user decorator must therefore be optional. Do not invent
  an initiator for an application without a user.
- Session actor is coreUser; impersonated session initiator resolves the trusted
  impersonator membership to coreUser before removal. Application actor can carry the
  delegated coreUser as initiator. API key actor stays apiKey. Reject mixed principals.
- Cleaner, billing, destroy/member jobs supply explicit named system attribution at
  their trusted entry, never by missing-auth fallback or arbitrary job payload actor.
- Existing roleAuditIdentityFromRequest prefers user over application and therefore
  must not be reused unchanged for delegated application removal attribution.

Session cache re-eviction is not a substitute for the LOG116 active membership check.
In-flight mutation fences, complete removal/transfers and audit wiring remain open.
