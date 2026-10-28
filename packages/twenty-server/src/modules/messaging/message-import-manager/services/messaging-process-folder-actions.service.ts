import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { type MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { type MessageFolderEntity } from 'src/engine/metadata-modules/message-folder/entities/message-folder.entity';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { OmniCoreTransactionOutcomeUnknownError } from 'src/modules/omnichannel/services/omni-core-transaction';
import {
  captureOrdinaryFolderAction,
  finishOrdinaryFolderAction,
} from 'src/modules/omnichannel/services/ordinary-folder-action';
import { MessagingDeleteFolderMessagesService } from 'src/modules/messaging/message-import-manager/services/messaging-delete-folder-messages.service';
import { MessagingImportFolderMessagesService } from 'src/modules/messaging/message-import-manager/services/messaging-import-folder-messages.service';

export type ProcessFolderActionsResult = {
  messageExternalIdsToImport: string[];
};

@Injectable()
export class MessagingProcessFolderActionsService {
  private readonly logger = new Logger(
    MessagingProcessFolderActionsService.name,
  );
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    private readonly messagingDeleteFolderMessagesService: MessagingDeleteFolderMessagesService,
    private readonly messagingImportFolderMessagesService: MessagingImportFolderMessagesService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async processFolderActions(
    messageChannel: MessageChannelEntity,
    messageFolders: MessageFolderEntity[],
    workspaceId: string,
  ): Promise<ProcessFolderActionsResult> {
    const pending = messageFolders
      .filter(
        (folder) =>
          folder.pendingSyncAction === 'FOLDER_IMPORT' ||
          folder.pendingSyncAction === 'FOLDER_DELETION',
      )
      .map((folder) => ({ ...folder }));
    if (!pending.length) return { messageExternalIdsToImport: [] };
    const channel = {
      ...messageChannel,
      connectedAccount: messageChannel.connectedAccount
        ? { ...messageChannel.connectedAccount }
        : messageChannel.connectedAccount,
    };
    if (
      channel.workspaceId !== workspaceId ||
      pending.some(
        (folder) =>
          folder.workspaceId !== workspaceId ||
          folder.messageChannelId !== channel.id,
      )
    )
      throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        if (this.workspaceOrmManager.getWorkspaceId() !== workspaceId)
          throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
        const ids = new Set<string>();
        for (const folder of pending) {
          try {
            const expected = await captureOrdinaryFolderAction(
              this.dataSource.manager,
              {
                workspaceId,
                messageChannelId: channel.id,
                connectedAccountId: channel.connectedAccountId,
                messageFolderId: folder.id,
                action: folder.pendingSyncAction,
              },
            );
            if (!expected) continue;
            const currentFolder = {
              ...folder,
              isSynced: expected.isSynced,
              externalId: expected.externalId,
              name: expected.name,
              parentFolderId: expected.parentFolderId,
            };
            let imported: string[] = [];
            if (expected.action === 'FOLDER_DELETION') {
              const deleted =
                await this.messagingDeleteFolderMessagesService.deleteFolderMessages(
                  workspaceId,
                  channel,
                  currentFolder,
                  expected,
                );
              if (deleted === null) continue;
            } else {
              imported =
                await this.messagingImportFolderMessagesService.getFolderMessageIdsToImport(
                  {
                    ...channel,
                    messageFolders: expected.hierarchy.map((item) => ({
                      ...currentFolder,
                      id: item.id,
                      name: item.name,
                      externalId: item.externalId,
                      parentFolderId: item.parentFolderId,
                    })),
                  },
                  currentFolder,
                );
            }
            if (
              await finishOrdinaryFolderAction(
                this.dataSource.manager,
                expected,
              )
            )
              for (const id of imported) ids.add(id);
          } catch (error) {
            if (
              error instanceof OmniCoreTransactionOutcomeUnknownError ||
              error instanceof NativeTransactionOutcomeUnknownError
            )
              throw error;
            const normalized =
              error instanceof Error
                ? error
                : new Error('Unexpected folder processing failure', {
                    cause: error,
                  });
            this.logger.error(
              `WorkspaceId: ${workspaceId}, MessageChannelId: ${channel.id}, FolderId: ${folder.id} - Error processing folder action: ${normalized.message}`,
              normalized.stack,
            );
          }
        }
        return { messageExternalIdsToImport: [...ids] };
      },
      buildSystemAuthContext(workspaceId),
      { lite: true },
    );
  }
}
