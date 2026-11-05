import { Inject, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { type QueryRunner } from 'typeorm';

import {
  CALENDAR_IMPORT_MATCHING_INTENT_NAME,
  captureCalendarImportMatchingIntentPayload,
} from 'src/engine/core-modules/crm-audit/calendar-save-proof';
import {
  captureMessageImportMatchingIntentPayload,
  MESSAGE_IMPORT_MATCHING_INTENT_NAME,
} from 'src/engine/core-modules/crm-audit/message-import-matching-context';
import { DeferredWorkspaceMigrationActionHandlerDecorator } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/deferred-action-handlers/decorators/deferred-workspace-migration-action-handler.decorator';

export const IMPORT_MATCHING_INTENT_RECONCILIATION =
  'IMPORT_MATCHING_INTENT_RECONCILIATION';

export type ImportMatchingIntentReconciliationPort = {
  reconcileMessageImportMatchingIntentsWithAudit(args: {
    workspaceId: string;
    intentId?: string;
  }): Promise<{
    processedIntents: number;
    completedIntents: number;
    pagesApplied: number;
  }>;
  reconcileCalendarImportMatchingIntentsWithAudit(args: {
    workspaceId: string;
    intentId?: string;
  }): Promise<{
    processedIntents: number;
    completedIntents: number;
  }>;
};

const handleInactiveWorkspaceIntent = async ({
  queryRunner,
  workspaceId,
  name,
  actionId,
  fencedErrorMessage,
}: {
  queryRunner: QueryRunner;
  workspaceId: string;
  name: string;
  actionId?: string;
  fencedErrorMessage: string;
}): Promise<boolean> => {
  const [workspace] = await queryRunner.query(
    'SELECT "deletedAt" FROM core.workspace WHERE id=$1',
    [workspaceId],
  );
  if (workspace && !workspace.deletedAt) return false;
  const fenced = await queryRunner.query(
    actionId === undefined
      ? 'UPDATE core."deferredWorkspaceMigrationAction" SET status=\'FAILED\',"startedAt"=NULL,"lastError"=$3,"updatedAt"=now() WHERE "workspaceId"=$1 AND name=$2 AND status=\'PENDING\' AND (payload ? \'unsafeOutcome\') RETURNING id'
      : 'UPDATE core."deferredWorkspaceMigrationAction" SET status=\'FAILED\',"startedAt"=NULL,"lastError"=$4,"updatedAt"=now() WHERE id=$1 AND "workspaceId"=$2 AND name=$3 AND status=\'PENDING\' AND (payload ? \'unsafeOutcome\') RETURNING id',
    actionId === undefined
      ? [workspaceId, name, fencedErrorMessage]
      : [actionId, workspaceId, name, fencedErrorMessage],
  );
  const fencedRows =
    Array.isArray(fenced) && Array.isArray(fenced[0]) ? fenced[0] : fenced;
  if (Array.isArray(fencedRows) && fencedRows.length > 0)
    throw new Error(fencedErrorMessage);
  await queryRunner.query(
    actionId === undefined
      ? 'DELETE FROM core."deferredWorkspaceMigrationAction" WHERE "workspaceId"=$1 AND name=$2 AND status=\'PENDING\' AND NOT (payload ? \'unsafeOutcome\')'
      : 'DELETE FROM core."deferredWorkspaceMigrationAction" WHERE id=$1 AND "workspaceId"=$2 AND name=$3 AND status=\'PENDING\' AND NOT (payload ? \'unsafeOutcome\')',
    actionId === undefined
      ? [workspaceId, name]
      : [actionId, workspaceId, name],
  );
  return true;
};

@Injectable()
@DeferredWorkspaceMigrationActionHandlerDecorator(
  MESSAGE_IMPORT_MATCHING_INTENT_NAME,
)
export class ReconcileMessageImportMatchingDeferredActionHandlerService {
  readonly metadataNamesToLoad = [];
  readonly managesOwnPersistence = true;

  constructor(
    @Inject(IMPORT_MATCHING_INTENT_RECONCILIATION)
    private readonly importMatchingReconciliationService: ImportMatchingIntentReconciliationPort,
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
    )
      throw new Error('Native message import matching recovery scope mismatch');
    const canonicalWorkspaceId = workspaceId.toLowerCase();
    const normalizedActionId = actionId?.toLowerCase();
    if (normalizedActionId === undefined) {
      const validated = captureMessageImportMatchingIntentPayload(payload);
      if (validated.unsafeOutcome !== undefined)
        throw new Error(
          'Native message import matching intent fenced by unsafe outcome',
        );
    }
    if (
      await handleInactiveWorkspaceIntent({
        queryRunner,
        workspaceId: canonicalWorkspaceId,
        name: MESSAGE_IMPORT_MATCHING_INTENT_NAME,
        actionId: normalizedActionId,
        fencedErrorMessage:
          'Native message import matching intent fenced by unsafe outcome',
      })
    )
      return;
    await this.importMatchingReconciliationService.reconcileMessageImportMatchingIntentsWithAudit(
      {
        workspaceId: canonicalWorkspaceId,
        ...(normalizedActionId === undefined
          ? {}
          : { intentId: normalizedActionId }),
      },
    );
  }
}

@Injectable()
@DeferredWorkspaceMigrationActionHandlerDecorator(
  CALENDAR_IMPORT_MATCHING_INTENT_NAME,
)
export class ReconcileCalendarImportMatchingDeferredActionHandlerService {
  readonly metadataNamesToLoad = [];
  readonly managesOwnPersistence = true;

  constructor(
    @Inject(IMPORT_MATCHING_INTENT_RECONCILIATION)
    private readonly importMatchingReconciliationService: ImportMatchingIntentReconciliationPort,
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
    )
      throw new Error('Calendar matching recovery requires valid workspace');
    const canonicalWorkspaceId = workspaceId.toLowerCase();
    const normalizedActionId = actionId?.toLowerCase();
    if (normalizedActionId === undefined) {
      const validated = captureCalendarImportMatchingIntentPayload(payload);
      if (validated.unsafeOutcome !== undefined)
        throw new Error('Calendar matching intent fenced by unsafe outcome');
    }
    if (
      await handleInactiveWorkspaceIntent({
        queryRunner,
        workspaceId: canonicalWorkspaceId,
        name: CALENDAR_IMPORT_MATCHING_INTENT_NAME,
        actionId: normalizedActionId,
        fencedErrorMessage: 'Calendar matching intent fenced by unsafe outcome',
      })
    )
      return;
    await this.importMatchingReconciliationService.reconcileCalendarImportMatchingIntentsWithAudit(
      {
        workspaceId: canonicalWorkspaceId,
        ...(normalizedActionId === undefined
          ? {}
          : { intentId: normalizedActionId }),
      },
    );
  }
}
