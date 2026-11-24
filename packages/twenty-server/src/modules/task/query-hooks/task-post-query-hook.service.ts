import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';

import {
  assertIsDefinedOrThrow,
  isValidUuid,
  uuidToBase36,
} from 'twenty-shared/utils';
import { In } from 'typeorm';

import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import {
  captureNativeCrmAuditBinding,
  runInNativeCrmTargetLifecycleScope,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';
import { recordPostRollbackNativeCrmAuditAttempt } from 'src/engine/core-modules/crm-audit/post-rollback-crm-audit-attempt';
import { WorkspaceNotFoundDefaultError } from 'src/engine/core-modules/workspace/workspace.exception';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { TaskTargetWorkspaceEntity } from 'src/modules/task/standard-objects/task-target.workspace-entity';
import { TaskWorkspaceEntity } from 'src/modules/task/standard-objects/task.workspace-entity';

@Injectable()
export class TaskPostQueryHookService {
  constructor(private readonly workspaceOrmManager: WorkspaceOrmManager) {}

  async handleTaskTargetsDelete(
    authContext: WorkspaceAuthContext,
    payload: TaskWorkspaceEntity[],
  ): Promise<void> {
    await this.transitionTaskTargets(authContext, payload, 'soft-delete');
  }

  async handleTaskTargetsRestore(
    authContext: WorkspaceAuthContext,
    payload: TaskWorkspaceEntity[],
  ): Promise<void> {
    await this.transitionTaskTargets(authContext, payload, 'restore');
  }

  private async transitionTaskTargets(
    authContext: WorkspaceAuthContext,
    payload: TaskWorkspaceEntity[],
    kind: 'soft-delete' | 'restore',
  ): Promise<void> {
    if (!payload || payload.length === 0) {
      return;
    }

    const taskIds = [
      ...new Set(
        payload.map((task) => {
          if (typeof task?.id !== 'string' || !isValidUuid(task.id)) {
            throw new Error('Invalid task id in post-query hook payload');
          }

          return task.id.toLowerCase();
        }),
      ),
    ];

    const workspace = authContext.workspace;

    assertIsDefinedOrThrow(workspace, WorkspaceNotFoundDefaultError);

    if (typeof workspace.id !== 'string' || !isValidUuid(workspace.id)) {
      throw new Error('Invalid workspace id in post-query hook');
    }

    const schemaName = `workspace_${uuidToBase36(workspace.id)}`;
    const nativeAuditOptions = {
      operationId: randomUUID(),
      ...(authContext.type === 'system'
        ? { systemActorId: 'task-targets-post-query-hook' }
        : {}),
    };

    await this.workspaceOrmManager.executeInWorkspaceContext(async () => {
      const targetObjectMetadataId =
        this.workspaceOrmManager.getObjectMetadataId('taskTarget');

      if (!targetObjectMetadataId) {
        throw new Error('Missing taskTarget object metadata');
      }

      const binding = captureNativeCrmAuditBinding(
        workspace.id,
        authContext,
        nativeAuditOptions,
      );

      try {
        await this.workspaceOrmManager.runInWorkspaceTransaction(
          async (transactionScope) => {
            const deletedCondition =
              kind === 'soft-delete'
                ? '"deletedAt" IS NULL'
                : '"deletedAt" IS NOT NULL';
            const rows = (await transactionScope.executeRawQuery(
              `SELECT id FROM "${schemaName}"."taskTarget" WHERE "taskId" = ANY($1::uuid[]) AND ${deletedCondition} ORDER BY id FOR UPDATE`,
              [taskIds],
            )) as Array<{ id: unknown }>;

            const targetIds = rows.map((row) => {
              if (typeof row?.id !== 'string' || !isValidUuid(row.id)) {
                throw new Error('Invalid taskTarget id returned during hook');
              }

              return row.id;
            });

            if (targetIds.length === 0) {
              return;
            }

            const taskTargetRepository =
              transactionScope.getRepository<TaskTargetWorkspaceEntity>(
                'taskTarget',
                { shouldBypassPermissionChecks: true },
              );

            await runInNativeCrmTargetLifecycleScope(
              transactionScope,
              { objectMetadataId: targetObjectMetadataId, kind },
              async () => {
                for (let offset = 0; offset < targetIds.length; offset += 1000) {
                  const targetIdsChunk = targetIds.slice(offset, offset + 1000);

                  if (kind === 'soft-delete') {
                    await taskTargetRepository.softDelete({
                      id: In(targetIdsChunk),
                    });
                  } else {
                    await taskTargetRepository.restore({
                      id: In(targetIdsChunk),
                    });
                  }
                }
              },
            );
          },
          { nativeAudit: nativeAuditOptions },
        );
      } catch (error) {
        await recordPostRollbackNativeCrmAuditAttempt({
          runInAuditTransaction: (work, options) =>
            this.workspaceOrmManager.runInWorkspaceTransaction(work, options),
          binding,
          action: 'update',
          resourceId: targetObjectMetadataId,
          objectMetadataId: targetObjectMetadataId,
          error,
        });

        throw error;
      }
    }, authContext);
  }
}
