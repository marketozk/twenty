import { withOrdinaryMetadataChannels } from 'src/modules/omnichannel/services/with-ordinary-metadata-channels';
import { Scope } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { MessageChannelSyncStage } from 'twenty-shared/types';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { MessagingMessagesImportService } from 'src/modules/messaging/message-import-manager/services/messaging-messages-import.service';
import { MessagingMonitoringService } from 'src/modules/messaging/monitoring/services/messaging-monitoring.service';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';

export type MessagingMessagesImportJobData = {
  messageChannelId: string;
  workspaceId: string;
  expectedConnectedAccountId?: string;
};

@Processor({
  queueName: MessageQueue.messagingQueue,
  scope: Scope.REQUEST,
})
export class MessagingMessagesImportJob {
  constructor(
    private readonly messagingMessagesImportService: MessagingMessagesImportService,
    private readonly messagingMonitoringService: MessagingMonitoringService,
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
  ) {}

  @Process(MessagingMessagesImportJob.name)
  async handle(data: MessagingMessagesImportJobData): Promise<void> {
    const { messageChannelId, workspaceId, expectedConnectedAccountId } = data;

    await this.messagingMonitoringService.track({
      eventName: 'messages_import.triggered',
      workspaceId,
      messageChannelId,
    });

    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const messageChannel = await withOrdinaryMetadataChannels(
          this.messageChannelRepository.manager,
          workspaceId,
          [messageChannelId],
          'message',
          async (manager, channels) => {
            if (!channels.length) return null;
            return manager.getRepository(MessageChannelEntity).findOne({
              where: {
                id: messageChannelId,
                isSyncEnabled: true,
                workspaceId,
              },
              relations: { connectedAccount: true, messageFolders: true },
            });
          },
          'read',
          expectedConnectedAccountId,
        );

        if (!messageChannel) {
          await this.messagingMonitoringService.track({
            eventName: 'messages_import.error.message_channel_not_found',
            messageChannelId,
            workspaceId,
          });

          return;
        }

        if (!messageChannel?.isSyncEnabled) {
          return;
        }

        if (
          messageChannel.syncStage !==
          MessageChannelSyncStage.MESSAGES_IMPORT_SCHEDULED
        ) {
          return;
        }

        await this.messagingMessagesImportService.processMessageBatchImport(
          messageChannel,
          messageChannel.connectedAccount,
          workspaceId,
        );
      },
      authContext,
      { lite: true },
    );
  }
}
