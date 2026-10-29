import {
  membershipCleanupOperation,
  systemMembershipCleanupIdentity,
  type MembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { Scope } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';

import { type ObjectRecordCreateEvent } from 'twenty-shared/database-events';
import { isDefined } from 'twenty-shared/utils';
import { Any, DataSource, In, MoreThan, Repository } from 'typeorm';

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
import { type MessageChannelMessageAssociationWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-channel-message-association.workspace-entity';
import { MessagingMessageCleanerService } from 'src/modules/messaging/message-cleaner/services/messaging-message-cleaner.service';
import { deleteOrdinaryBlocklistedMessageAssociationsWithAudit } from 'src/engine/core-modules/crm-audit/delete-ordinary-blocklisted-message-associations-with-audit';
import { type WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';

export type BlocklistItemDeleteMessagesJobData = WorkspaceEventBatch<
  ObjectRecordCreateEvent<BlocklistWorkspaceEntity>
>;

@Processor({
  queueName: MessageQueue.messagingQueue,
  scope: Scope.REQUEST,
})
export class BlocklistItemDeleteMessagesJob {
  constructor(
    private readonly threadCleanerService: MessagingMessageCleanerService,
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
    @InjectRepository(ConnectedAccountEntity)
    private readonly connectedAccountRepository: Repository<ConnectedAccountEntity>,
    @InjectRepository(UserWorkspaceEntity)
    private readonly userWorkspaceRepository: Repository<UserWorkspaceEntity>,
    @InjectDataSource()
    _dataSource: DataSource,
  ) {}

  @Process(BlocklistItemDeleteMessagesJob.name)
  async handle(data: BlocklistItemDeleteMessagesJobData): Promise<void> {
    const workspaceId = data.workspaceId;
    const blocklistItemIds = [
      ...new Set(data.events.map(({ recordId }) => recordId)),
    ];
    const identity = systemMembershipCleanupIdentity(
      workspaceId,
      BlocklistItemDeleteMessagesJob.name,
    );
    const sweepOperation = membershipCleanupOperation(workspaceId, identity)!;

    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        if (this.workspaceOrmManager.getWorkspaceId() !== workspaceId) {
          throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
        }

        const blocklistRepository =
          this.workspaceOrmManager.getRepository<BlocklistWorkspaceEntity>(
            'blocklist',
            { shouldBypassPermissionChecks: true },
          );

        const blocklist = await blocklistRepository.find({
          where: {
            id: Any(blocklistItemIds),
          },
        });

        const { workspaceScopedHandles, handlesByWorkspaceMemberId } =
          groupBlocklistHandlesByOwner(blocklist);

        // These channel IDs are discovery hints only. The owner reloads current
        // rules, custody and participant classification within each transaction.
        const channelIds = new Set<string>();
        if (workspaceScopedHandles.length > 0) {
          for (const channel of await this.findWorkspaceMessageChannels(
            workspaceId,
          ))
            channelIds.add(channel.id);
        }
        for (const workspaceMemberId of handlesByWorkspaceMemberId.keys()) {
          for (const channel of await this.findWorkspaceMemberMessageChannels({
            workspaceMemberId,
            workspaceId,
          }))
            channelIds.add(channel.id);
        }
        await this.deleteMessagesForMessageChannels({
          workspaceId,
          messageChannelIds: [...channelIds],
          blocklistItemIds,
          identity,
        });

        await this.threadCleanerService.cleanOrphanMessagesAndThreads(
          workspaceId,
          sweepOperation,
        );
      },
      authContext,
      { lite: true },
    );
  }

  private async findWorkspaceMessageChannels(
    workspaceId: string,
  ): Promise<MessageChannelEntity[]> {
    return this.messageChannelRepository.find({
      select: {
        id: true,
        handle: true,
        connectedAccount: {
          handleAliases: true,
        },
      },
      where: { workspaceId },
      relations: { connectedAccount: true },
    });
  }

  private async findWorkspaceMemberMessageChannels({
    workspaceMemberId,
    workspaceId,
  }: {
    workspaceMemberId: string;
    workspaceId: string;
  }): Promise<MessageChannelEntity[]> {
    const workspaceMemberRepository =
      this.workspaceOrmManager.getRepository<WorkspaceMemberWorkspaceEntity>(
        'workspaceMember',
        { shouldBypassPermissionChecks: true },
      );

    const workspaceMember = await workspaceMemberRepository.findOne({
      where: { id: workspaceMemberId },
    });

    if (!isDefined(workspaceMember)) {
      return [];
    }

    const userWorkspace = await this.userWorkspaceRepository.findOne({
      where: { userId: workspaceMember.userId, workspaceId },
    });

    if (!isDefined(userWorkspace)) {
      return [];
    }

    const connectedAccounts = await this.connectedAccountRepository.find({
      where: { userWorkspaceId: userWorkspace.id, workspaceId },
    });

    if (connectedAccounts.length === 0) {
      return [];
    }

    return this.messageChannelRepository.find({
      select: {
        id: true,
        handle: true,
        connectedAccount: {
          handleAliases: true,
        },
      },
      where: {
        connectedAccountId: In(
          connectedAccounts.map((connectedAccount) => connectedAccount.id),
        ),
        workspaceId,
      },
      relations: { connectedAccount: true },
    });
  }

  private async deleteMessagesForMessageChannels({
    workspaceId,
    messageChannelIds,
    blocklistItemIds,
    identity,
  }: {
    workspaceId: string;
    messageChannelIds: readonly string[];
    blocklistItemIds: readonly string[];
    identity: MembershipCleanupIdentity;
  }): Promise<void> {
    const repository =
      this.workspaceOrmManager.getRepository<MessageChannelMessageAssociationWorkspaceEntity>(
        'messageChannelMessageAssociation',
        { shouldBypassPermissionChecks: true },
      );
    const pageSize = 200;
    for (const messageChannelId of messageChannelIds) {
      for (
        let offset = 0;
        offset < blocklistItemIds.length;
        offset += pageSize
      ) {
        const ruleIds = blocklistItemIds.slice(offset, offset + pageSize);
        let cursor: string | undefined;
        for (;;) {
          // Do not classify by stale handles here: every live candidate reaches
          // the closed owner, including nonmatching and protected first pages.
          const rows = await repository.find({
            where: {
              messageChannelId,
              ...(cursor ? { id: MoreThan(cursor) } : {}),
            },
            select: { id: true },
            order: { id: 'ASC' },
            take: pageSize,
          });
          const candidateAssociationIds = rows.map((row) => row.id);
          const operation = membershipCleanupOperation(workspaceId, identity)!;
          const result =
            await this.workspaceOrmManager.runInWorkspaceTransaction(
              (scope) => {
                if (scope.workspaceId !== workspaceId)
                  throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
                return deleteOrdinaryBlocklistedMessageAssociationsWithAudit({
                  scope,
                  operation,
                  messageChannelId,
                  blocklistItemIds: ruleIds,
                  candidateAssociationIds,
                });
              },
              { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
            );
          // No catch: unsafe outcomes keep their original instance and prevent
          // subsequent pages, rule chunks, channels and the separate sweep.
          if (result === null || rows.length < pageSize) break;
          cursor = rows[rows.length - 1].id;
        }
      }
    }
  }
}
