import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { isDefined } from 'twenty-shared/utils';
import { DataSource, In, MoreThan } from 'typeorm';

import { type MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { type MessageChannelMessageAssociationMessageFolderWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-channel-message-association-message-folder.workspace-entity';
import { type MessageChannelMessageAssociationWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-channel-message-association.workspace-entity';
import { type MessageFolderEntity } from 'src/engine/metadata-modules/message-folder/entities/message-folder.entity';
import { MessagingMessageCleanerService } from 'src/modules/messaging/message-cleaner/services/messaging-message-cleaner.service';
import { findOmniOwnedMessageIds } from 'src/modules/omnichannel/services/find-omni-owned-native-record-ids';

const BATCH_SIZE = 200;

@Injectable()
export class MessagingDeleteFolderMessagesService {
  private readonly logger = new Logger(
    MessagingDeleteFolderMessagesService.name,
  );

  constructor(
    private readonly messagingMessageCleanerService: MessagingMessageCleanerService,
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async deleteFolderMessages(
    workspaceId: string,
    messageChannel: MessageChannelEntity,
    messageFolder: MessageFolderEntity,
  ): Promise<number> {
    this.logger.log(
      `WorkspaceId: ${workspaceId}, MessageChannelId: ${messageChannel.id}, FolderId: ${messageFolder.id} - Deleting messages from folder: ${messageFolder.name}`,
    );

    const authContext = buildSystemAuthContext(workspaceId);

    let totalDeletedCount = 0;

    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        if (this.workspaceOrmManager.getWorkspaceId() !== workspaceId) {
          throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
        }
        const messageFolderAssociationRepository =
          this.workspaceOrmManager.getRepository<MessageChannelMessageAssociationMessageFolderWorkspaceEntity>(
            'messageChannelMessageAssociationMessageFolder',
            { shouldBypassPermissionChecks: true },
          );

        const messageChannelMessageAssociationRepository =
          this.workspaceOrmManager.getRepository<MessageChannelMessageAssociationWorkspaceEntity>(
            'messageChannelMessageAssociation',
            { shouldBypassPermissionChecks: true },
          );

        let lastFolderAssociationId: string | undefined;

        while (true) {
          const folderAssociations =
            await messageFolderAssociationRepository.find({
              where: {
                messageFolderId: messageFolder.id,
                ...(lastFolderAssociationId
                  ? { id: MoreThan(lastFolderAssociationId) }
                  : {}),
              },
              order: { id: 'ASC' },
              take: BATCH_SIZE,
            });

          if (folderAssociations.length === 0) {
            break;
          }

          // Advance on the complete page: protected or unrelated rows remain in place.
          lastFolderAssociationId =
            folderAssociations[folderAssociations.length - 1].id;

          const messageChannelMessageAssociationIds = folderAssociations.map(
            (folderAssociation) =>
              folderAssociation.messageChannelMessageAssociationId,
          );

          const associations =
            await messageChannelMessageAssociationRepository.find({
              withDeleted: true,
              where: {
                id: In(messageChannelMessageAssociationIds),
                messageChannelId: messageChannel.id,
              },
            });

          const ownedMessageIds = await findOmniOwnedMessageIds(
            {
              executeRawQuery: (sql, parameters) =>
                this.dataSource.query(sql, parameters),
            },
            workspaceId,
            associations.map((association) => association.messageId),
          );
          const ordinaryAssociations = associations.filter(
            (association) => !ownedMessageIds.has(association.messageId),
          );
          const ordinaryAssociationIds = new Set(
            ordinaryAssociations.map((association) => association.id),
          );
          const folderAssociationIds = folderAssociations
            .filter((folderAssociation) =>
              ordinaryAssociationIds.has(
                folderAssociation.messageChannelMessageAssociationId,
              ),
            )
            .map((folderAssociation) => folderAssociation.id);
          const messageExternalIds = ordinaryAssociations
            .filter((association) => !isDefined(association.deletedAt))
            .map((association) => association.messageExternalId)
            .filter(isDefined);

          this.logger.log(
            `WorkspaceId: ${workspaceId}, MessageChannelId: ${messageChannel.id}, FolderId: ${messageFolder.id} - Deleting ${messageExternalIds.length} messages`,
          );

          if (messageExternalIds.length > 0) {
            await this.messagingMessageCleanerService.deleteMessagesChannelMessageAssociationsAndRelatedOrphans(
              {
                workspaceId,
                messageExternalIds,
                messageChannelId: messageChannel.id,
              },
            );

            totalDeletedCount += messageExternalIds.length;
          }

          if (folderAssociationIds.length > 0) {
            await messageFolderAssociationRepository.delete({
              id: In(folderAssociationIds),
            });
          }
        }
      },
      authContext,
      { lite: true },
    );

    this.logger.log(
      `WorkspaceId: ${workspaceId}, MessageChannelId: ${messageChannel.id}, FolderId: ${messageFolder.id} - Completed deleting ${totalDeletedCount} messages from folder: ${messageFolder.name}`,
    );

    return totalDeletedCount;
  }
}
