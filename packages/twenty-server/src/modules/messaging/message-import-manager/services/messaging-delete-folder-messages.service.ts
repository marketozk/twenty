import { Injectable } from '@nestjs/common';
import {
  membershipCleanupOperation,
  systemMembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { deleteOrdinaryFolderMessagePageWithAudit } from 'src/engine/core-modules/crm-audit/delete-ordinary-folder-message-page-with-audit';
import { type MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { type MessageFolderEntity } from 'src/engine/metadata-modules/message-folder/entities/message-folder.entity';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { type OrdinaryFolderAction } from 'src/modules/omnichannel/services/ordinary-folder-action';

@Injectable()
export class MessagingDeleteFolderMessagesService {
  constructor(private readonly workspaceOrmManager: WorkspaceOrmManager) {}

  async deleteFolderMessages(
    workspaceId: string,
    messageChannel: MessageChannelEntity,
    messageFolder: MessageFolderEntity,
    folderAction: OrdinaryFolderAction,
  ): Promise<number | null> {
    const messageChannelId = messageChannel.id;
    const messageFolderId = messageFolder.id;
    if (
      !folderAction ||
      folderAction.workspaceId !== workspaceId ||
      folderAction.messageChannelId !== messageChannelId ||
      folderAction.messageFolderId !== messageFolderId ||
      folderAction.action !== 'FOLDER_DELETION'
    )
      throw new Error('OMNI_INVALID_FOLDER_ACTION_SCOPE');
    const action = {
      ...folderAction,
      hierarchy: folderAction.hierarchy.map((entry) => ({ ...entry })),
    };
    const identity = systemMembershipCleanupIdentity(
      workspaceId,
      MessagingDeleteFolderMessagesService.name,
    );
    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        if (this.workspaceOrmManager.getWorkspaceId() !== workspaceId)
          throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
        let cursor: string | undefined;
        let deleted = 0;
        for (;;) {
          const operation = membershipCleanupOperation(workspaceId, identity)!;
          const page = await this.workspaceOrmManager.runInWorkspaceTransaction(
            async (scope) => {
              if (scope.workspaceId !== workspaceId)
                throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
              return deleteOrdinaryFolderMessagePageWithAudit({
                scope,
                operation,
                action,
                cursor,
              });
            },
            { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
          );
          if (page === null) return null;
          deleted += page.deletedAssociationCount;
          if (page.done) return deleted;
          if (!page.cursor || page.cursor === cursor)
            throw new Error('Native folder cleanup invalid page cursor');
          cursor = page.cursor;
        }
      },
      buildSystemAuthContext(workspaceId),
      { lite: true },
    );
  }
}
