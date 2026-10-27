import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { In, Repository } from 'typeorm';
import { type QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import {
  MessageChannelPendingGroupEmailsAction,
  MessageChannelSyncStage,
  MessageChannelSyncStatus,
  MessageFolderPendingSyncAction,
} from 'twenty-shared/types';
import { InjectCacheStorage } from 'src/engine/core-modules/cache-storage/decorators/cache-storage.decorator';
import { CacheStorageService } from 'src/engine/core-modules/cache-storage/services/cache-storage.service';
import { CacheStorageNamespace } from 'src/engine/core-modules/cache-storage/types/cache-storage-namespace.enum';
import { MetricsService } from 'src/engine/core-modules/metrics/metrics.service';
import { MetricsKeys } from 'src/engine/core-modules/metrics/types/metrics-keys.type';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { MessageFolderEntity } from 'src/engine/metadata-modules/message-folder/entities/message-folder.entity';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { AccountsToReconnectService } from 'src/modules/connected-account/services/accounts-to-reconnect.service';
import { AccountsToReconnectKeys } from 'src/modules/connected-account/types/accounts-to-reconnect-key-value.type';
import { type WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { type WorkspaceBroadcastEvent } from 'src/engine/subscriptions/workspace-event-broadcaster/types/workspace-broadcast-event.type';
import { WorkspaceEventBroadcaster } from 'src/engine/subscriptions/workspace-event-broadcaster/workspace-event-broadcaster.service';
import { computeMessageImportProgress } from 'src/engine/metadata-modules/message-channel/utils/compute-message-import-progress.util';
import { findOmniOwnedMessageFolderIds } from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';

import { withOrdinaryMetadataChannels } from 'src/modules/omnichannel/services/with-ordinary-metadata-channels';

type UpdatedMessageChannel = Pick<
  MessageChannelEntity,
  'id' | 'syncStatus' | 'syncStage'
> & { userWorkspaceId: string; connectedAccountId: string };

@Injectable()
export class MessageChannelSyncStatusService {
  private readonly logger = new Logger(MessageChannelSyncStatusService.name);

  constructor(
    @InjectCacheStorage(CacheStorageNamespace.ModuleMessaging)
    private readonly cacheStorage: CacheStorageService,
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
    @InjectWorkspaceScopedRepository(MessageFolderEntity)
    private readonly messageFolderRepository: WorkspaceScopedRepository<MessageFolderEntity>,
    @InjectRepository(ConnectedAccountEntity)
    private readonly connectedAccountRepository: Repository<ConnectedAccountEntity>,
    @InjectRepository(UserWorkspaceEntity)
    private readonly userWorkspaceRepository: Repository<UserWorkspaceEntity>,
    private readonly accountsToReconnectService: AccountsToReconnectService,
    private readonly metricsService: MetricsService,
    private readonly workspaceEventBroadcaster: WorkspaceEventBroadcaster,
  ) {}

  public async markAsMessagesListFetchPending(
    messageChannelIds: string[],
    workspaceId: string,
    preserveSyncStageStartedAt: boolean = false,
  ) {
    if (!messageChannelIds.length) {
      return;
    }

    await this.updateMessageChannels(messageChannelIds, workspaceId, {
      syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
      ...(!preserveSyncStageStartedAt ? { syncStageStartedAt: null } : {}),
    });
  }

  public async markAsMessagesImportPending(
    messageChannelIds: string[],
    workspaceId: string,
    preserveSyncStageStartedAt: boolean = false,
  ) {
    if (!messageChannelIds.length) {
      return;
    }

    await this.updateMessageChannels(messageChannelIds, workspaceId, {
      syncStage: MessageChannelSyncStage.MESSAGES_IMPORT_PENDING,
      ...(!preserveSyncStageStartedAt ? { syncStageStartedAt: null } : {}),
    });
  }

  public async resetAndMarkAsMessagesListFetchPending(
    messageChannelIds: string[],
    workspaceId: string,
  ) {
    if (!messageChannelIds.length) {
      return;
    }

    const updated = await this.mutateMessageChannels(
      messageChannelIds,
      workspaceId,
      {
        syncCursor: '',
        syncStageStartedAt: null,
        throttleFailureCount: 0,
        throttleRetryAfter: null,
        pendingGroupEmailsAction: MessageChannelPendingGroupEmailsAction.NONE,
        syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
      },
      { resetFolders: true },
    );
    for (const { id } of updated) {
      await this.cacheStorage.mdel([
        `messages-to-import:${workspaceId}:${id}`,
        `messages-to-import-total:${workspaceId}:${id}`,
        `messages-imported:${workspaceId}:${id}`,
      ]);
    }
    await this.broadcastMessageChannelsUpdated(updated, workspaceId);
  }

  public async resetSyncStageStartedAt(
    messageChannelIds: string[],
    workspaceId: string,
  ) {
    if (!messageChannelIds.length) {
      return;
    }

    await this.mutateMessageChannels(messageChannelIds, workspaceId, {
      syncStageStartedAt: null,
    });
  }

  public async markAsMessagesListFetchScheduled(
    messageChannelIds: string[],
    workspaceId: string,
  ) {
    if (!messageChannelIds.length) {
      return;
    }

    await this.updateMessageChannels(messageChannelIds, workspaceId, {
      syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_SCHEDULED,
      syncStatus: MessageChannelSyncStatus.ONGOING,
      syncStageStartedAt: new Date().toISOString(),
    });
  }

  public async markAsMessagesListFetchScheduledIfPending(
    messageChannelIds: string[],
    workspaceId: string,
  ): Promise<string[]> {
    if (!messageChannelIds.length) {
      return [];
    }

    return withOrdinaryMetadataChannels(
      this.messageChannelRepository.manager,
      workspaceId,
      messageChannelIds,
      'message',
      async (manager, channels) => {
        if (!channels.length) return [];
        const result = await manager
          .getRepository(MessageChannelEntity)
          .createQueryBuilder()
          .update()
          .set({
            syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_SCHEDULED,
            syncStageStartedAt: new Date(),
          })
          .where({
            id: In(channels.map(({ id }) => id)),
            workspaceId,
            isSyncEnabled: true,
            syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
          })
          .returning('id')
          .execute();
        return result.raw.map((row: { id: string }) => row.id);
      },
    );
  }

  public async markAsMessagesListFetchOngoing(
    messageChannelIds: string[],
    workspaceId: string,
  ) {
    if (!messageChannelIds.length) {
      return;
    }

    await this.updateMessageChannels(messageChannelIds, workspaceId, {
      syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_ONGOING,
      syncStatus: MessageChannelSyncStatus.ONGOING,
      syncStageStartedAt: new Date().toISOString(),
    });
  }

  public async markAsMessageSyncCompleted(
    messageChannelIds: string[],
    workspaceId: string,
  ) {
    if (!messageChannelIds.length) {
      return;
    }

    const updated = await this.mutateMessageChannels(
      messageChannelIds,
      workspaceId,
      {
        syncStatus: MessageChannelSyncStatus.ACTIVE,
        syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
        throttleFailureCount: 0,
        throttleRetryAfter: null,
        syncStageStartedAt: null,
        syncedAt: new Date().toISOString(),
      },
    );

    const acceptedIds = updated.map(({ id }) => id);
    if (!acceptedIds.length) return;
    await this.clearImportProgress(acceptedIds, workspaceId);
    await this.broadcastMessageChannelsUpdated(updated, workspaceId);
    await this.metricsService.incrementCounterForEvents({
      key: MetricsKeys.MessageChannelSyncJobActive,
      eventIds: acceptedIds,
    });
  }

  public async markAsMessagesImportScheduled(
    messageChannelIds: string[],
    workspaceId: string,
  ) {
    if (!messageChannelIds.length) {
      return;
    }

    await this.updateMessageChannels(messageChannelIds, workspaceId, {
      syncStage: MessageChannelSyncStage.MESSAGES_IMPORT_SCHEDULED,
    });
  }

  public async markAsMessagesImportOngoing(
    messageChannelIds: string[],
    workspaceId: string,
  ) {
    if (!messageChannelIds.length) {
      return;
    }

    await this.updateMessageChannels(messageChannelIds, workspaceId, {
      syncStage: MessageChannelSyncStage.MESSAGES_IMPORT_ONGOING,
      syncStatus: MessageChannelSyncStatus.ONGOING,
      syncStageStartedAt: new Date().toISOString(),
    });
  }

  public async markAsFailed({
    messageChannelIds,
    workspaceId,
    syncStatus,
    authFailedReason = null,
    expectedConnectedAccountId,
  }: {
    messageChannelIds: string[];
    workspaceId: string;
    syncStatus:
      | MessageChannelSyncStatus.FAILED_INSUFFICIENT_PERMISSIONS
      | MessageChannelSyncStatus.FAILED_UNKNOWN;
    authFailedReason?: string | null;
    expectedConnectedAccountId?: string;
  }) {
    if (!messageChannelIds.length) {
      return;
    }

    this.logger.warn(
      `Marking message channels [${messageChannelIds.join(', ')}] as ${syncStatus} in workspace ${workspaceId}`,
    );

    const insufficient =
      syncStatus === MessageChannelSyncStatus.FAILED_INSUFFICIENT_PERMISSIONS;
    const updated = await this.mutateMessageChannels(
      messageChannelIds,
      workspaceId,
      {
        syncStage: MessageChannelSyncStage.FAILED,
        syncStatus,
        throttleRetryAfter: null,
      },
      insufficient
        ? {
            authFailure: { reason: authFailedReason },
            expectedConnectedAccountId,
          }
        : {},
    );
    const acceptedIds = updated.map(({ id }) => id);
    if (!acceptedIds.length) return;
    await this.clearImportProgress(acceptedIds, workspaceId);
    await this.broadcastMessageChannelsUpdated(updated, workspaceId);
    await this.metricsService.incrementCounterForEvents({
      key: insufficient
        ? MetricsKeys.MessageChannelSyncJobFailedInsufficientPermissions
        : MetricsKeys.MessageChannelSyncJobFailedUnknown,
      eventIds: acceptedIds,
    });
    if (insufficient)
      await this.workspaceOrmManager.executeInWorkspaceContext(
        () => this.addToAccountsToReconnect(updated, workspaceId),
        buildSystemAuthContext(workspaceId),
        { lite: true },
      );
  }

  public async getImportProgress({
    messageChannelId,
    workspaceId,
  }: {
    messageChannelId: string;
    workspaceId: string;
  }): Promise<number | null> {
    const [totalMessagesToImportCount, importedMessagesCount] =
      await this.cacheStorage.mget<number>([
        `messages-to-import-total:${workspaceId}:${messageChannelId}`,
        `messages-imported:${workspaceId}:${messageChannelId}`,
      ]);

    return computeMessageImportProgress({
      importedMessagesCount,
      totalMessagesToImportCount,
    });
  }

  private async clearImportProgress(
    messageChannelIds: string[],
    workspaceId: string,
  ) {
    await this.cacheStorage.mdel(
      messageChannelIds.flatMap((messageChannelId) => [
        `messages-to-import-total:${workspaceId}:${messageChannelId}`,
        `messages-imported:${workspaceId}:${messageChannelId}`,
      ]),
    );
  }

  private async updateMessageChannels(
    messageChannelIds: string[],
    workspaceId: string,
    values: QueryDeepPartialEntity<MessageChannelEntity>,
  ) {
    const updated = await this.mutateMessageChannels(
      messageChannelIds,
      workspaceId,
      values,
    );
    await this.broadcastMessageChannelsUpdated(updated, workspaceId);
    return updated;
  }

  private async mutateMessageChannels(
    channelIds: string[],
    workspaceId: string,
    values: QueryDeepPartialEntity<MessageChannelEntity>,
    options: {
      resetFolders?: boolean;
      expectedConnectedAccountId?: string;
      authFailure?: { reason: string | null };
    } = {},
  ): Promise<UpdatedMessageChannel[]> {
    const requestedIds = [...channelIds];
    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        if (this.workspaceOrmManager.getWorkspaceId() !== workspaceId)
          throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
        return withOrdinaryMetadataChannels(
          this.messageChannelRepository.manager,
          workspaceId,
          requestedIds,
          'message',
          async (manager, channels) => {
            if (!channels.length) return [];
            const ids = channels.map(({ id }) => id);
            const result = await manager
              .getRepository(MessageChannelEntity)
              .createQueryBuilder()
              .update()
              .set(values)
              .where({ id: In(ids), workspaceId })
              .returning('id, "syncStatus", "syncStage"')
              .execute();
            const updated = (
              result.raw as Pick<
                UpdatedMessageChannel,
                'id' | 'syncStatus' | 'syncStage'
              >[]
            ).map((row) => {
              const channel = channels.find(({ id }) => id === row.id);
              if (!channel)
                throw new Error('OMNI_UNEXPECTED_CHANNEL_UPDATE_RESULT');
              return { ...channel, ...row };
            });
            if (options.resetFolders && updated.length) {
              const folders: { id: string }[] = await manager.query(
                'SELECT id FROM core."messageFolder" WHERE "workspaceId"=$1 AND "messageChannelId"=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
                [workspaceId, updated.map(({ id }) => id)],
              );
              const owned = await findOmniOwnedMessageFolderIds(
                {
                  executeRawQuery: (sql, parameters) =>
                    manager.query(sql, parameters),
                },
                workspaceId,
                folders.map(({ id }) => id),
              );
              const ordinaryFolders = folders
                .filter(({ id }) => !owned.has(id))
                .map(({ id }) => id);
              if (ordinaryFolders.length)
                await this.messageFolderRepository.withManager(manager).update(
                  workspaceId,
                  { id: In(ordinaryFolders) },
                  {
                    syncCursor: '',
                    pendingSyncAction: MessageFolderPendingSyncAction.NONE,
                  },
                );
            }
            if (options.authFailure && updated.length) {
              await manager
                .getRepository(this.connectedAccountRepository.target)
                .update(
                  {
                    id: In([
                      ...new Set(
                        updated.map(
                          ({ connectedAccountId }) => connectedAccountId,
                        ),
                      ),
                    ]),
                    workspaceId,
                  },
                  {
                    authFailedAt: new Date(),
                    authFailedReason: options.authFailure.reason,
                  },
                );
            }
            return updated;
          },
          options.authFailure ? 'write' : 'read',
          options.expectedConnectedAccountId,
        );
      },
      buildSystemAuthContext(workspaceId),
      { lite: true },
    );
  }

  private async broadcastMessageChannelsUpdated(
    updatedMessageChannels: UpdatedMessageChannel[],
    workspaceId: string,
  ): Promise<void> {
    if (!updatedMessageChannels.length) return;
    try {
      const events: WorkspaceBroadcastEvent[] = await Promise.all(
        updatedMessageChannels.map(
          async ({ id, syncStatus, syncStage, userWorkspaceId }) => ({
            type: 'updated',
            entityName: 'messageChannel',
            recordId: id,
            properties: {
              after: {
                id,
                syncStatus,
                syncStage,
                importProgress: await this.getImportProgress({
                  messageChannelId: id,
                  workspaceId,
                }),
              },
            },
            recipientUserWorkspaceIds: [userWorkspaceId],
          }),
        ),
      );

      await this.workspaceEventBroadcaster.broadcast({ workspaceId, events });
    } catch (error) {
      this.logger.warn(
        `Failed to broadcast updated event for message channels [${updatedMessageChannels.map(({ id }) => id).join(', ')}] in workspace ${workspaceId}`,
        error,
      );
    }
  }

  private async addToAccountsToReconnect(
    channels: UpdatedMessageChannel[],
    workspaceId: string,
  ) {
    const workspaceMemberRepository =
      this.workspaceOrmManager.getRepository<WorkspaceMemberWorkspaceEntity>(
        'workspaceMember',
        { shouldBypassPermissionChecks: true },
      );
    const accounts = new Map(
      channels.map((channel) => [
        channel.connectedAccountId,
        channel.userWorkspaceId,
      ]),
    );
    for (const [connectedAccountId, userWorkspaceId] of accounts) {
      const userWorkspace = await this.userWorkspaceRepository.findOne({
        where: { id: userWorkspaceId, workspaceId },
      });
      if (!userWorkspace) continue;
      const workspaceMember = await workspaceMemberRepository.findOne({
        where: { userId: userWorkspace.userId },
      });
      if (!workspaceMember) continue;
      await this.accountsToReconnectService.addAccountToReconnectByKey(
        AccountsToReconnectKeys.ACCOUNTS_TO_RECONNECT_INSUFFICIENT_PERMISSIONS,
        workspaceMember.userId,
        workspaceId,
        connectedAccountId,
      );
    }
  }
}
