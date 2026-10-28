# Next boundary: audit core membership cleanup

Read-only source review after LOG114 implementation; not implemented or accepted.

Public call chain: UserResolver.deleteUserFromWorkspace →
UserService.deleteUserWorkspaceAndPotentiallyDeleteUser →
removeUserFromWorkspaceAndPotentiallyDeleteWorkspace →
UserWorkspaceService.deleteUserWorkspace. Self-delete traverses workspaces through
UserService.deleteUser. Capture trusted request identity before awaits/native removal;
the native member is already deleted when core cleanup starts. Cross-workspace self
deletion needs coreUser attribution; custodian actingUserWorkspaceId is not an actor
contract. Resolve impersonation initiator before deletion. Jobs/teardown must use an
explicit trusted system entry, never a missing-auth fallback or actor from job payload.

Verified hard-delete effects: userWorkspace; explicit roleTarget deletes; SET NULL on
workflow/view creator; CASCADE on userSession, applicationAuthorization,
userApplicationVariableValue, twoFactorAuthenticationMethod and navigationMenuItem.
Navigation folderId itself cascades recursively: descendants can have another/NULL
membership owner. OTP and application-variable values must never enter audit snapshots.
ConnectedAccount membership is not an FK; ownership transfer is an earlier owner.

Recommended next implementation: same existing strict owner; fixed actual FK effects
snapshot/lock and postconditions; native administrative audit descriptors and existing
roleTarget/session owner patterns. Evaluate security-first SAVEPOINT audit failure
semantics against design/08-audit.md and UserSessionService revoke implementation:
never resurrect removed access because the journal is unavailable, but report failure
explicitly. Do not call independent session revoke transactions for CASCADE DELETE.

Verify all FK effects, recursive navigation ownership, self/impersonation/job actor,
audit-savepoint failure, late corruption, unknown COMMIT, cache invalidation and no-op.
Soft-delete only changes membership and retains children. Full public native removal,
transfers, global last-admin fencing and later thread cleanup remain distinct owners.
