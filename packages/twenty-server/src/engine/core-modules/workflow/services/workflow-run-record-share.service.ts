import { Injectable } from '@nestjs/common';

import chunk from 'lodash.chunk';

import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import {
  WorkflowVisibility,
} from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { type FindOptionsWhere, In } from 'typeorm';

import { CacheLockService } from 'src/engine/core-modules/cache-lock/cache-lock.service';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  runAuditedWorkflowRunShareSync,
  validateWorkflowRunShareSyncAuditInput,
} from 'src/engine/core-modules/crm-audit/record-share-audit';
import { RecordShareStorageService } from 'src/engine/core-modules/record-share/services/record-share-storage.service';
import { WorkflowEntity } from 'src/engine/core-modules/workflow/entities/workflow.entity';
import { buildWorkflowRunRecordShares } from 'src/engine/core-modules/workflow/utils/build-workflow-run-record-shares.util';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { type WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { type WorkflowRunWorkspaceEntity } from 'src/modules/workflow/common/standard-objects/workflow-run.workspace-entity';

// Keeps each grant write well under Postgres' bind parameter limit.
const WORKFLOW_RUN_BATCH_SIZE = 500;
const DELETE_ID_CHUNK_SIZE = 1000;

// A whole workflow's runs can take longer than the default lock lifetime.
const CORE_WORKFLOW_LOCK_OPTIONS = { ttl: 30_000, maxRetries: 300 };

type CoreWorkflowAccess = {
  isWorkspaceVisible: boolean;
  creatorWorkspaceMemberId: string | null;
};

type WorkflowRunShareAuditArgs = {
  auditOperation?: CrmAuditOperation;
  auditImpersonatorUserWorkspaceId?: string;
};

// runs carry their workflow's data, so their grants are derived from it and replaced wholesale to revoke what the old state granted
@Injectable()
export class WorkflowRunRecordShareService {
  constructor(
    @InjectWorkspaceScopedRepository(WorkflowEntity)
    private readonly coreWorkflowRepository: WorkspaceScopedRepository<WorkflowEntity>,
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly recordShareStorageService: RecordShareStorageService,
    private readonly cacheLockService: CacheLockService,
  ) {}

  // lock held across both steps so a run created meanwhile is not granted from the replaced state
  async updateAccessThenSyncRuns<TResult>({
    workspaceId,
    coreWorkflowId,
    updateAccess,
    auditOperation,
    auditImpersonatorUserWorkspaceId,
  }: {
    workspaceId: string;
    coreWorkflowId: string;
    updateAccess: () => Promise<TResult>;
  } & WorkflowRunShareAuditArgs): Promise<TResult> {
    const validatedAudit = validateWorkflowRunShareSyncAuditInput({
      workspaceId,
      auditOperation,
      auditImpersonatorUserWorkspaceId,
    });

    return this.withCoreWorkflowLock(
      { workspaceId: validatedAudit.workspaceId, coreWorkflowId },
      async () => {
        const result = await updateAccess();

        await this.replaceSharesOfAllRuns({
          workspaceId: validatedAudit.workspaceId,
          coreWorkflowId,
          auditOperation: validatedAudit.capturedOperation,
          auditImpersonatorUserWorkspaceId:
            validatedAudit.impersonatorUserWorkspaceId,
        });

        return result;
      },
    );
  }

  async syncRunsOfCoreWorkflows({
    workspaceId,
    coreWorkflowIds,
    auditOperation,
    auditImpersonatorUserWorkspaceId,
  }: {
    workspaceId: string;
    coreWorkflowIds: string[];
  } & WorkflowRunShareAuditArgs): Promise<void> {
    const validatedAudit = validateWorkflowRunShareSyncAuditInput({
      workspaceId,
      auditOperation,
      auditImpersonatorUserWorkspaceId,
    });

    for (const coreWorkflowId of new Set(coreWorkflowIds)) {
      await this.withCoreWorkflowLock(
        { workspaceId: validatedAudit.workspaceId, coreWorkflowId },
        () =>
          this.replaceSharesOfAllRuns({
            workspaceId: validatedAudit.workspaceId,
            coreWorkflowId,
            auditOperation: validatedAudit.capturedOperation,
            auditImpersonatorUserWorkspaceId:
              validatedAudit.impersonatorUserWorkspaceId,
          }),
      );
    }
  }

  async syncRuns({
    workspaceId,
    workflowRunIds,
    auditOperation,
    auditImpersonatorUserWorkspaceId,
  }: {
    workspaceId: string;
    workflowRunIds: string[];
  } & WorkflowRunShareAuditArgs): Promise<void> {
    const validatedAudit = validateWorkflowRunShareSyncAuditInput({
      workspaceId,
      auditOperation,
      auditImpersonatorUserWorkspaceId,
    });
    if (workflowRunIds.length === 0) {
      return;
    }

    const runs = await this.findRuns({
      workspaceId: validatedAudit.workspaceId,
      where: { id: In(workflowRunIds) },
    });
    const runIdsByCoreWorkflowId = new Map<string | null, string[]>();

    for (const run of runs) {
      runIdsByCoreWorkflowId.set(run.coreWorkflowId, [
        ...(runIdsByCoreWorkflowId.get(run.coreWorkflowId) ?? []),
        run.id,
      ]);
    }

    for (const [coreWorkflowId, runIds] of runIdsByCoreWorkflowId) {
      if (!isDefined(coreWorkflowId)) {
        await this.replaceShares({
          workspaceId: validatedAudit.workspaceId,
          workflowRunIds: runIds,
          access: { isWorkspaceVisible: true, creatorWorkspaceMemberId: null },
          auditOperation: validatedAudit.capturedOperation,
          auditImpersonatorUserWorkspaceId:
            validatedAudit.impersonatorUserWorkspaceId,
        });
        continue;
      }

      await this.withCoreWorkflowLock(
        { workspaceId: validatedAudit.workspaceId, coreWorkflowId },
        async () =>
          this.replaceShares({
            workspaceId: validatedAudit.workspaceId,
            workflowRunIds: runIds,
            access: await this.resolveAccess({
              workspaceId: validatedAudit.workspaceId,
              coreWorkflowId,
            }),
            auditOperation: validatedAudit.capturedOperation,
            auditImpersonatorUserWorkspaceId:
              validatedAudit.impersonatorUserWorkspaceId,
          }),
      );
    }
  }

  async findCoreWorkflowIdsCreatedBy({
    workspaceId,
    userWorkspaceId,
  }: {
    workspaceId: string;
    userWorkspaceId: string;
  }): Promise<string[]> {
    const coreWorkflows = await this.coreWorkflowRepository.find(workspaceId, {
      where: { createdByUserWorkspaceId: userWorkspaceId },
      select: { id: true },
      withDeleted: true,
    });

    return coreWorkflows.map(({ id }) => id);
  }

  private async replaceSharesOfAllRuns({
    workspaceId,
    coreWorkflowId,
    auditOperation,
    auditImpersonatorUserWorkspaceId,
  }: {
    workspaceId: string;
    coreWorkflowId: string;
  } & WorkflowRunShareAuditArgs): Promise<void> {
    const runs = await this.findRuns({
      workspaceId,
      where: { coreWorkflowId },
    });

    await this.replaceShares({
      workspaceId,
      workflowRunIds: runs.map(({ id }) => id),
      access: await this.resolveAccess({ workspaceId, coreWorkflowId }),
      auditOperation,
      auditImpersonatorUserWorkspaceId,
    });
  }

  private async replaceShares({
    workspaceId,
    workflowRunIds,
    access,
    auditOperation,
    auditImpersonatorUserWorkspaceId,
  }: {
    workspaceId: string;
    workflowRunIds: string[];
    access: CoreWorkflowAccess;
  } & WorkflowRunShareAuditArgs): Promise<void> {
    const normalizedRunIds = [
      ...new Set(workflowRunIds.map((id) => id.toLowerCase())),
    ].sort();
    if (normalizedRunIds.length === 0) {
      return;
    }

    const { flatObjectMetadataMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatObjectMetadataMaps',
      ]);
    const objectMetadataId =
      flatObjectMetadataMaps.byUniversalIdentifier[
        STANDARD_OBJECTS.workflowRun.universalIdentifier
      ]?.id?.toLowerCase();

    if (!isDefined(objectMetadataId)) {
      return;
    }

    const normalizedAccess: CoreWorkflowAccess = {
      isWorkspaceVisible: access.isWorkspaceVisible,
      creatorWorkspaceMemberId: isDefined(access.creatorWorkspaceMemberId)
        ? access.creatorWorkspaceMemberId.toLowerCase()
        : null,
    };

    for (
      let offset = 0;
      offset < normalizedRunIds.length;
      offset += WORKFLOW_RUN_BATCH_SIZE
    ) {
      const batch = normalizedRunIds.slice(
        offset,
        offset + WORKFLOW_RUN_BATCH_SIZE,
      );
      const desiredShares = buildWorkflowRunRecordShares({
        objectMetadataId,
        workflowRunIds: batch,
        ...normalizedAccess,
      });

      await this.workspaceOrmManager.executeInWorkspaceContext(
        () =>
          this.workspaceOrmManager.runInWorkspaceTransaction(
            async (transactionScope) => {
              await runAuditedWorkflowRunShareSync({
                scope: transactionScope,
                workspaceId,
                objectMetadataId,
                workflowRunIds: batch,
                desiredShares,
                auditOperation,
                auditImpersonatorUserWorkspaceId,
                execute: async ({ idsToDelete, sharesToInsert }) => {
                  for (const idChunk of chunk(
                    idsToDelete,
                    DELETE_ID_CHUNK_SIZE,
                  )) {
                    await this.recordShareStorageService.deleteMatching({
                      workspaceId,
                      transactionScope,
                      criteria: [{ id: In(idChunk) }],
                    });
                  }
                  if (sharesToInsert.length > 0) {
                    await this.recordShareStorageService.insertMany({
                      workspaceId,
                      transactionScope,
                      recordShares: sharesToInsert as Parameters<
                        RecordShareStorageService['insertMany']
                      >[0]['recordShares'],
                    });
                  }
                },
              });
            },
            { commitOutcome: 'strict' },
          ),
        buildSystemAuthContext(workspaceId),
      );
    }
  }

  // a run's conversation goes to this member's inbox, until a workflow can name a team inbox
  async findCreatorWorkspaceMemberId({
    workspaceId,
    coreWorkflowId,
  }: {
    workspaceId: string;
    coreWorkflowId: string;
  }): Promise<string | null> {
    const coreWorkflow = await this.coreWorkflowRepository.findOne(
      workspaceId,
      {
        where: { id: coreWorkflowId },
        select: { id: true, createdByUserWorkspaceId: true },
        withDeleted: true,
      },
    );

    return isDefined(coreWorkflow?.createdByUserWorkspaceId)
      ? this.resolveWorkspaceMemberId({
          workspaceId,
          userWorkspaceId: coreWorkflow.createdByUserWorkspaceId,
        })
      : null;
  }

  private async resolveAccess({
    workspaceId,
    coreWorkflowId,
  }: {
    workspaceId: string;
    coreWorkflowId: string;
  }): Promise<CoreWorkflowAccess> {
    const coreWorkflow = await this.coreWorkflowRepository.findOne(
      workspaceId,
      {
        where: { id: coreWorkflowId },
        select: { id: true, visibility: true, createdByUserWorkspaceId: true },
        withDeleted: true,
      },
    );

    if (!isDefined(coreWorkflow)) {
      return { isWorkspaceVisible: true, creatorWorkspaceMemberId: null };
    }

    return {
      isWorkspaceVisible:
        coreWorkflow.visibility === WorkflowVisibility.WORKSPACE ||
        !isDefined(coreWorkflow.createdByUserWorkspaceId),
      creatorWorkspaceMemberId: isDefined(coreWorkflow.createdByUserWorkspaceId)
        ? await this.resolveWorkspaceMemberId({
            workspaceId,
            userWorkspaceId: coreWorkflow.createdByUserWorkspaceId,
          })
        : null,
    };
  }

  private async resolveWorkspaceMemberId({
    workspaceId,
    userWorkspaceId,
  }: {
    workspaceId: string;
    userWorkspaceId: string;
  }): Promise<string | null> {
    const { flatWorkspaceMemberMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatWorkspaceMemberMaps',
      ]);

    return flatWorkspaceMemberMaps.idByUserWorkspaceId[userWorkspaceId] ?? null;
  }

  private findRuns({
    workspaceId,
    where,
  }: {
    workspaceId: string;
    where: FindOptionsWhere<WorkflowRunWorkspaceEntity>;
  }): Promise<Pick<WorkflowRunWorkspaceEntity, 'id' | 'coreWorkflowId'>[]> {
    return this.workspaceOrmManager.executeInWorkspaceContext(
      () =>
        this.workspaceOrmManager
          .getRepository<WorkflowRunWorkspaceEntity>('workflowRun', {
            shouldBypassPermissionChecks: true,
          })
          .find({
            where,
            select: { id: true, coreWorkflowId: true },
            withDeleted: true,
          }),
      buildSystemAuthContext(workspaceId),
    );
  }

  private withCoreWorkflowLock<TResult>(
    {
      workspaceId,
      coreWorkflowId,
    }: { workspaceId: string; coreWorkflowId: string },
    work: () => Promise<TResult>,
  ): Promise<TResult> {
    return this.cacheLockService.withLock(
      work,
      `workflow-run-record-shares:${workspaceId}:${coreWorkflowId}`,
      CORE_WORKFLOW_LOCK_OPTIONS,
    );
  }
}
