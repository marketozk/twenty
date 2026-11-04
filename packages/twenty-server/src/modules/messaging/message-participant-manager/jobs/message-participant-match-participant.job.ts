import { Scope } from '@nestjs/common';
import { captureMessageParticipantRematchSelector } from 'src/engine/core-modules/crm-audit/message-participant-rematch-selector';
import {
  membershipCleanupOperation,
  systemMembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';

import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MatchParticipantService } from 'src/modules/match-participant/match-participant.service';
import { type MessageParticipantWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-participant.workspace-entity';

export type MessageParticipantMatchParticipantJobData = {
  workspaceId: string;
  participantMatching: {
    personEmails: string[];
    workspaceMemberIds: string[];
  };
};

@Processor({
  queueName: MessageQueue.messagingQueue,
  scope: Scope.REQUEST,
})
export class MessageParticipantMatchParticipantJob {
  constructor(
    private readonly matchParticipantService: MatchParticipantService<MessageParticipantWorkspaceEntity>,
  ) {}

  @Process(MessageParticipantMatchParticipantJob.name)
  async handle(data: MessageParticipantMatchParticipantJobData): Promise<void> {
    const workspaceId = data.workspaceId;
    const personSelector = captureMessageParticipantRematchSelector({
      kind: 'personOnly',
      personEmails: data.participantMatching.personEmails,
    });
    const memberSelector = captureMessageParticipantRematchSelector({
      kind: 'workspaceMemberOnly',
      workspaceMemberIds: data.participantMatching.workspaceMemberIds,
    });
    const identity = systemMembershipCleanupIdentity(
      workspaceId,
      MessageParticipantMatchParticipantJob.name,
    );
    for (const selector of [personSelector, memberSelector]) {
      const values =
        selector.kind === 'personOnly'
          ? selector.personEmails
          : selector.workspaceMemberIds;
      if (!values.length) continue;
      let afterParticipantId: string | undefined;
      do {
        const { nextCursor } =
          await this.matchParticipantService.rematchMessageParticipantsWithAudit(
            {
              workspaceId,
              operation: membershipCleanupOperation(workspaceId, identity)!,
              selector,
              afterParticipantId,
            },
          );
        afterParticipantId = nextCursor ?? undefined;
      } while (afterParticipantId !== undefined);
    }
  }
}
