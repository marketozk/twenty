import { messageImportCacheKeys } from 'src/modules/messaging/common/utils/message-import-cache-keys';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { InjectCacheStorage } from 'src/engine/core-modules/cache-storage/decorators/cache-storage.decorator';
import { CacheStorageService } from 'src/engine/core-modules/cache-storage/services/cache-storage.service';
import { CacheStorageNamespace } from 'src/engine/core-modules/cache-storage/types/cache-storage-namespace.enum';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { MessageChannelSyncStatusService } from 'src/modules/messaging/common/services/message-channel-sync-status.service';
import { MessagingMessagesImportService } from 'src/modules/messaging/message-import-manager/services/messaging-messages-import.service';
import { RECENT_MESSAGES_IMPORT_CACHE_TTL_MS } from 'src/modules/onboarding-recent-messages-import/constants/recent-messages-import-cache-ttl-ms.constant';
import { RecentMessagesService } from 'src/modules/onboarding-recent-messages-import/services/recent-messages.service';

@Injectable()
export class OnboardingRecentMessagesImportService {
  private readonly logger = new Logger(
    OnboardingRecentMessagesImportService.name,
  );

  constructor(
    @InjectCacheStorage(CacheStorageNamespace.ModuleMessaging)
    private readonly cacheStorage: CacheStorageService,
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    private readonly messageChannelSyncStatusService: MessageChannelSyncStatusService,
    private readonly messagingMessagesImportService: MessagingMessagesImportService,
    private readonly recentMessagesService: RecentMessagesService,
  ) {}

  async importRecentMessages({
    messageChannelId,
    workspaceId,
    expectedConnectedAccountId,
  }: {
    messageChannelId: string;
    workspaceId: string;
    expectedConnectedAccountId?: string;
  }): Promise<void> {
    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const candidate = await this.messageChannelRepository.findOneBy({
          id: messageChannelId,
          workspaceId,
        });
        if (!candidate) return;
        const admitted =
          await this.messageChannelSyncStatusService.beginMessagesListFetch(
            messageChannelId,
            workspaceId,
            expectedConnectedAccountId ?? candidate.connectedAccountId,
            true,
          );
        if (!admitted) return;
        const { channel, run } = admitted;
        try {
          const messageExternalIds =
            await this.recentMessagesService.getExternalIds({
              connectedAccount: channel.connectedAccount,
              messageFolders: channel.messageFolders ?? [],
            });
          if (!messageExternalIds.length) {
            await this.messageChannelSyncStatusService.finishRecentMessagesImport(
              run,
            );
            return;
          }
          const importKeys = messageImportCacheKeys({
            workspaceId,
            messageChannelId,
            connectedAccountId: run.connectedAccountId,
          });
          await this.cacheStorage.setAdd(
            importKeys.pending,
            messageExternalIds,
            RECENT_MESSAGES_IMPORT_CACHE_TTL_MS,
          );
          // Keep LIST_FETCH_ONGOING until completion: a crashed recent import must
          // recover through full list fetch, never mark this partial history synced.
          const accepted =
            await this.messagingMessagesImportService.processRecentMessageBatchImport(
              run,
              messageExternalIds.length,
            );
          if (accepted)
            this.logger.log(
              `WorkspaceId: ${workspaceId}, MessageChannelId: ${messageChannelId} - Completed recent messages import; full sync pending`,
            );
        } catch (error) {
          await this.messagingMessagesImportService.handleRecentMessagesImportFailure(
            error,
            channel,
            workspaceId,
            run,
          );
        }
      },
      buildSystemAuthContext(workspaceId),
      { lite: true },
    );
  }
}
