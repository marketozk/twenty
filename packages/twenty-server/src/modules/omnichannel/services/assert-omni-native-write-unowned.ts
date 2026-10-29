import { isUUID } from 'class-validator';

import {
  findOmniOwnedMessageIds,
  findOmniOwnedMessageThreadIds,
} from 'src/modules/omnichannel/services/find-omni-owned-native-record-ids';
import { type OmniNativeOwnershipQuery } from 'src/modules/omnichannel/services/lock-omni-native-ownership';
import { findOmniOwnedMessageFolderIds } from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';

export const OMNI_NATIVE_REPOSITORIES = new Set([
  'message',
  'messageThread',
  'messageParticipant',
  'messageChannelMessageAssociation',
  'messageChannelMessageAssociationMessageFolder',
  'messageThreadTarget',
]);

// Call only while holding the ownership fence and row locks in this transaction.
// Both before images and assigned after images must be checked. Soft deletion and
// inactive bindings retain ownership; provider/header text is never authority.
export const findOmniNativeWriteOwnedRecords = async (
  query: OmniNativeOwnershipQuery,
  workspaceId: string,
  name: string,
  records: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> => {
  if (!OMNI_NATIVE_REPOSITORIES.has(name) || records.length === 0) return [];
  if (!isUUID(workspaceId))
    throw new Error('OMNI_INVALID_NATIVE_OWNERSHIP_SCOPE');
  const schema = `workspace_${BigInt(`0x${workspaceId.replaceAll('-', '')}`).toString(36)}`;
  const ids = (key: string) => [
    ...new Set(
      records.flatMap((record) => {
        const value = record[key];
        if (value === undefined || value === null) return [];
        if (typeof value !== 'string' || !isUUID(value))
          throw new Error('OMNI_INVALID_NATIVE_OWNERSHIP_REFERENCE');
        return [value.toLowerCase()];
      }),
    ),
  ];
  let messageIds: string[] = [];
  let threadIds: string[] = [];
  let channelIds: string[] = [];
  let ownedFolderIds = new Set<string>();
  let ownedAssociationIds = new Set<string>();
  if (name === 'message') {
    messageIds = ids('id');
    threadIds = ids('messageThreadId');
  } else if (name === 'messageThread') threadIds = ids('id');
  else if (name === 'messageThreadTarget') threadIds = ids('messageThreadId');
  else if (name === 'messageParticipant') messageIds = ids('messageId');
  else if (name === 'messageChannelMessageAssociation') {
    messageIds = ids('messageId');
    threadIds = ids('messageThreadId');
    channelIds = ids('messageChannelId');
  } else {
    ownedFolderIds = await findOmniOwnedMessageFolderIds(
      query,
      workspaceId,
      ids('messageFolderId'),
    );
    const associationIds = ids('messageChannelMessageAssociationId');
    if (associationIds.length) {
      const associations = await query.executeRawQuery(
        `SELECT id, "messageId", "messageThreadId", "messageChannelId" FROM "${schema}"."messageChannelMessageAssociation" WHERE id=ANY($1::uuid[])`,
        [associationIds],
      );
      if (
        associations.some(
          (row) =>
            typeof row.id !== 'string' || !associationIds.includes(row.id),
        )
      )
        throw new Error('OMNI_INVALID_NATIVE_OWNERSHIP_RESULT');
      const ownedAssociations = await findOmniNativeWriteOwnedRecords(
        query,
        workspaceId,
        'messageChannelMessageAssociation',
        associations,
      );
      ownedAssociationIds = new Set(
        ownedAssociations.map((row) => String(row.id)),
      );
    }
  }
  const ownedMessages = await findOmniOwnedMessageIds(
    query,
    workspaceId,
    messageIds,
  );
  const ownedThreads = await findOmniOwnedMessageThreadIds(
    query,
    workspaceId,
    threadIds,
  );
  const ownedChannels = new Set(
    channelIds.length
      ? (
          await query.executeRawQuery(
            'SELECT "messageChannelId" FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND "messageChannelId"=ANY($2::uuid[])',
            [workspaceId, channelIds],
          )
        ).map((row) => {
          if (
            typeof row.messageChannelId !== 'string' ||
            !channelIds.includes(row.messageChannelId)
          )
            throw new Error('OMNI_INVALID_NATIVE_OWNERSHIP_RESULT');
          return row.messageChannelId;
        })
      : [],
  );
  const value = (row: Record<string, unknown>, key: string) =>
    String(row[key] ?? '').toLowerCase();
  return records.filter((row) => {
    if (name === 'message')
      return (
        ownedMessages.has(value(row, 'id')) ||
        ownedThreads.has(value(row, 'messageThreadId'))
      );
    if (name === 'messageThread') return ownedThreads.has(value(row, 'id'));
    if (name === 'messageThreadTarget')
      return ownedThreads.has(value(row, 'messageThreadId'));
    if (name === 'messageParticipant')
      return ownedMessages.has(value(row, 'messageId'));
    if (name === 'messageChannelMessageAssociation')
      return (
        ownedMessages.has(value(row, 'messageId')) ||
        ownedThreads.has(value(row, 'messageThreadId')) ||
        ownedChannels.has(value(row, 'messageChannelId'))
      );
    return (
      ownedFolderIds.has(value(row, 'messageFolderId')) ||
      ownedAssociationIds.has(value(row, 'messageChannelMessageAssociationId'))
    );
  });
};

export const assertOmniNativeWriteUnowned = async (
  query: OmniNativeOwnershipQuery,
  workspaceId: string,
  name: string,
  records: Record<string, unknown>[],
): Promise<void> => {
  if (
    (await findOmniNativeWriteOwnedRecords(query, workspaceId, name, records))
      .length
  )
    throw new Error('OMNI_NATIVE_MUTATION_REQUIRES_DOMAIN_COMMAND');
};
