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
export const assertOmniNativeWriteUnowned = async (
  query: OmniNativeOwnershipQuery,
  workspaceId: string,
  name: string,
  records: Record<string, unknown>[],
): Promise<void> => {
  if (!OMNI_NATIVE_REPOSITORIES.has(name) || records.length === 0) return;
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
  if (name === 'message') {
    messageIds = ids('id');
    threadIds = ids('messageThreadId');
  } else if (name === 'messageThread') threadIds = ids('id');
  else if (name === 'messageThreadTarget') threadIds = ids('messageThreadId');
  else if (name === 'messageParticipant') messageIds = ids('messageId');
  else if (name === 'messageChannelMessageAssociation') {
    messageIds = ids('messageId');
    channelIds = ids('messageChannelId');
  } else {
    if (
      (
        await findOmniOwnedMessageFolderIds(
          query,
          workspaceId,
          ids('messageFolderId'),
        )
      ).size
    )
      throw new Error('OMNI_NATIVE_MUTATION_REQUIRES_DOMAIN_COMMAND');
    const associationIds = ids('messageChannelMessageAssociationId');
    if (associationIds.length) {
      const associations = await query.executeRawQuery(
        `SELECT "messageId", "messageChannelId" FROM "${schema}"."messageChannelMessageAssociation" WHERE id=ANY($1::uuid[])`,
        [associationIds],
      );
      await assertOmniNativeWriteUnowned(
        query,
        workspaceId,
        'messageChannelMessageAssociation',
        associations,
      );
    }
  }
  if (
    (messageIds.length &&
      (await findOmniOwnedMessageIds(query, workspaceId, messageIds)).size) ||
    (threadIds.length &&
      (await findOmniOwnedMessageThreadIds(query, workspaceId, threadIds))
        .size) ||
    (channelIds.length &&
      (
        await query.executeRawQuery(
          'SELECT id FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND "messageChannelId"=ANY($2::uuid[]) LIMIT 1',
          [workspaceId, channelIds],
        )
      ).length)
  )
    throw new Error('OMNI_NATIVE_MUTATION_REQUIRES_DOMAIN_COMMAND');
};
