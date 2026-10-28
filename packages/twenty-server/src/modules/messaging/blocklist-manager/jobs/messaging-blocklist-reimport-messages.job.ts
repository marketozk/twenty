import { Scope } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { type ObjectRecordDeleteEvent } from 'twenty-shared/database-events';
import { MessageChannelSyncStage } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { type FindOptionsWhere, In, Not, Repository } from 'typeorm';

import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';
import { type BlocklistWorkspaceEntity } from 'src/modules/blocklist/standard-objects/blocklist.workspace-entity';
import { groupBlocklistHandlesByOwner } from 'src/modules/blocklist/utils/group-blocklist-handles-by-owner.util';
import { MessageChannelSyncStatusService } from 'src/modules/messaging/common/services/message-channel-sync-status.service';
import { type WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';

export type BlocklistReimportMessagesJobData = WorkspaceEventBatch<
  ObjectRecordDeleteEvent<BlocklistWorkspaceEntity>
>;

@Processor({
  queueName: MessageQueue.messagingQueue,
  scope: Scope.REQUEST,
})
export class BlocklistReimportMessagesJob {
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
    @InjectRepository(ConnectedAccountEntity)
    private readonly connectedAccountRepository: Repository<ConnectedAccountEntity>,
    @InjectRepository(UserWorkspaceEntity)
    private readonly userWorkspaceRepository: Repository<UserWorkspaceEntity>,
    private readonly messagingChannelSyncStatusService: MessageChannelSyncStatusService,
  ) {}

  @Process(BlocklistReimportMessagesJob.name)
  async handle(data: BlocklistReimportMessagesJobData): Promise<void> {
    const workspaceId = data.workspaceId;

    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const { workspaceScopedHandles, handlesByWorkspaceMemberId } =
          groupBlocklistHandlesByOwner(
            data.events.map((eventPayload) => eventPayload.properties.before),
          );

        if (workspaceScopedHandles.length > 0) {
          const channels = await this.findMessageChannelIdsToReset({
            workspaceId,
            connectedAccountIds: null,
          });
          await this.messagingChannelSyncStatusService.resetAndMarkAsMessagesListFetchPending(
            channels.map(({ id }) => id),
            workspaceId,
          );
          return;
        }
        for (const workspaceMemberId of handlesByWorkspaceMemberId.keys()) {
          const selection = await this.findWorkspaceMemberConnectedAccountIds({
            workspaceMemberId,
            workspaceId,
          });
          if (!selection) continue;
          const { userWorkspaceId, connectedAccountIds } = selection;
          const channels = await this.findMessageChannelIdsToReset({
            workspaceId,
            connectedAccountIds,
          });
          const byAccount = new Map<string, string[]>();
          for (const { id, connectedAccountId } of channels) {
            const ids = byAccount.get(connectedAccountId) ?? [];
            ids.push(id);
            byAccount.set(connectedAccountId, ids);
          }
          for (const [connectedAccountId, ids] of byAccount) {
            await this.messagingChannelSyncStatusService.resetAndMarkAsMessagesListFetchPending(
              ids,
              workspaceId,
              connectedAccountId,
              userWorkspaceId,
            );
          }
        }
      },
      authContext,
      { lite: true },
    );
  }

  private async findWorkspaceMemberConnectedAccountIds({
    workspaceMemberId,
    workspaceId,
  }: {
    workspaceMemberId: string;
    workspaceId: string;
  }): Promise<{
    userWorkspaceId: string;
    connectedAccountIds: string[];
  } | null> {
    const workspaceMemberRepository =
      this.workspaceOrmManager.getRepository<WorkspaceMemberWorkspaceEntity>(
        'workspaceMember',
        { shouldBypassPermissionChecks: true },
      );

    const workspaceMember = await workspaceMemberRepository.findOne({
      where: { id: workspaceMemberId },
    });

    if (!isDefined(workspaceMember)) {
      return null;
    }

    const userWorkspace = await this.userWorkspaceRepository.findOne({
      where: { userId: workspaceMember.userId, workspaceId },
    });

    if (!isDefined(userWorkspace)) {
      return null;
    }

    const connectedAccounts = await this.connectedAccountRepository.find({
      select: ['id'],
      where: { userWorkspaceId: userWorkspace.id, workspaceId },
    });

    return {
      userWorkspaceId: userWorkspace.id,
      connectedAccountIds: connectedAccounts.map(({ id }) => id),
    };
  }

  private async findMessageChannelIdsToReset({
    workspaceId,
    connectedAccountIds,
  }: {
    workspaceId: string;
    connectedAccountIds: string[] | null;
  }): Promise<Pick<MessageChannelEntity, 'id' | 'connectedAccountId'>[]> {
    const where: FindOptionsWhere<MessageChannelEntity> = {
      syncStage: Not(MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING),
      workspaceId,
    };

    if (isDefined(connectedAccountIds)) {
      where.connectedAccountId = In(connectedAccountIds);
    }

    const messageChannels = await this.messageChannelRepository.find({
      select: ['id', 'connectedAccountId'],
      where,
    });

    return messageChannels;
  }
}
