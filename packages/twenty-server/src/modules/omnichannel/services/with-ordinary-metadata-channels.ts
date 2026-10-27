import { isUUID } from 'class-validator';
import { type EntityManager } from 'typeorm';

import { findOmniOwnedConnectedAccountIds } from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';
import { withOmniMetadataMutation } from 'src/modules/omnichannel/services/omni-metadata-transaction';

export type OrdinaryMetadataChannel = {
  id: string;
  connectedAccountId: string;
  userWorkspaceId: string;
};

// One owner for the entire batch: acquire all parents before any child, and
// never upgrade a shared parent lock midway through an authentication failure.
export const withOrdinaryMetadataChannels = <T>(
  manager: EntityManager,
  workspaceId: string,
  channelIds: readonly string[],
  kind: 'message' | 'calendar',
  work: (
    transaction: EntityManager,
    channels: OrdinaryMetadataChannel[],
  ) => Promise<T>,
  accountLock: 'read' | 'write' = 'read',
  expectedConnectedAccountId?: string,
): Promise<T> => {
  if (
    !Array.isArray(channelIds) ||
    channelIds.some((id) => !isUUID(id)) ||
    !['message', 'calendar'].includes(kind) ||
    !['read', 'write'].includes(accountLock)
  )
    throw new Error('OMNI_INVALID_METADATA_CHANNEL_BATCH');
  const ids = [...new Set(channelIds.map((id) => id.toLowerCase()))].sort();
  const table = kind === 'message' ? 'messageChannel' : 'calendarChannel';
  return withOmniMetadataMutation(manager, workspaceId, async (transaction) => {
    const before: { id: string; connectedAccountId: string }[] =
      await transaction.query(
        `SELECT id, "connectedAccountId" FROM core."${table}" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[])`,
        [workspaceId, ids],
      );
    const accountIds = [
      ...new Set(before.map((row) => row.connectedAccountId)),
    ].sort();
    const accounts: {
      id: string;
      userWorkspaceId: string;
      provider: string;
      applicationId: string | null;
      connectionProviderId: string | null;
    }[] = await transaction.query(
      `SELECT id, "userWorkspaceId", provider, "applicationId", "connectionProviderId"
       FROM core."connectedAccount" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[])
       ORDER BY id FOR ${accountLock === 'write' ? 'UPDATE' : 'SHARE'}`,
      [workspaceId, accountIds],
    );
    const after: { id: string; connectedAccountId: string }[] =
      await transaction.query(
        `SELECT id, "connectedAccountId" FROM core."${table}" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
        [workspaceId, ids],
      );
    const owned = await findOmniOwnedConnectedAccountIds(
      {
        executeRawQuery: (sql, parameters) =>
          transaction.query(sql, parameters),
      },
      workspaceId,
      accounts.map((account) => account.id),
    );
    const originalParents = new Map(
      before.map((row) => [row.id, row.connectedAccountId]),
    );
    const admittedAccounts = new Map(
      accounts
        .filter(
          (account) =>
            !owned.has(account.id) &&
            !(
              account.provider === 'app' &&
              account.applicationId === null &&
              account.connectionProviderId === null
            ),
        )
        .map((account) => [account.id, account]),
    );
    const admitted: OrdinaryMetadataChannel[] = [];
    for (const row of after) {
      if (
        originalParents.get(row.id) !== row.connectedAccountId ||
        (expectedConnectedAccountId !== undefined &&
          expectedConnectedAccountId !== row.connectedAccountId)
      )
        continue;
      const account = admittedAccounts.get(row.connectedAccountId);
      if (account)
        admitted.push({ ...row, userWorkspaceId: account.userWorkspaceId });
    }
    return work(transaction, admitted);
  });
};
