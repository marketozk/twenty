import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { MessageFolderEntity } from 'src/engine/metadata-modules/message-folder/entities/message-folder.entity';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { isSyncCursorNewer } from 'src/modules/messaging/message-import-manager/utils/is-sync-cursor-newer.util';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';

import { withOrdinaryMetadataChannel } from 'src/modules/omnichannel/services/with-ordinary-metadata-channel';
import { findOmniOwnedMessageFolderIds } from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';

@Injectable()
export class MessagingCursorService {
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
    @InjectWorkspaceScopedRepository(MessageFolderEntity)
    private readonly messageFolderRepository: WorkspaceScopedRepository<MessageFolderEntity>,
  ) {}

  public async updateCursor(
    messageChannel: MessageChannelEntity,
    nextSyncCursor: string,
    workspaceId: string,
    folderId?: string,
  ) {
    const channelId = messageChannel.id;
    const expectedAccountId = messageChannel.connectedAccountId;
    const cursor = nextSyncCursor;
    const targetFolderId = folderId;
    await this.workspaceOrmManager.executeInWorkspaceContext(
      () =>
        withOrdinaryMetadataChannel(
          this.messageChannelRepository.manager,
          workspaceId,
          channelId,
          'message',
          async (manager) => {
            const channels = manager.getRepository(MessageChannelEntity);
            const current = await channels.findOneByOrFail({
              id: channelId,
              workspaceId,
            });
            const reset = {
              throttleFailureCount: 0,
              throttleRetryAfter: null,
              syncStageStartedAt: null,
            };
            if (!targetFolderId) {
              await channels.update(
                { id: channelId, workspaceId },
                {
                  ...reset,
                  syncCursor: isSyncCursorNewer(cursor, current.syncCursor)
                    ? cursor
                    : current.syncCursor,
                },
              );
              return true;
            }
            const folders: { id: string; messageChannelId: string }[] =
              await manager.query(
                'SELECT id, "messageChannelId" FROM core."messageFolder" WHERE "workspaceId"=$1 AND id=$2 FOR UPDATE',
                [workspaceId, targetFolderId],
              );
            if (
              folders.length !== 1 ||
              folders[0].messageChannelId !== channelId
            )
              return false;
            const owned = await findOmniOwnedMessageFolderIds(
              {
                executeRawQuery: (sql, parameters) =>
                  manager.query(sql, parameters),
              },
              workspaceId,
              [targetFolderId],
            );
            if (owned.size) return false;
            await this.messageFolderRepository
              .withManager(manager)
              .update(
                workspaceId,
                { id: targetFolderId, messageChannelId: channelId },
                { syncCursor: cursor },
              );
            await channels.update({ id: channelId, workspaceId }, reset);
            return true;
          },
          expectedAccountId,
        ),
      buildSystemAuthContext(workspaceId),
      { lite: true },
    );
  }
}
