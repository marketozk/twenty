import { Logger, Scope } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { In, Repository } from 'typeorm';

import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { MessageChannelSyncStatusService } from 'src/modules/messaging/common/services/message-channel-sync-status.service';
import { MESSAGING_ONGOING_STALE_SYNC_STAGES } from 'src/modules/messaging/message-import-manager/constants/messaging-ongoing-stale-sync-stages.constant';

export type MessagingOngoingStaleJobData = {
  workspaceId: string;
};

@Processor({
  queueName: MessageQueue.messagingQueue,
  scope: Scope.REQUEST,
})
export class MessagingOngoingStaleJob {
  private readonly logger = new Logger(MessagingOngoingStaleJob.name);
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
    private readonly messageChannelSyncStatusService: MessageChannelSyncStatusService,
  ) {}

  @Process(MessagingOngoingStaleJob.name)
  async handle(data: MessagingOngoingStaleJobData): Promise<void> {
    const { workspaceId } = data;

    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const messageChannels = await this.messageChannelRepository.find({
          where: {
            syncStage: In(MESSAGING_ONGOING_STALE_SYNC_STAGES),
            workspaceId,
          },
        });

        const accepted =
          await this.messageChannelSyncStatusService.requeueStaleChannels(
            messageChannels.map(({ id }) => id),
            workspaceId,
          );
        if (accepted.length)
          this.logger.log(
            `Requeued ${accepted.length} stale message channels in workspace ${workspaceId}`,
          );
      },
      authContext,
      { lite: true },
    );
  }
}
