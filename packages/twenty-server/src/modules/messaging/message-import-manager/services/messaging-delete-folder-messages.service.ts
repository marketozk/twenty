import {
  lockCurrentFolderAction,
  type OrdinaryFolderAction,
} from 'src/modules/omnichannel/services/ordinary-folder-action';
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
    folderAction?: OrdinaryFolderAction,
  ): Promise<number | null> {
    if (folderAction)
      return this.deleteGuardedFolderMessages(
        workspaceId,
        messageChannel.id,
        messageFolder.id,
        { ...folderAction },
      );
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
  private async deleteGuardedFolderMessages(
    workspaceId: string,
    messageChannelId: string,
    messageFolderId: string,
    expected: OrdinaryFolderAction,
  ): Promise<number | null> {
    if (
      expected.workspaceId !== workspaceId ||
      expected.messageChannelId !== messageChannelId ||
      expected.messageFolderId !== messageFolderId ||
      expected.action !== 'FOLDER_DELETION'
    )
      throw new Error('OMNI_INVALID_FOLDER_ACTION_SCOPE');
    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        if (this.workspaceOrmManager.getWorkspaceId() !== workspaceId)
          throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
        let cursor: string | undefined;
        let deleted = 0;
        for (;;) {
          const page = await this.workspaceOrmManager.runInWorkspaceTransaction(
            async (scope) => {
              if (scope.workspaceId !== workspaceId)
                throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
              if (!(await lockCurrentFolderAction(scope, expected)))
                return null;
              const junctions =
                scope.getRepository<MessageChannelMessageAssociationMessageFolderWorkspaceEntity>(
                  'messageChannelMessageAssociationMessageFolder',
                  { shouldBypassPermissionChecks: true },
                );
              const associations =
                scope.getRepository<MessageChannelMessageAssociationWorkspaceEntity>(
                  'messageChannelMessageAssociation',
                  { shouldBypassPermissionChecks: true },
                );
              const rows = await junctions.find({
                withDeleted: true,
                where: {
                  messageFolderId,
                  ...(cursor ? { id: MoreThan(cursor) } : {}),
                },
                order: { id: 'ASC' },
                take: BATCH_SIZE,
              });
              if (!rows.length)
                return { cursor: undefined, count: 0, done: true };
              const candidates = await associations.find({
                withDeleted: true,
                where: {
                  id: In(
                    rows.map((row) => row.messageChannelMessageAssociationId),
                  ),
                  messageChannelId,
                },
              });
              const owned = await findOmniOwnedMessageIds(
                scope,
                workspaceId,
                candidates.map((row) => row.messageId),
              );
              const ordinary = candidates.filter(
                (row) => !owned.has(row.messageId),
              );
              const allowed = new Set(ordinary.map((row) => row.id));
              const junctionIds = rows
                .filter((row) =>
                  allowed.has(row.messageChannelMessageAssociationId),
                )
                .map((row) => row.id);
              const messageExternalIds = ordinary
                .filter((row) => !isDefined(row.deletedAt))
                .map((row) => row.messageExternalId)
                .filter(isDefined);
              if (messageExternalIds.length)
                await this.messagingMessageCleanerService.deleteMessageAssociationsWithinTransaction(
                  scope,
                  { workspaceId, messageChannelId, messageExternalIds },
                );
              if (junctionIds.length)
                await junctions.delete({ id: In(junctionIds) });
              return {
                cursor: rows[rows.length - 1].id,
                count: messageExternalIds.length,
                done: rows.length < BATCH_SIZE,
              };
            },
            { commitOutcome: 'strict' },
          );
          if (page === null) return null;
          deleted += page.count;
          cursor = page.cursor;
          if (page.done) return deleted;
        }
      },
      buildSystemAuthContext(workspaceId),
      { lite: true },
    );
  }
}
