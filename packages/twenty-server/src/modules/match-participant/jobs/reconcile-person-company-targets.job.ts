import {
  membershipCleanupOperation,
  systemMembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { Scope } from '@nestjs/common';

import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { ParticipantTargetReconciliationService } from 'src/modules/match-participant/participant-target-reconciliation.service';

export type ReconcilePersonCompanyTargetsJobData = {
  workspaceId: string;
  personIds: string[];
};

@Processor({ queueName: MessageQueue.messagingQueue, scope: Scope.REQUEST })
export class ReconcilePersonCompanyTargetsJob {
  constructor(
    private readonly participantTargetReconciliationService: ParticipantTargetReconciliationService,
  ) {}

  @Process(ReconcilePersonCompanyTargetsJob.name)
  async handle(data: ReconcilePersonCompanyTargetsJobData): Promise<void> {
    const workspaceId = data.workspaceId;
    const personIds = [...data.personIds];
    const identity = systemMembershipCleanupIdentity(
      workspaceId,
      ReconcilePersonCompanyTargetsJob.name,
    );
    const operation = membershipCleanupOperation(workspaceId, identity)!;
    await this.participantTargetReconciliationService.reconcileTargetsForPeople(
      { workspaceId, personIds, operation },
    );
  }
}
