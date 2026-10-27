import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { MessagingDeleteGroupEmailMessagesService } from 'src/modules/messaging/message-import-manager/services/messaging-delete-group-email-messages.service';
import {
  captureOrdinaryGroupEmailAction,
  finishOrdinaryGroupEmailAction,
} from 'src/modules/omnichannel/services/ordinary-group-email-action';

@Injectable()
export class MessagingProcessGroupEmailActionsService {
  constructor(
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
    private readonly messagingDeleteGroupEmailMessagesService: MessagingDeleteGroupEmailMessagesService,
  ) {}

  async processGroupEmailActions(
    messageChannel: MessageChannelEntity,
    workspaceId: string,
  ): Promise<boolean> {
    const expected = await captureOrdinaryGroupEmailAction(
      this.messageChannelRepository.manager,
      workspaceId,
      messageChannel.id,
      messageChannel.connectedAccountId,
      messageChannel.pendingGroupEmailsAction,
    );
    if (!expected) return false;
    if (expected.action === 'GROUP_EMAILS_DELETION') {
      const deleted =
        await this.messagingDeleteGroupEmailMessagesService.deleteGroupEmailMessages(
          workspaceId,
          expected.messageChannelId,
          expected,
        );
      if (deleted === null) return false;
    }
    return finishOrdinaryGroupEmailAction(
      this.messageChannelRepository.manager,
      expected,
    );
  }
}
