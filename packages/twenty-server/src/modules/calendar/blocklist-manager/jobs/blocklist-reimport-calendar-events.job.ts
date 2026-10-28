import { Scope } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { type ObjectRecordDeleteEvent } from 'twenty-shared/database-events';
import { CalendarChannelSyncStage } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { type FindOptionsWhere, Not, type Repository } from 'typeorm';

import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';
import { type BlocklistWorkspaceEntity } from 'src/modules/blocklist/standard-objects/blocklist.workspace-entity';
import { groupBlocklistHandlesByOwner } from 'src/modules/blocklist/utils/group-blocklist-handles-by-owner.util';
import { CalendarChannelSyncStatusService } from 'src/modules/calendar/common/services/calendar-channel-sync-status.service';
import { type WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';

export type BlocklistReimportCalendarEventsJobData = WorkspaceEventBatch<
  ObjectRecordDeleteEvent<BlocklistWorkspaceEntity>
>;

@Processor({
  queueName: MessageQueue.calendarQueue,
  scope: Scope.REQUEST,
})
export class BlocklistReimportCalendarEventsJob {
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    @InjectRepository(CalendarChannelEntity)
    private readonly calendarChannelRepository: Repository<CalendarChannelEntity>,
    @InjectRepository(UserWorkspaceEntity)
    private readonly userWorkspaceRepository: Repository<UserWorkspaceEntity>,
    private readonly calendarChannelSyncStatusService: CalendarChannelSyncStatusService,
  ) {}

  @Process(BlocklistReimportCalendarEventsJob.name)
  async handle(data: BlocklistReimportCalendarEventsJobData): Promise<void> {
    const workspaceId = data.workspaceId;

    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const { workspaceScopedHandles, handlesByWorkspaceMemberId } =
          groupBlocklistHandlesByOwner(
            data.events.map((eventPayload) => eventPayload.properties.before),
          );

        if (workspaceScopedHandles.length > 0) {
          const channels = await this.findCalendarChannelIdsToReset({
            workspaceId,
            userWorkspaceId: null,
          });
          await this.calendarChannelSyncStatusService.resetAndMarkAsCalendarEventListFetchPending(
            channels.map(({ id }) => id),
            workspaceId,
          );
          return;
        }
        for (const workspaceMemberId of handlesByWorkspaceMemberId.keys()) {
          const userWorkspaceId = await this.findWorkspaceMemberUserWorkspaceId(
            { workspaceMemberId, workspaceId },
          );
          if (!isDefined(userWorkspaceId)) continue;
          const channels = await this.findCalendarChannelIdsToReset({
            workspaceId,
            userWorkspaceId,
          });
          const byAccount = new Map<string, string[]>();
          for (const { id, connectedAccountId } of channels) {
            const ids = byAccount.get(connectedAccountId) ?? [];
            ids.push(id);
            byAccount.set(connectedAccountId, ids);
          }
          for (const [connectedAccountId, ids] of byAccount) {
            await this.calendarChannelSyncStatusService.resetAndMarkAsCalendarEventListFetchPending(
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

  private async findWorkspaceMemberUserWorkspaceId({
    workspaceMemberId,
    workspaceId,
  }: {
    workspaceMemberId: string;
    workspaceId: string;
  }): Promise<string | null> {
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
      select: ['id'],
    });

    return userWorkspace?.id ?? null;
  }

  private async findCalendarChannelIdsToReset({
    workspaceId,
    userWorkspaceId,
  }: {
    workspaceId: string;
    userWorkspaceId: string | null;
  }): Promise<Pick<CalendarChannelEntity, 'id' | 'connectedAccountId'>[]> {
    const where: FindOptionsWhere<CalendarChannelEntity> = {
      syncStage: Not(
        CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
      ),
      workspaceId,
    };

    if (isDefined(userWorkspaceId)) {
      where.connectedAccount = { userWorkspaceId };
    }

    const calendarChannels = await this.calendarChannelRepository.find({
      select: ['id', 'connectedAccountId'],
      where,
    });

    return calendarChannels;
  }
}
