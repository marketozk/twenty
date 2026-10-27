import { type EntityManager } from 'typeorm';
import { isUUID } from 'class-validator';

import {
  findOmniOwnedConnectedAccountIds,
  findOmniOwnedMessageFolderIds,
} from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';
import { withOrdinaryMetadataChannels } from 'src/modules/omnichannel/services/with-ordinary-metadata-channels';

export type OrdinaryGroupEmailAction = {
  workspaceId: string;
  messageChannelId: string;
  connectedAccountId: string;
  action: 'GROUP_EMAILS_IMPORT' | 'GROUP_EMAILS_DELETION';
  excludeGroupEmails: boolean;
  updatedAt: string;
};

type Query = {
  executeRawQuery: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
};
const TIMESTAMP = `to_char("updatedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// Call only inside a transaction holding the shared native-ownership fence.
export const lockCurrentGroupEmailAction = async (
  query: Query,
  expected: OrdinaryGroupEmailAction,
): Promise<boolean> => {
  if (
    ![
      expected.workspaceId,
      expected.messageChannelId,
      expected.connectedAccountId,
    ].every((id) => isUUID(id)) ||
    !['GROUP_EMAILS_IMPORT', 'GROUP_EMAILS_DELETION'].includes(
      expected.action,
    ) ||
    expected.excludeGroupEmails !==
      (expected.action === 'GROUP_EMAILS_DELETION') ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(expected.updatedAt)
  )
    throw new Error('OMNI_INVALID_GROUP_ACTION_SCOPE');
  const accounts = await query.executeRawQuery(
    'SELECT id,provider,"applicationId","connectionProviderId" FROM core."connectedAccount" WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
    [expected.workspaceId, expected.connectedAccountId],
  );
  const channels = await query.executeRawQuery(
    `SELECT "connectedAccountId","pendingGroupEmailsAction","excludeGroupEmails",${TIMESTAMP} AS version FROM core."messageChannel" WHERE "workspaceId"=$1 AND id=$2 FOR UPDATE`,
    [expected.workspaceId, expected.messageChannelId],
  );
  const account = accounts[0],
    channel = channels[0];
  if (
    !account ||
    !channel ||
    channel.connectedAccountId !== expected.connectedAccountId ||
    channel.pendingGroupEmailsAction !== expected.action ||
    channel.excludeGroupEmails !== expected.excludeGroupEmails ||
    channel.version !== expected.updatedAt ||
    (account.provider === 'app' &&
      account.applicationId === null &&
      account.connectionProviderId === null)
  )
    return false;
  const owned = await findOmniOwnedConnectedAccountIds(
    query,
    expected.workspaceId,
    [expected.connectedAccountId],
  );
  return !owned.size;
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
        `SELECT "excludeGroupEmails",${TIMESTAMP} AS version FROM core."messageChannel" WHERE "workspaceId"=$1 AND id=$2 AND "connectedAccountId"=$3 AND "pendingGroupEmailsAction"=$4`,
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
