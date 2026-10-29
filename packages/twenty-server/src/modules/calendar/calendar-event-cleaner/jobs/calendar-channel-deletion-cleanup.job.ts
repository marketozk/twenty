import {
  membershipCleanupOperation,
  systemMembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { Logger, Scope } from '@nestjs/common';

import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { CalendarEventCleanerService } from 'src/modules/calendar/calendar-event-cleaner/services/calendar-event-cleaner.service';

export type CalendarChannelDeletionCleanupJobData = {
  workspaceId: string;
  calendarChannelId: string;
};

@Processor({
  queueName: MessageQueue.calendarQueue,
  scope: Scope.REQUEST,
})
export class CalendarChannelDeletionCleanupJob {
  private readonly logger = new Logger(CalendarChannelDeletionCleanupJob.name);

  constructor(
    private readonly calendarEventCleanerService: CalendarEventCleanerService,
  ) {}

  @Process(CalendarChannelDeletionCleanupJob.name)
  async handle(data: CalendarChannelDeletionCleanupJobData): Promise<void> {
    const workspaceId = data.workspaceId;
    const calendarChannelId = data.calendarChannelId;
    const identity = systemMembershipCleanupIdentity(
      workspaceId,
      CalendarChannelDeletionCleanupJob.name,
    );
    const auditOperation = membershipCleanupOperation(workspaceId, identity)!;
    const sweepAuditOperation = membershipCleanupOperation(
      workspaceId,
      identity,
    )!;
    this.logger.debug(
      `WorkspaceId: ${workspaceId} Cleaning up calendar channel event associations for channel ${calendarChannelId}`,
    );

    await this.calendarEventCleanerService.deleteCalendarChannelEventAssociationsByChannelId(
      {
        workspaceId,
        calendarChannelId,
        auditOperation,
      },
    );

    // The audited orphan sweep remains a separate transaction; the two stages share correlation, not atomicity.
    // Any association-owner failure propagates before reaching it.
    await this.calendarEventCleanerService.cleanWorkspaceCalendarEvents(
      workspaceId,
      sweepAuditOperation,
    );
  }
}
