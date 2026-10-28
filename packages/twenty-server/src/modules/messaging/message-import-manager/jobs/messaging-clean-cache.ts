import {
  messageImportCacheKeys,
  legacyMessageImportCacheKeys,
} from 'src/modules/messaging/common/utils/message-import-cache-keys';
import { InjectCacheStorage } from 'src/engine/core-modules/cache-storage/decorators/cache-storage.decorator';
import { CacheStorageService } from 'src/engine/core-modules/cache-storage/services/cache-storage.service';
import { CacheStorageNamespace } from 'src/engine/core-modules/cache-storage/types/cache-storage-namespace.enum';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';

export type MessagingCleanCacheJobData = {
  workspaceId: string;
  messageChannelId: string;
  connectedAccountId?: string;
};

@Processor(MessageQueue.messagingQueue)
export class MessagingCleanCacheJob {
  constructor(
    @InjectCacheStorage(CacheStorageNamespace.ModuleMessaging)
    private readonly cacheStorage: CacheStorageService,
  ) {}

  @Process(MessagingCleanCacheJob.name)
  async handle(data: MessagingCleanCacheJobData): Promise<void> {
    const keys =
      data.connectedAccountId === undefined
        ? legacyMessageImportCacheKeys(data.workspaceId, data.messageChannelId)
        : messageImportCacheKeys({
            workspaceId: data.workspaceId,
            messageChannelId: data.messageChannelId,
            connectedAccountId: data.connectedAccountId,
          });
    await this.cacheStorage.mdel(Object.values(keys));
  }
}
