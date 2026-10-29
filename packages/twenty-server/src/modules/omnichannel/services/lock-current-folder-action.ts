import { isUUID } from 'class-validator';
import { findOmniOwnedMessageFolderIds } from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';
import {
  lockOrdinaryMetadataActionChannel,
  METADATA_ACTION_TIMESTAMP_SQL,
  isMetadataActionTimestamp,
  type MetadataActionQuery,
} from 'src/modules/omnichannel/services/lock-ordinary-metadata-action-channel';
export type OrdinaryFolderAction = {
  workspaceId: string;
  messageChannelId: string;
  connectedAccountId: string;
  messageFolderId: string;
  action: 'FOLDER_IMPORT' | 'FOLDER_DELETION';
  isSynced: boolean;
  externalId: string | null;
  name: string | null;
  parentFolderId: string | null;
  updatedAt: string;
  channelUpdatedAt: string;
  hierarchy: {
    id: string;
    name: string | null;
    externalId: string | null;
    parentFolderId: string | null;
    version: string;
  }[];
};

export const readFolderHierarchy = (
  query: MetadataActionQuery,
  workspaceId: string,
  messageChannelId: string,
) =>
  query.executeRawQuery(
    `SELECT id,name,"externalId","parentFolderId",${METADATA_ACTION_TIMESTAMP_SQL} AS version FROM core."messageFolder" WHERE "workspaceId"=$1 AND "messageChannelId"=$2 ORDER BY id`,
    [workspaceId, messageChannelId],
  );

export const lockCurrentFolderAction = async (
  query: MetadataActionQuery,
  expected: OrdinaryFolderAction,
): Promise<boolean> => {
  if (
    !isUUID(expected.messageFolderId) ||
    !['FOLDER_IMPORT', 'FOLDER_DELETION'].includes(expected.action) ||
    typeof expected.isSynced !== 'boolean' ||
    (expected.action === 'FOLDER_IMPORT' && !expected.isSynced) ||
    !isMetadataActionTimestamp(expected.updatedAt) ||
    !isMetadataActionTimestamp(expected.channelUpdatedAt)
  )
    throw new Error('OMNI_INVALID_FOLDER_ACTION_SCOPE');
  const channel = await lockOrdinaryMetadataActionChannel(query, expected);
  if (!channel || channel.version !== expected.channelUpdatedAt) return false;
  const rows = await query.executeRawQuery(
    `SELECT "messageChannelId","pendingSyncAction","isSynced","externalId",${METADATA_ACTION_TIMESTAMP_SQL} AS version FROM core."messageFolder" WHERE "workspaceId"=$1 AND id=$2 FOR UPDATE`,
    [expected.workspaceId, expected.messageFolderId],
  );
  const folder = rows[0];
  if (
    !folder ||
    folder.messageChannelId !== expected.messageChannelId ||
    folder.pendingSyncAction !== expected.action ||
    folder.isSynced !== expected.isSynced ||
    folder.externalId !== expected.externalId ||
    folder.version !== expected.updatedAt
  )
    return false;
  if (
    expected.action === 'FOLDER_IMPORT' &&
    JSON.stringify(
      await readFolderHierarchy(
        query,
        expected.workspaceId,
        expected.messageChannelId,
      ),
    ) !== JSON.stringify(expected.hierarchy)
  )
    return false;
  return !(
    await findOmniOwnedMessageFolderIds(query, expected.workspaceId, [
      expected.messageFolderId,
    ])
  ).size;
};
