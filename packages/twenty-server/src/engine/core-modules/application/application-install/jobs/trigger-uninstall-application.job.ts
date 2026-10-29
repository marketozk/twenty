import { ApplicationUninstallRunnerService } from 'src/engine/core-modules/application/application-install/services/application-uninstall-runner.service';
import { withCrmAuditIdentity } from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { type MembershipCleanupIdentity } from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { type MessageQueueJobProgressContext } from 'src/engine/core-modules/message-queue/interfaces/message-queue-job.interface';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';

export type TriggerUninstallApplicationJobData = {
  auditIdentity?: MembershipCleanupIdentity;
  universalIdentifier: string;
  workspaceId: string;
};

@Processor(MessageQueue.workspaceQueue)
export class TriggerUninstallApplicationJob {
  constructor(
    private readonly applicationUninstallRunnerService: ApplicationUninstallRunnerService,
  ) {}

  @Process(TriggerUninstallApplicationJob.name)
  async handle(
    data: TriggerUninstallApplicationJobData,
    { updateProgress }: MessageQueueJobProgressContext,
  ): Promise<void> {
    await withCrmAuditIdentity(data.workspaceId, data.auditIdentity, () =>
      this.applicationUninstallRunnerService.uninstallApplication({
        workspaceId: data.workspaceId,
        universalIdentifier: data.universalIdentifier,
        updateProgress,
      }),
    );
  }
}
