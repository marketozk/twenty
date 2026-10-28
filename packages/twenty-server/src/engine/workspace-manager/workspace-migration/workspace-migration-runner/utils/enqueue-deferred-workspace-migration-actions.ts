import { type MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/constants/deferred-workspace-migration-action-max-attempts.constant';
import { DEFERRED_WORKSPACE_MIGRATION_ACTION_RETRY_BACKOFF } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/constants/deferred-workspace-migration-action-retry-backoff.constant';
import { RUN_DEFERRED_WORKSPACE_MIGRATION_ACTIONS_JOB_NAME } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/constants/run-deferred-workspace-migration-actions-job-name.constant';

export const enqueueDeferredWorkspaceMigrationActions = async (
  queue: Pick<MessageQueueService, 'add'>,
  workspaceId: string,
  reportError: (message: string) => void,
): Promise<void> => {
  try {
    await queue.add(
      RUN_DEFERRED_WORKSPACE_MIGRATION_ACTIONS_JOB_NAME,
      { workspaceId },
      {
        deduplication: {
          id: `deferred-workspace-migration-actions:${workspaceId}`,
          keepLastIfActive: true,
        },
        retryLimit: DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS - 1,
        backoff: DEFERRED_WORKSPACE_MIGRATION_ACTION_RETRY_BACKOFF,
      },
    );
  } catch (error) {
    reportError(
      `Failed to enqueue deferred workspace migration actions for workspace ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
