import { isUUID } from 'class-validator';
import { IsNull, Raw } from 'typeorm';

// Old snapshots permitted ordinary provider accounts to be enrolled. Retained
// bindings remain protected even when their provider predates the APP invariant.
export const unboundConnectedAccountId = (id: string, workspaceId: string) => {
  if (
    ![id, workspaceId].every(
      (value) => typeof value === 'string' && isUUID(value),
    )
  ) {
    throw new Error('ORDINARY_CONNECTED_ACCOUNT_IDENTITY_REQUIRED');
  }
  return Raw(
    (alias) => `${alias} = :ordinaryAccountId AND NOT EXISTS (
    SELECT 1 FROM core."omniAccountBinding" binding
    WHERE binding."connectedAccountId" = :ordinaryAccountId
      AND binding."workspaceId" = :ordinaryWorkspaceId
  )`,
    { ordinaryAccountId: id, ordinaryWorkspaceId: workspaceId },
  );
};

type AccountIdentity<Provider extends string> = {
  id: string;
  workspaceId: string;
  provider: Provider;
  userWorkspaceId: string;
  applicationId: string | null;
  connectionProviderId: string | null;
};

// A provider response may arrive after custody or account identity changed.
// Match the captured identity in the UPDATE itself; never fall back to INSERT.
export const ordinaryConnectedAccountWriteWhere = <Provider extends string>(
  identity: AccountIdentity<Provider>,
) => {
  if (
    ![identity.id, identity.workspaceId, identity.userWorkspaceId].every(
      (value) => typeof value === 'string' && isUUID(value),
    ) ||
    typeof identity.provider !== 'string' ||
    identity.provider.length === 0 ||
    ![identity.applicationId, identity.connectionProviderId].every(
      (value) => value === null || (typeof value === 'string' && isUUID(value)),
    ) ||
    (identity.provider === 'app' &&
      identity.applicationId === null &&
      identity.connectionProviderId === null)
  ) {
    throw new Error('ORDINARY_CONNECTED_ACCOUNT_IDENTITY_REQUIRED');
  }

  return {
    id: unboundConnectedAccountId(identity.id, identity.workspaceId),
    workspaceId: identity.workspaceId,
    provider: identity.provider,
    userWorkspaceId: identity.userWorkspaceId,
    applicationId:
      identity.applicationId === null ? IsNull() : identity.applicationId,
    connectionProviderId:
      identity.connectionProviderId === null
        ? IsNull()
        : identity.connectionProviderId,
  };
};

export const assertConnectedAccountWriteApplied = (result: {
  affected?: number | null;
}) => {
  if (result.affected !== 1) {
    throw new Error('CONNECTED_ACCOUNT_CHANGED_RETRY_AUTHORIZATION');
  }
};
