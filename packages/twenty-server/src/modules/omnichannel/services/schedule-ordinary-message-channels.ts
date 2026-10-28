import { type EntityManager } from 'typeorm';
import { scheduleOrdinaryMetadataChannels } from 'src/modules/omnichannel/services/schedule-ordinary-metadata-channels';

export const scheduleOrdinaryMessageChannels = async (
  manager: EntityManager,
  workspaceId: string,
  channelIds: string[],
  stages: { pending: string; scheduled: string },
): Promise<{ id: string; connectedAccountId: string }[]> =>
  scheduleOrdinaryMetadataChannels(
    manager,
    workspaceId,
    channelIds,
    'message',
    stages,
  );
