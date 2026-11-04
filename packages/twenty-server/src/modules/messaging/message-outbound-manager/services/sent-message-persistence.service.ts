import { Injectable } from '@nestjs/common';
import { captureCrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { captureMessageImportMatchingContext } from 'src/engine/core-modules/crm-audit/message-import-matching-context';
import { InjectRepository } from '@nestjs/typeorm';

import { isDefined } from 'twenty-shared/utils';
import { Repository } from 'typeorm';

import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { MessagingSaveMessagesAndEnqueueContactCreationService } from 'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service';
import { type PersistSentMessageInput } from 'src/modules/messaging/message-outbound-manager/types/persist-sent-message-input.type';
import { type PersistedSentMessage } from 'src/modules/messaging/message-outbound-manager/types/persisted-sent-message.type';
import { formatSentMessage } from 'src/modules/messaging/message-outbound-manager/utils/format-sent-message.util';

@Injectable()
export class SentMessagePersistenceService {
  constructor(
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
    private readonly saveMessagesAndEnqueueContactCreationService: MessagingSaveMessagesAndEnqueueContactCreationService,
  ) {}

  async persistSentMessage(
    input: PersistSentMessageInput,
  ): Promise<PersistedSentMessage | undefined> {
    input = {
      ...input,
      auditOperation: captureCrmAuditOperation(input.auditOperation),
      matchingCaller: { ...input.matchingCaller },
      connectedAccount: { ...input.connectedAccount },
    };
    const messageChannel = await this.messageChannelRepository.findOneOrFail({
      where: {
        id: input.messageChannelId,
        workspaceId: input.workspaceId,
      },
      relations: { connectedAccount: true },
    });

    if (
      messageChannel.connectedAccountId !== input.connectedAccount.id ||
      messageChannel.connectedAccount.id !== input.connectedAccount.id
    )
      throw new Error('Sent matching channel changed its sending account');
    const context = captureMessageImportMatchingContext({
      operation: input.auditOperation,
      authority: {
        workspaceId: input.workspaceId,
        connectedAccountId: input.connectedAccount.id,
        channelId: input.messageChannelId,
        channelType: messageChannel.type,
        ...input.matchingCaller,
      },
    });

    const messageToSave = formatSentMessage(input);

    const savedMessagesResult =
      await this.saveMessagesAndEnqueueContactCreationService.saveMessagesAndEnqueueContactCreation(
        [messageToSave],
        messageChannel,
        messageChannel.connectedAccount,
        input.workspaceId,
        { context },
      );

    const messageId = savedMessagesResult?.messageExternalIdsAndIdsMap.get(
      messageToSave.externalId,
    );
    const messageThreadId =
      savedMessagesResult?.messageExternalIdToMessageThreadIdMap.get(
        messageToSave.externalId,
      );

    if (!isDefined(messageId) || !isDefined(messageThreadId)) {
      return undefined;
    }

    return { messageId, messageThreadId };
  }
}
