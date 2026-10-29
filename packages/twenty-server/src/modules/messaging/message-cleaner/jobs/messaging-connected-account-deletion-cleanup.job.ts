import {
  membershipCleanupOperation,
  systemMembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { Scope } from '@nestjs/common';

import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessagingMessageCleanerService } from 'src/modules/messaging/message-cleaner/services/messaging-message-cleaner.service';

export type MessagingConnectedAccountDeletionCleanupJobData = {
  workspaceId: string;
  connectedAccountId: string;
};

@Processor({
  queueName: MessageQueue.messagingQueue,
  scope: Scope.REQUEST,
})
export class MessagingConnectedAccountDeletionCleanupJob {
  constructor(
    private readonly messageCleanerService: MessagingMessageCleanerService,
  ) {}

  @Process(MessagingConnectedAccountDeletionCleanupJob.name)
  async handle(
    data: MessagingConnectedAccountDeletionCleanupJobData,
  ): Promise<void> {
    const workspaceId = data.workspaceId;
    const auditOperation = membershipCleanupOperation(
      workspaceId,
      systemMembershipCleanupIdentity(
        workspaceId,
        MessagingConnectedAccountDeletionCleanupJob.name,
      ),
    )!;
    await this.messageCleanerService.cleanOrphanMessagesAndThreads(
      workspaceId,
      auditOperation,
    );
  }
}
