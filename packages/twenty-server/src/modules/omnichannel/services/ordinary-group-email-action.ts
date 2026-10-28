import {
  lockOrdinaryMetadataActionChannel,
  METADATA_ACTION_TIMESTAMP_SQL,
  isMetadataActionTimestamp,
  type MetadataActionQuery,
} from 'src/modules/omnichannel/services/lock-ordinary-metadata-action-channel';
import { type EntityManager } from 'typeorm';

import { findOmniOwnedMessageFolderIds } from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';
import { withOrdinaryMetadataChannels } from 'src/modules/omnichannel/services/with-ordinary-metadata-channels';

export type OrdinaryGroupEmailAction = {
  workspaceId: string;
  messageChannelId: string;
  connectedAccountId: string;
  action: 'GROUP_EMAILS_IMPORT' | 'GROUP_EMAILS_DELETION';
  excludeGroupEmails: boolean;
  updatedAt: string;
};

// Call only inside a transaction holding the shared native-ownership fence.
export const lockCurrentGroupEmailAction = async (
  query: MetadataActionQuery,
  expected: OrdinaryGroupEmailAction,
): Promise<boolean> => {
  if (
    !['GROUP_EMAILS_IMPORT', 'GROUP_EMAILS_DELETION'].includes(
      expected.action,
    ) ||
    expected.excludeGroupEmails !==
      (expected.action === 'GROUP_EMAILS_DELETION') ||
    !isMetadataActionTimestamp(expected.updatedAt)
  )
    throw new Error('OMNI_INVALID_GROUP_ACTION_SCOPE');
  const channel = await lockOrdinaryMetadataActionChannel(query, expected);
  return (
    channel !== null &&
    channel.pendingGroupEmailsAction === expected.action &&
    channel.excludeGroupEmails === expected.excludeGroupEmails &&
    channel.version === expected.updatedAt
  );
};

export const captureOrdinaryGroupEmailAction = async (
  manager: EntityManager,
  workspaceId: string,
  messageChannelId: string,
  connectedAccountId: string,
  action: string,
): Promise<OrdinaryGroupEmailAction | null> => {
  if (action !== 'GROUP_EMAILS_IMPORT' && action !== 'GROUP_EMAILS_DELETION')
    return null;
  return withOrdinaryMetadataChannels(
    manager,
    workspaceId,
    [messageChannelId],
    'message',
    async (transaction, channels) => {
      if (!channels.length) return null;
      const rows = await transaction.query(
        `SELECT "excludeGroupEmails",${METADATA_ACTION_TIMESTAMP_SQL} AS version FROM core."messageChannel" WHERE "workspaceId"=$1 AND id=$2 AND "connectedAccountId"=$3 AND "pendingGroupEmailsAction"=$4`,
        [workspaceId, messageChannelId, connectedAccountId, action],
      );
      if (!rows.length) return null;
      const expected: OrdinaryGroupEmailAction = {
        workspaceId,
        messageChannelId,
        connectedAccountId,
        action,
        excludeGroupEmails: rows[0].excludeGroupEmails,
        updatedAt: rows[0].version,
      };
      if (expected.excludeGroupEmails !== (action === 'GROUP_EMAILS_DELETION'))
        return null;
      return (await lockCurrentGroupEmailAction(
        { executeRawQuery: (sql, params) => transaction.query(sql, params) },
        expected,
      ))
        ? expected
        : null;
    },
    'read',
    connectedAccountId,
  );
};

export const finishOrdinaryGroupEmailAction = async (
  manager: EntityManager,
  input: OrdinaryGroupEmailAction,
): Promise<boolean> => {
  const expected = { ...input };
  return withOrdinaryMetadataChannels(
    manager,
    expected.workspaceId,
    [expected.messageChannelId],
    'message',
    async (transaction, channels) => {
      if (
        !channels.length ||
        !(await lockCurrentGroupEmailAction(
          { executeRawQuery: (sql, params) => transaction.query(sql, params) },
          expected,
        ))
      )
        return false;
      const folders: { id: string }[] = await transaction.query(
        'SELECT id FROM core."messageFolder" WHERE "workspaceId"=$1 AND "messageChannelId"=$2 ORDER BY id FOR UPDATE',
        [expected.workspaceId, expected.messageChannelId],
      );
      const owned = await findOmniOwnedMessageFolderIds(
        { executeRawQuery: (sql, params) => transaction.query(sql, params) },
        expected.workspaceId,
        folders.map((folder) => folder.id),
      );
      const ids = folders
        .map((folder) => folder.id)
        .filter((id) => !owned.has(id));
      await transaction.query(
        'UPDATE core."messageFolder" SET "syncCursor"=\'\',"updatedAt"=now() WHERE "workspaceId"=$1 AND id=ANY($2::uuid[])',
        [expected.workspaceId, ids],
      );
      await transaction.query(
        'UPDATE core."messageChannel" SET "syncCursor"=\'\',"pendingGroupEmailsAction"=\'NONE\',"updatedAt"=now() WHERE "workspaceId"=$1 AND id=$2',
        [expected.workspaceId, expected.messageChannelId],
      );
      return true;
    },
    'read',
    expected.connectedAccountId,
  );
};
