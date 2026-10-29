import {
  membershipCleanupOperation,
  systemMembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { Scope } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { type CalendarEventParticipantWorkspaceEntity } from 'src/modules/calendar/common/standard-objects/calendar-event-participant.workspace-entity';
import {
  MatchParticipantService,
  type CalendarParticipantRematchSelector,
} from 'src/modules/match-participant/match-participant.service';

export type CalendarEventParticipantMatchParticipantJobData = {
  workspaceId: string;
  participantMatching: {
    personEmails: string[];
    workspaceMemberIds: string[];
  };
};

@Processor({
  queueName: MessageQueue.calendarQueue,
  scope: Scope.REQUEST,
})
export class CalendarEventParticipantMatchParticipantJob {
  constructor(
    @InjectRepository(WorkspaceEntity)
    private readonly workspaceRepository: Repository<WorkspaceEntity>,
    private readonly matchParticipantService: MatchParticipantService<CalendarEventParticipantWorkspaceEntity>,
  ) {}

  @Process(CalendarEventParticipantMatchParticipantJob.name)
  async handle(
    data: CalendarEventParticipantMatchParticipantJobData,
  ): Promise<void> {
    const workspaceId = data.workspaceId;
    const participantMatching = {
      personEmails: [...data.participantMatching.personEmails],
      workspaceMemberIds: [...data.participantMatching.workspaceMemberIds],
    };
    const identity = systemMembershipCleanupIdentity(
      workspaceId,
      CalendarEventParticipantMatchParticipantJob.name,
    );
    const operation = membershipCleanupOperation(workspaceId, identity)!;

    const workspace = await this.workspaceRepository.findOne({
      where: {
        id: workspaceId,
      },
    });

    if (workspace?.activationStatus !== 'ACTIVE') {
      return;
    }

    const selectors: CalendarParticipantRematchSelector[] = [];
    if (participantMatching.personEmails.length)
      selectors.push({
        kind: 'personOnly',
        personEmails: participantMatching.personEmails,
      });
    if (participantMatching.workspaceMemberIds.length)
      selectors.push({
        kind: 'workspaceMemberOnly',
        workspaceMemberIds: participantMatching.workspaceMemberIds,
      });
    for (const selector of selectors) {
      let afterParticipantId: string | undefined;
      do {
        const { nextCursor } =
          await this.matchParticipantService.rematchCalendarParticipantsWithAudit(
            {
              workspaceId,
              operation,
              selector,
              afterParticipantId,
            },
          );
        afterParticipantId = nextCursor ?? undefined;
      } while (afterParticipantId !== undefined);
    }
  }
}
