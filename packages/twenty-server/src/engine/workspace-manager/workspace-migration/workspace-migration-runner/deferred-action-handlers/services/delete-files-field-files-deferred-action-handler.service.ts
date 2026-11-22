import { Inject, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { type QueryRunner } from 'typeorm';

import {
  captureFilesFieldHardDeleteIntentPayload,
  FILES_FIELD_HARD_DELETE_INTENT_NAME,
  FILES_FIELD_HARD_DELETE_RECONCILIATION,
  type FilesFieldHardDeleteReconciliationPort,
} from 'src/engine/core-modules/crm-audit/files-field-hard-delete-audit';
import { DeferredWorkspaceMigrationActionHandlerDecorator } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/deferred-action-handlers/decorators/deferred-workspace-migration-action-handler.decorator';

const FENCED_ERROR_MESSAGE =
  'Files field hard-delete intent fenced by unsafe outcome';

const handleInactiveWorkspaceIntent = async ({
  queryRunner,
  workspaceId,
  actionId,
}: {
  queryRunner: QueryRunner;
  workspaceId: string;
  actionId?: string;
}): Promise<boolean> => {
  const [workspace] = await queryRunner.query(
    'SELECT "deletedAt" FROM core.workspace WHERE id=$1',
    [workspaceId],
  );
  if (workspace && !workspace.deletedAt) return false;
  const fenced = await queryRunner.query(
    actionId === undefined
      ? `UPDATE core."deferredWorkspaceMigrationAction" SET status='FAILED',"startedAt"=NULL,"lastError"=$3,"updatedAt"=now() WHERE "workspaceId"=$1 AND name=$2 AND status='PENDING' AND (payload ? 'unsafeOutcome') RETURNING id`
      : `UPDATE core."deferredWorkspaceMigrationAction" SET status='FAILED',"startedAt"=NULL,"lastError"=$4,"updatedAt"=now() WHERE id=$1 AND "workspaceId"=$2 AND name=$3 AND status='PENDING' AND (payload ? 'unsafeOutcome') RETURNING id`,
    actionId === undefined
      ? [workspaceId, FILES_FIELD_HARD_DELETE_INTENT_NAME, FENCED_ERROR_MESSAGE]
      : [
          actionId,
          workspaceId,
          FILES_FIELD_HARD_DELETE_INTENT_NAME,
          FENCED_ERROR_MESSAGE,
        ],
  );
  const fencedRows =
    Array.isArray(fenced) && Array.isArray(fenced[0]) ? fenced[0] : fenced;
  if (Array.isArray(fencedRows) && fencedRows.length > 0) {
    throw new Error(FENCED_ERROR_MESSAGE);
  }
  await queryRunner.query(
    actionId === undefined
      ? `DELETE FROM core."deferredWorkspaceMigrationAction" WHERE "workspaceId"=$1 AND name=$2 AND status='PENDING' AND NOT (payload ? 'unsafeOutcome')`
      : `DELETE FROM core."deferredWorkspaceMigrationAction" WHERE id=$1 AND "workspaceId"=$2 AND name=$3 AND status='PENDING' AND NOT (payload ? 'unsafeOutcome')`,
    actionId === undefined
      ? [workspaceId, FILES_FIELD_HARD_DELETE_INTENT_NAME]
      : [actionId, workspaceId, FILES_FIELD_HARD_DELETE_INTENT_NAME],
  );
  return true;
};

@Injectable()
@DeferredWorkspaceMigrationActionHandlerDecorator(
  FILES_FIELD_HARD_DELETE_INTENT_NAME,
)
export class DeleteFilesFieldFilesDeferredActionHandlerService {
  readonly metadataNamesToLoad = [];
  readonly managesOwnPersistence = true;

  constructor(
    @Inject(FILES_FIELD_HARD_DELETE_RECONCILIATION)
    private readonly filesFieldHardDeleteReconciliationService: FilesFieldHardDeleteReconciliationPort,
  ) {}

  async execute({
    workspaceId,
    payload,
    queryRunner,
    actionId,
  }: {
    workspaceId: string;
    payload: unknown;
    queryRunner: QueryRunner;
    actionId?: string;
  }): Promise<void> {
    if (
      typeof workspaceId !== 'string' ||
      !isUUID(workspaceId) ||
      (actionId !== undefined &&
        (typeof actionId !== 'string' || !isUUID(actionId)))
    ) {
      throw new Error('Files field hard-delete recovery scope mismatch');
    }
    const canonicalWorkspaceId = workspaceId.toLowerCase();
    const normalizedActionId = actionId?.toLowerCase();
    if (normalizedActionId === undefined) {
      const validated = captureFilesFieldHardDeleteIntentPayload(payload);
      if (validated.unsafeOutcome !== undefined) {
        throw new Error(FENCED_ERROR_MESSAGE);
      }
    }
    if (
      await handleInactiveWorkspaceIntent({
        queryRunner,
        workspaceId: canonicalWorkspaceId,
        actionId: normalizedActionId,
      })
    ) {
      return;
    }
    await this.filesFieldHardDeleteReconciliationService.reconcileFilesFieldHardDeleteIntentsWithAudit(
      {
        workspaceId: canonicalWorkspaceId,
        ...(normalizedActionId === undefined
          ? {}
          : { intentId: normalizedActionId }),
      },
    );
  }
}
