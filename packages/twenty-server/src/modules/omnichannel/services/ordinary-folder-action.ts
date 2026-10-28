import { isUUID } from 'class-validator';
import { type EntityManager } from 'typeorm';
import { findOmniOwnedMessageFolderIds } from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';
import { withOrdinaryMetadataChannels } from 'src/modules/omnichannel/services/with-ordinary-metadata-channels';
import { withOmniNativeOwnershipTransaction } from 'src/modules/omnichannel/services/omni-core-transaction';
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

const readFolderHierarchy = (
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

export const captureOrdinaryFolderAction = async (
  manager: EntityManager,
  scope: {
    workspaceId: string;
    messageChannelId: string;
    connectedAccountId: string;
    messageFolderId: string;
    action: string;
  },
): Promise<OrdinaryFolderAction | null> => {
  const input = { ...scope };
  if (input.action !== 'FOLDER_IMPORT' && input.action !== 'FOLDER_DELETION')
    return null;
  if (!isUUID(input.messageFolderId))
    throw new Error('OMNI_INVALID_FOLDER_ACTION_SCOPE');
  return withOrdinaryMetadataChannels(
    manager,
    input.workspaceId,
    [input.messageChannelId],
    'message',
    async (transaction, channels) => {
      if (!channels.length) return null;
      const query = {
        executeRawQuery: (sql: string, params?: unknown[]) =>
          transaction.query(sql, params),
      };
      const channel = await lockOrdinaryMetadataActionChannel(query, input);
      if (!channel) return null;
      const rows = await transaction.query(
        `SELECT "isSynced","externalId",name,"parentFolderId",${METADATA_ACTION_TIMESTAMP_SQL} AS version FROM core."messageFolder" WHERE "workspaceId"=$1 AND id=$2 AND "messageChannelId"=$3 AND "pendingSyncAction"=$4 FOR UPDATE`,
        [
          input.workspaceId,
          input.messageFolderId,
          input.messageChannelId,
          input.action,
        ],
      );
      if (
        !rows.length ||
        (input.action === 'FOLDER_IMPORT' && !rows[0].isSynced)
      )
        return null;
      const expected: OrdinaryFolderAction = {
        ...input,
        action: input.action as OrdinaryFolderAction['action'],
        isSynced: rows[0].isSynced,
        externalId: rows[0].externalId,
        name: rows[0].name,
        parentFolderId: rows[0].parentFolderId,
        updatedAt: rows[0].version,
        channelUpdatedAt: channel.version as string,
        hierarchy: (await readFolderHierarchy(
          query,
          input.workspaceId,
          input.messageChannelId,
        )) as OrdinaryFolderAction['hierarchy'],
      };
      return (await lockCurrentFolderAction(query, expected)) ? expected : null;
    },
    'read',
    input.connectedAccountId,
  );
};

export const finishOrdinaryFolderAction = async (
  manager: EntityManager,
  input: OrdinaryFolderAction,
): Promise<boolean> => {
  const expected = {
    ...input,
    hierarchy: input.hierarchy.map((folder) => ({ ...folder })),
  };
  if (manager.queryRunner?.isTransactionActive)
    throw new Error('OMNI_METADATA_REQUIRES_FRESH_TRANSACTION');
  return withOmniNativeOwnershipTransaction(
    manager.connection,
    expected.workspaceId,
    expected.action === 'FOLDER_DELETION' ? 'exclusive' : 'shared',
    async (runner) => {
      const query = {
        executeRawQuery: (sql: string, params?: unknown[]) =>
          runner.query(sql, params),
      };
      if (!(await lockCurrentFolderAction(query, expected))) return false;
      if (expected.action === 'FOLDER_DELETION') {
        // Native writers share the ownership fence; none may add a junction during this check/delete.
        const schema = `workspace_${BigInt('0x' + expected.workspaceId.replaceAll('-', '')).toString(36)}`;
        const remaining = await runner.query(
          `SELECT 1 FROM "${schema}"."messageChannelMessageAssociationMessageFolder" WHERE "messageFolderId"=$1 LIMIT 1`,
          [expected.messageFolderId],
        );
        if (remaining.length) return false;
        await runner.query(
          'DELETE FROM core."messageFolder" WHERE "workspaceId"=$1 AND id=$2',
          [expected.workspaceId, expected.messageFolderId],
        );
      } else
        await runner.query(
          'UPDATE core."messageFolder" SET "pendingSyncAction"=\'NONE\',"updatedAt"=now() WHERE "workspaceId"=$1 AND id=$2',
          [expected.workspaceId, expected.messageFolderId],
        );
      return true;
    },
  );
};
