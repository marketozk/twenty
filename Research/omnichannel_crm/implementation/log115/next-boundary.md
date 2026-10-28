# Next boundary: trusted membership audit entry points

Read-only source review; not yet implemented or accepted.

Capture a trusted operation before any await/native removal in
UserResolver.deleteUserFromWorkspace. Thread it through UserService's deletion and
removal methods to UserWorkspaceService and the LOG115 owner. Native workspaceMember
can already be gone at core cleanup; do not look it up then or infer the actor from
the custodian actingUserWorkspaceId. Resolve impersonator coreUser beforehand.

UserResolver.deleteUser uses authenticated coreUser attribution across all workspaces;
each workspace gets its own operation with a common correlation. Application callers
retain application attribution and existing self-delete restrictions.

WorkspaceResolver.deleteCurrentWorkspace is also a public entry, so deleteWorkspace
must never silently default to system. Thread attribution through soft and hard
teardown loops to handleRemoveWorkspaceMember. Cleaner, billing teardown,
DestroySoftDeletedWorkspaceJob and HandleWorkspaceMemberDeletedJob supply explicit
system identities at their trusted entries, never from user-selected payload fields.
WorkspaceMemberDeleteOnePostQueryHook already has authContext; capture there before
awaits. Existing public pre-hook rejection remains.

Recheck deleted memberships in teardown: deleteWorkspace lists withDeleted but
handleRemoveWorkspaceMember currently queries active memberships only. Do not claim
hard-cleanup audit for retained soft-deleted memberships without verifying this path.

Tests: actual service with native member already absent; self/app/impersonation;
multiple workspaces; manual workspace deletion versus trusted jobs; mutable input
during await; missing/foreign attribution; unknown COMMIT and cache invalidation.
Existing request guards and permission checks remain authoritative.

Native transfers, native membership deletion, subsequent threads and workspace
metadata teardown are distinct owners. Passing operation identity does not make the
entire public removal atomic or close global last-admin/concurrent-sign-in fencing.

Cache finding: UserSessionService cache hits already reread the actual session row,
so hard-delete CASCADE cannot be hidden by an old session hash cache. Soft-delete keeps
the session; JwtStrategy.resolveUserContext currently reads membership from the core
cache only. Failed invalidation can retain stale access. Use its existing membership
repository to recheck active id + userId + workspaceId before returning authenticated
context. Test stale cache, soft/hard removal, foreign identity and an active control.
This is a required subsequent security fix; LOG115 verifies DB revocation, not complete
HTTP/JWT revocation. Merely evicting session hashes would not fix retained live sessions.
