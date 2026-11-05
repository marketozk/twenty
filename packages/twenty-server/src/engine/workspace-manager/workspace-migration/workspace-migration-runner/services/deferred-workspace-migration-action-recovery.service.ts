import { Injectable } from '@nestjs/common';

import { isDefined } from 'twenty-shared/utils';
import { LessThan } from 'typeorm';

import { DeferredWorkspaceMigrationActionEntity } from 'src/engine/metadata-modules/deferred-workspace-migration-action/deferred-workspace-migration-action.entity';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/constants/deferred-workspace-migration-action-max-attempts.constant';
import { DEFERRED_WORKSPACE_MIGRATION_ACTION_STALE_THRESHOLD_MS } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/constants/deferred-workspace-migration-action-stale-threshold-ms.constant';
import { DeferredWorkspaceMigrationActionRunnerService } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-runner.service';
import { type DeferredWorkspaceMigrationActionStatus } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/types/deferred-workspace-migration-action-status.type';

@Injectable()
export class DeferredWorkspaceMigrationActionRecoveryService {
  constructor(
    @InjectWorkspaceScopedRepository(DeferredWorkspaceMigrationActionEntity)
    private readonly deferredWorkspaceMigrationActionRepository: WorkspaceScopedRepository<DeferredWorkspaceMigrationActionEntity>,
    private readonly deferredWorkspaceMigrationActionRunnerService: DeferredWorkspaceMigrationActionRunnerService,
  ) {}

  async resetStaleInProgressActions(): Promise<number> {
    const staleBefore = new Date(
      Date.now() - DEFERRED_WORKSPACE_MIGRATION_ACTION_STALE_THRESHOLD_MS,
    );
    const lastError = 'Worker stopped while the action was in progress';

    const failedResult = await this.deferredWorkspaceMigrationActionRepository
      .createQueryBuilder()
      .update()
      .set({ status: 'FAILED', startedAt: null, lastError })
      .where({
        status: 'IN_PROGRESS',
        startedAt: LessThan(staleBefore),
      })
      .andWhere('(attempts >= :maxAttempts OR (payload ? :unsafeOutcomeKey))', {
        maxAttempts: DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS,
        unsafeOutcomeKey: 'unsafeOutcome',
      })
      .execute();

    const pendingResult = await this.deferredWorkspaceMigrationActionRepository
      .createQueryBuilder()
      .update()
      .set({ status: 'PENDING', startedAt: null, lastError })
      .where({
        status: 'IN_PROGRESS',
        startedAt: LessThan(staleBefore),
      })
      .andWhere('NOT (payload ? :unsafeOutcomeKey)', {
        unsafeOutcomeKey: 'unsafeOutcome',
      })
      .execute();

    return (failedResult.affected ?? 0) + (pendingResult.affected ?? 0);
  }

  async enqueueWorkspacesWithPendingActions(): Promise<number> {
    const workspaceIds = await this.findWorkspaceIdsByStatus('PENDING');

    for (const workspaceId of workspaceIds) {
      await this.deferredWorkspaceMigrationActionRunnerService.enqueue(
        workspaceId,
      );
    }

    return workspaceIds.length;
  }

  async retryFailedActions(workspaceId?: string): Promise<number> {
    const workspaceIds = isDefined(workspaceId)
      ? [workspaceId]
      : await this.findWorkspaceIdsByStatus('FAILED');

    let retriedActionCount = 0;

    for (const workspaceIdToRetry of workspaceIds) {
      const { affected } = await this.deferredWorkspaceMigrationActionRepository
        .createQueryBuilder()
        .update()
        .set({ status: 'PENDING', attempts: 0, startedAt: null })
        .where({
          workspaceId: workspaceIdToRetry,
          status: 'FAILED',
        })
        .andWhere('NOT (payload ? :unsafeOutcomeKey)', {
          unsafeOutcomeKey: 'unsafeOutcome',
        })
        .execute();

      if ((affected ?? 0) > 0) {
        retriedActionCount += affected ?? 0;
        await this.deferredWorkspaceMigrationActionRunnerService.enqueue(
          workspaceIdToRetry,
        );
      }
    }

    return retriedActionCount;
  }

  private async findWorkspaceIdsByStatus(
    status: DeferredWorkspaceMigrationActionStatus,
  ): Promise<string[]> {
    const rows = await this.deferredWorkspaceMigrationActionRepository
      .createQueryBuilder('deferredWorkspaceMigrationAction')
      .select('deferredWorkspaceMigrationAction.workspaceId', 'workspaceId')
      .distinct(true)
      .where('deferredWorkspaceMigrationAction.status = :status', { status })
      .andWhere(
        'NOT (deferredWorkspaceMigrationAction.payload ? :unsafeOutcomeKey)',
        { unsafeOutcomeKey: 'unsafeOutcome' },
      )
      .getRawMany<{ workspaceId: string }>();

    return rows.map(({ workspaceId }) => workspaceId);
  }
}
