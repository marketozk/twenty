import { isUUID } from 'class-validator';
import { findOmniOwnedConnectedAccountIds } from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';

export type MetadataActionQuery = {
  executeRawQuery: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
};
export const METADATA_ACTION_TIMESTAMP_SQL = `to_char("updatedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const isMetadataActionTimestamp = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value);

// The caller owns an active transaction and the shared native-ownership fence.
export const lockOrdinaryMetadataActionChannel = async (
  query: MetadataActionQuery,
  expected: {
    workspaceId: string;
    messageChannelId: string;
    connectedAccountId: string;
  },
): Promise<Record<string, unknown> | null> => {
  if (
    ![
      expected.workspaceId,
      expected.messageChannelId,
      expected.connectedAccountId,
    ].every((id) => isUUID(id))
  )
    throw new Error('OMNI_INVALID_METADATA_ACTION_SCOPE');
  const accounts = await query.executeRawQuery(
    'SELECT id,provider,"applicationId","connectionProviderId" FROM core."connectedAccount" WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
    [expected.workspaceId, expected.connectedAccountId],
  );
  const channels = await query.executeRawQuery(
    `SELECT "connectedAccountId","pendingGroupEmailsAction","excludeGroupEmails",${METADATA_ACTION_TIMESTAMP_SQL} AS version FROM core."messageChannel" WHERE "workspaceId"=$1 AND id=$2 FOR UPDATE`,
    [expected.workspaceId, expected.messageChannelId],
  );
  const account = accounts[0],
    channel = channels[0];
  if (
    !account ||
    !channel ||
    channel.connectedAccountId !== expected.connectedAccountId ||
    (account.provider === 'app' &&
      account.applicationId === null &&
      account.connectionProviderId === null)
  )
    return null;
  const owned = await findOmniOwnedConnectedAccountIds(
    query,
    expected.workspaceId,
    [expected.connectedAccountId],
  );
  return owned.size ? null : channel;
};
