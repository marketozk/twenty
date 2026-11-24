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
import { NoteTargetWorkspaceEntity } from 'src/modules/note/standard-objects/note-target.workspace-entity';
import { NoteWorkspaceEntity } from 'src/modules/note/standard-objects/note.workspace-entity';

@Injectable()
export class NotePostQueryHookService {
  constructor(private readonly workspaceOrmManager: WorkspaceOrmManager) {}

  async handleNoteTargetsDelete(
    authContext: WorkspaceAuthContext,
    payload: NoteWorkspaceEntity[],
  ): Promise<void> {
    await this.transitionNoteTargets(authContext, payload, 'soft-delete');
  }

  async handleNoteTargetsRestore(
    authContext: WorkspaceAuthContext,
    payload: NoteWorkspaceEntity[],
  ): Promise<void> {
    await this.transitionNoteTargets(authContext, payload, 'restore');
  }

  private async transitionNoteTargets(
    authContext: WorkspaceAuthContext,
    payload: NoteWorkspaceEntity[],
    kind: 'soft-delete' | 'restore',
  ): Promise<void> {
    if (!payload || payload.length === 0) {
      return;
    }

    const noteIds = [
      ...new Set(
        payload.map((note) => {
          if (typeof note?.id !== 'string' || !isValidUuid(note.id)) {
            throw new Error('Invalid note id in post-query hook payload');
          }

          return note.id.toLowerCase();
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
        ? { systemActorId: 'note-targets-post-query-hook' }
        : {}),
    };

    await this.workspaceOrmManager.executeInWorkspaceContext(async () => {
      const targetObjectMetadataId =
        this.workspaceOrmManager.getObjectMetadataId('noteTarget');

      if (!targetObjectMetadataId) {
        throw new Error('Missing noteTarget object metadata');
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
              `SELECT id FROM "${schemaName}"."noteTarget" WHERE "noteId" = ANY($1::uuid[]) AND ${deletedCondition} ORDER BY id FOR UPDATE`,
              [noteIds],
            )) as Array<{ id: unknown }>;

            const targetIds = rows.map((row) => {
              if (typeof row?.id !== 'string' || !isValidUuid(row.id)) {
                throw new Error('Invalid noteTarget id returned during hook');
              }

              return row.id;
            });

            if (targetIds.length === 0) {
              return;
            }

            const noteTargetRepository =
              transactionScope.getRepository<NoteTargetWorkspaceEntity>(
                'noteTarget',
                { shouldBypassPermissionChecks: true },
              );

            await runInNativeCrmTargetLifecycleScope(
              transactionScope,
              { objectMetadataId: targetObjectMetadataId, kind },
              async () => {
                for (let offset = 0; offset < targetIds.length; offset += 1000) {
                  const targetIdsChunk = targetIds.slice(offset, offset + 1000);

                  if (kind === 'soft-delete') {
                    await noteTargetRepository.softDelete({
                      id: In(targetIdsChunk),
                    });
                  } else {
                    await noteTargetRepository.restore({
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
