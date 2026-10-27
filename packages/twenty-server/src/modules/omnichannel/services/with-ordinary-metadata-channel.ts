import { type EntityManager } from 'typeorm';

import { findOmniOwnedConnectedAccountIds } from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';
import {
  lockOmniMetadataChannel,
  OmniMetadataParentChangedError,
  withOmniMetadataMutation,
} from 'src/modules/omnichannel/services/omni-metadata-transaction';

// null is an explicit stale/protected/missing callback result, not a SQL fallback.
// Provider HTTP must already be outside this short local transaction.
export const withOrdinaryMetadataChannel = <T>(
  manager: EntityManager,
  workspaceId: string,
  channelId: string,
  kind: 'message' | 'calendar',
  work: (transaction: EntityManager) => Promise<T>,
  expectedConnectedAccountId?: string,
): Promise<T | null> =>
  withOmniMetadataMutation(manager, workspaceId, async (transaction) => {
    try {
      await lockOmniMetadataChannel(
        transaction,
        workspaceId,
        channelId,
        undefined,
        kind,
      );
    } catch (error) {
      if (error instanceof OmniMetadataParentChangedError) return null;
      throw error;
    }
    const table = kind === 'message' ? 'messageChannel' : 'calendarChannel';
    const rows: {
      connectedAccountId: string;
      provider: string;
      applicationId: string | null;
      connectionProviderId: string | null;
    }[] = await transaction.query(
      `SELECT channel."connectedAccountId", account.provider, account."applicationId", account."connectionProviderId"
     FROM core."${table}" channel JOIN core."connectedAccount" account
       ON account.id=channel."connectedAccountId" AND account."workspaceId"=channel."workspaceId"
     WHERE channel."workspaceId"=$1 AND channel.id=$2`,
      [workspaceId, channelId],
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1)
      throw new Error('OMNI_INVALID_METADATA_CHANNEL_RESULT');
    const account = rows[0];
    if (
      expectedConnectedAccountId !== undefined &&
      account.connectedAccountId !== expectedConnectedAccountId
    )
      return null;
    if (
      account.provider === 'app' &&
      account.applicationId === null &&
      account.connectionProviderId === null
    )
      return null;
    const owned = await findOmniOwnedConnectedAccountIds(
      {
        executeRawQuery: (sql, parameters) =>
          transaction.query(sql, parameters),
      },
      workspaceId,
      [account.connectedAccountId],
    );
    if (owned.size > 0) return null;
    return work(transaction);
  });
