import { isUUID } from 'class-validator';
import { type EntityManager } from 'typeorm';

import { findOmniOwnedMessageFolderIds } from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';
import {
  withOrdinaryMetadataChannels,
  type OrdinaryMetadataChannel,
} from 'src/modules/omnichannel/services/with-ordinary-metadata-channels';

export const withOrdinaryMetadataFolders = async <TResult>(
  manager: EntityManager,
  workspaceId: string,
  folderIds: readonly string[],
  work: (
    transaction: EntityManager,
    channels: OrdinaryMetadataChannel[],
  ) => Promise<TResult>,
  destinationChannelId?: string,
): Promise<TResult> => {
  if (manager.queryRunner?.isTransactionActive)
    throw new Error('OMNI_METADATA_REQUIRES_FRESH_TRANSACTION');
  if (
    !isUUID(workspaceId) ||
    !Array.isArray(folderIds) ||
    folderIds.some((id) => !isUUID(id)) ||
    (destinationChannelId !== undefined && !isUUID(destinationChannelId))
  )
    throw new Error('OMNI_INVALID_METADATA_FOLDER_SCOPE');
  const ids = [...new Set(folderIds.map((id) => id.toLowerCase()))].sort();
  const destination = destinationChannelId?.toLowerCase();
  const before: { id: string; messageChannelId: string }[] =
    await manager.query(
      'SELECT id,"messageChannelId" FROM core."messageFolder" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[])',
      [workspaceId, ids],
    );
  if (before.length !== ids.length)
    throw new Error('OMNI_METADATA_FOLDER_NOT_FOUND');
  const channelIds = [
    ...new Set([
      ...before.map((folder) => folder.messageChannelId),
      ...(destination ? [destination] : []),
    ]),
  ].sort();
  return withOrdinaryMetadataChannels(
    manager,
    workspaceId,
    channelIds,
    'message',
    async (transaction, channels) => {
      if (channels.length !== channelIds.length)
        throw new Error('OMNI_OWNED_FOLDER_REQUIRES_DOMAIN_LIFECYCLE');
      const after: { id: string; messageChannelId: string }[] =
        await transaction.query(
          'SELECT id,"messageChannelId" FROM core."messageFolder" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
          [workspaceId, ids],
        );
      const parents = new Map(
        before.map((folder) => [folder.id, folder.messageChannelId]),
      );
      if (
        after.length !== ids.length ||
        after.some(
          (folder) => parents.get(folder.id) !== folder.messageChannelId,
        )
      )
        throw new Error('OMNI_METADATA_FOLDER_PARENT_CHANGED');
      const owned = await findOmniOwnedMessageFolderIds(
        {
          executeRawQuery: (sql, parameters) =>
            transaction.query(sql, parameters),
        },
        workspaceId,
        ids,
      );
      if (owned.size)
        throw new Error('OMNI_OWNED_FOLDER_REQUIRES_DOMAIN_LIFECYCLE');
      return work(transaction, channels);
    },
  );
};
