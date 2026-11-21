import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { type QueryRunner } from 'typeorm';

import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { DeferredWorkspaceMigrationActionHandlerDecorator } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/deferred-action-handlers/decorators/deferred-workspace-migration-action-handler.decorator';

export const WORKFLOW_RUN_SHARE_RECONCILIATION =
  'WORKFLOW_RUN_SHARE_RECONCILIATION';

@Injectable()
@DeferredWorkspaceMigrationActionHandlerDecorator('sync_workflowRunShares')
export class SyncWorkflowRunSharesDeferredActionHandlerService {
  readonly metadataNamesToLoad = [];

  constructor(
    @Inject(WORKFLOW_RUN_SHARE_RECONCILIATION)
    private readonly workflowRunRecordShareService: {
      syncRunsOfCoreWorkflows(args: {
        workspaceId: string;
        coreWorkflowIds: string[];
        auditOperation?: CrmAuditOperation;
      }): Promise<void>;
    },
  ) {}

  async execute({
    workspaceId,
    payload,
    queryRunner,
  }: {
    workspaceId: string;
    payload: { version: number; coreWorkflowId: string };
    queryRunner: QueryRunner;
  }): Promise<void> {
    if (queryRunner.isTransactionActive) {
      throw new Error(
        'Workflow share reconciliation requires non-transactional queryRunner',
      );
    }
    if (
      !payload ||
      payload.version !== 1 ||
      !isUUID(payload.coreWorkflowId) ||
      !isUUID(workspaceId) ||
      Object.keys(payload).some(
        (key) => !['version', 'coreWorkflowId'].includes(key),
      )
    )
      throw new Error('Workflow share reconciliation payload invalid');
    const [workspace] = await queryRunner.query(
      'SELECT "deletedAt" FROM core.workspace WHERE id=$1',
      [workspaceId],
    );
    if (!workspace || workspace.deletedAt) return;
    const [workflow] = await queryRunner.query(
      'SELECT id FROM core.workflow WHERE id=$1 AND "workspaceId"=$2',
      [payload.coreWorkflowId, workspaceId],
    );
    if (!workflow) return;
    await this.workflowRunRecordShareService.syncRunsOfCoreWorkflows({
      workspaceId,
      coreWorkflowIds: [workflow.id],
      auditOperation: {
        workspaceId,
        operationId: randomUUID(),
        actor: { kind: 'system', id: 'sync_workflow_run_shares' },
      },
    });
  }
}
