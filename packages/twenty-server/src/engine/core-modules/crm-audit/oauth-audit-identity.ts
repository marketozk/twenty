import {
  copyMembershipCleanupIdentity,
  type MembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';

// The identity comes from server authentication / the persisted one-use code,
// never the token exchange body. Copy before any asynchronous work.
export const requireOAuthAuditIdentity = (
  identity: MembershipCleanupIdentity | undefined,
  workspaceId: string,
  userId: string,
): MembershipCleanupIdentity => {
  const captured = copyMembershipCleanupIdentity(identity, workspaceId);
  if (
    !captured ||
    captured.workspaceId !== workspaceId.toLowerCase() ||
    captured.actor.kind !== 'coreUser' ||
    captured.actor.id !== userId.toLowerCase() ||
    (captured.initiator && captured.initiator.kind !== 'coreUser')
  )
    throw new Error('OAuth audit identity does not match authorization');
  return captured;
};
