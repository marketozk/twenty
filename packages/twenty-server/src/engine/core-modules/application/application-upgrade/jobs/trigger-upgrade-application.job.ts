import { ApplicationUpgradeService } from 'src/engine/core-modules/application/application-upgrade/application-upgrade.service';
import { withCrmAuditIdentity } from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { type MembershipCleanupIdentity } from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { type MessageQueueJobProgressContext } from 'src/engine/core-modules/message-queue/interfaces/message-queue-job.interface';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';

export type TriggerUpgradeApplicationJobData = {
  auditIdentity?: MembershipCleanupIdentity;
  applicationRegistrationId: string;
  targetVersion: string;
  workspaceId: string;
};

@Processor(MessageQueue.workspaceQueue)
export class TriggerUpgradeApplicationJob {
  constructor(
    private readonly applicationUpgradeService: ApplicationUpgradeService,
  ) {}

  @Process(TriggerUpgradeApplicationJob.name)
  async handle(
    data: TriggerUpgradeApplicationJobData,
    { updateProgress }: MessageQueueJobProgressContext,
  ): Promise<void> {
    await withCrmAuditIdentity(data.workspaceId, data.auditIdentity, () =>
      this.applicationUpgradeService.upgradeApplication({
        appRegistrationId: data.applicationRegistrationId,
        targetVersion: data.targetVersion,
        workspaceId: data.workspaceId,
        updateProgress,
      }),
    );
  }
}
