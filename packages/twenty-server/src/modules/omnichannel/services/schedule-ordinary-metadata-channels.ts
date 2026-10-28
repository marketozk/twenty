import { type EntityManager } from 'typeorm';
import { withOrdinaryMetadataChannels } from 'src/modules/omnichannel/services/with-ordinary-metadata-channels';

export const scheduleOrdinaryMetadataChannels = (
  manager: EntityManager,
  workspaceId: string,
  channelIds: string[],
  kind: 'message' | 'calendar',
  stages: { pending: string; scheduled: string },
  expectedConnectedAccountId?: string,
): Promise<{ id: string; connectedAccountId: string }[]> => {
  const { pending, scheduled } = stages;
  const table = kind === 'message' ? 'messageChannel' : 'calendarChannel';
  return withOrdinaryMetadataChannels(
    manager,
    workspaceId,
    channelIds,
    kind,
    async (transaction, channels) => {
      if (!channels.length) return [];
      return transaction.query(
        `WITH scheduled AS (UPDATE core."${table}" SET "syncStage"=$3,"syncStageStartedAt"=$4,"updatedAt"=now()
       WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) AND "isSyncEnabled"=true AND "syncStage"=$5
       RETURNING id,"connectedAccountId") SELECT id,"connectedAccountId" FROM scheduled`,
        [
          workspaceId,
          channels.map(({ id }) => id),
          scheduled,
          new Date(),
          pending,
        ],
      );
    },
    'read',
    expectedConnectedAccountId,
  );
};
