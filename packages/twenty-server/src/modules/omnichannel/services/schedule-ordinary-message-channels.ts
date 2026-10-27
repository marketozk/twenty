import { type EntityManager } from 'typeorm';
import { withOrdinaryMetadataChannels } from 'src/modules/omnichannel/services/with-ordinary-metadata-channels';

export const scheduleOrdinaryMessageChannels = (
  manager: EntityManager,
  workspaceId: string,
  channelIds: string[],
  stages: { pending: string; scheduled: string },
): Promise<string[]> => {
  const { pending, scheduled } = stages;
  return withOrdinaryMetadataChannels(
    manager,
    workspaceId,
    channelIds,
    'message',
    async (transaction, channels) => {
      if (!channels.length) return [];
      const rows: { id: string }[] = await transaction.query(
        'WITH scheduled AS (UPDATE core."messageChannel" SET "syncStage"=$3,"syncStageStartedAt"=$4,"updatedAt"=now() WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) AND "isSyncEnabled"=true AND "syncStage"=$5 RETURNING id) SELECT id FROM scheduled',
        [
          workspaceId,
          channels.map(({ id }) => id),
          scheduled,
          new Date(),
          pending,
        ],
      );
      return rows.map(({ id }) => id);
    },
  );
};
