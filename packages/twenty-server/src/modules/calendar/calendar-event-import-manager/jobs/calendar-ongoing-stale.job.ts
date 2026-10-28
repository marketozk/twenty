import { Logger, Scope } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { In, Repository } from 'typeorm';

import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { CALENDAR_ONGOING_STALE_SYNC_STAGES } from 'src/modules/calendar/calendar-event-import-manager/constants/calendar-ongoing-stale-sync-stages.constant';
import { CalendarChannelSyncStatusService } from 'src/modules/calendar/common/services/calendar-channel-sync-status.service';

export type CalendarOngoingStaleJobData = {
  workspaceId: string;
};

@Processor({
  queueName: MessageQueue.calendarQueue,
  scope: Scope.REQUEST,
})
export class CalendarOngoingStaleJob {
  private readonly logger = new Logger(CalendarOngoingStaleJob.name);
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    @InjectRepository(CalendarChannelEntity)
    private readonly calendarChannelRepository: Repository<CalendarChannelEntity>,
    private readonly calendarChannelSyncStatusService: CalendarChannelSyncStatusService,
  ) {}

  @Process(CalendarOngoingStaleJob.name)
  async handle(data: CalendarOngoingStaleJobData): Promise<void> {
    const { workspaceId } = data;

    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const calendarChannels = await this.calendarChannelRepository.find({
          where: {
            syncStage: In(CALENDAR_ONGOING_STALE_SYNC_STAGES),
            workspaceId,
          },
        });

        const accepted =
          await this.calendarChannelSyncStatusService.requeueStaleChannels(
            calendarChannels.map(({ id }) => id),
            workspaceId,
          );
        if (accepted.length)
          this.logger.log(
            `Requeued ${accepted.length} stale calendar channels in workspace ${workspaceId}`,
          );
      },
      authContext,
      { lite: true },
    );
  }
}
