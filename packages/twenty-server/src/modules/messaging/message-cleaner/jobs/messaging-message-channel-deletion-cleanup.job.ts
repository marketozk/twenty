import { Logger, Scope } from '@nestjs/common';
import {
  membershipCleanupOperation,
  systemMembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';

import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessagingMessageCleanerService } from 'src/modules/messaging/message-cleaner/services/messaging-message-cleaner.service';

export type MessagingMessageChannelDeletionCleanupJobData = {
  workspaceId: string;
  messageChannelId: string;
};

@Processor({
  queueName: MessageQueue.messagingQueue,
  scope: Scope.REQUEST,
})
export class MessagingMessageChannelDeletionCleanupJob {
  private readonly logger = new Logger(
    MessagingMessageChannelDeletionCleanupJob.name,
  );

  constructor(
    private readonly messageCleanerService: MessagingMessageCleanerService,
  ) {}

  @Process(MessagingMessageChannelDeletionCleanupJob.name)
  async handle(
    data: MessagingMessageChannelDeletionCleanupJobData,
  ): Promise<void> {
    const { workspaceId, messageChannelId } = data;
    const auditOperation = membershipCleanupOperation(
      workspaceId,
      systemMembershipCleanupIdentity(
        workspaceId,
        MessagingMessageChannelDeletionCleanupJob.name,
      ),
    )!;
    this.logger.debug(
      `WorkspaceId: ${workspaceId} Cleaning up message channel message associations for channel ${messageChannelId}`,
    );

    await this.messageCleanerService.deleteMessageChannelMessageAssociationsByChannelId(
      {
        workspaceId,
        messageChannelId,
        auditOperation,
      },
    );

    await this.messageCleanerService.cleanOrphanMessagesAndThreads(workspaceId);
  }
}
