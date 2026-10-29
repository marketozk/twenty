import {
  membershipCleanupOperation,
  systemMembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { Command } from 'nest-commander';

import { ProvisionedWorkspaceCommandRunner } from 'src/database/commands/command-runners/provisioned-workspace.command-runner';
import { WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { type RunOnWorkspaceArgs } from 'src/database/commands/command-runners/workspace.command-runner';
import { MessagingMessageCleanerService } from 'src/modules/messaging/message-cleaner/services/messaging-message-cleaner.service';

@Command({
  name: 'messaging:message-cleaner-remove-orphans',
  description: 'Remove orphan message and threads from messaging',
})
export class MessagingMessageCleanerRemoveOrphansCommand extends ProvisionedWorkspaceCommandRunner {
  constructor(
    protected readonly workspaceIteratorService: WorkspaceIteratorService,
    private readonly messagingMessageCleanerService: MessagingMessageCleanerService,
  ) {
    super(workspaceIteratorService);
  }

  override async runOnWorkspace({
    workspaceId,
    options,
  }: RunOnWorkspaceArgs): Promise<void> {
    if (options.dryRun) return;
    const auditOperation = membershipCleanupOperation(
      workspaceId,
      systemMembershipCleanupIdentity(
        workspaceId,
        MessagingMessageCleanerRemoveOrphansCommand.name,
      ),
    )!;
    await this.messagingMessageCleanerService.cleanOrphanMessagesAndThreads(
      workspaceId,
      auditOperation,
    );
  }
}
