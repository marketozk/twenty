import { type CrmAuditTransactionExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';

import {
  auditPayloadHash,
  canonicalAuditJson,
} from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import {
  type CrmAuditOperation,
  type CrmAuditMutation,
} from 'src/engine/core-modules/crm-audit/crm-audit.types';

export type CrmAuditEntryPayload = Omit<
  CrmAuditOperation,
  'initiator' | 'correlationId' | 'causationId'
> & {
  initiator: CrmAuditOperation['actor'] | null;
  correlationId: string | null;
  causationId: string | null;
  schemaVersion: number;
  eventKey: string;
  attemptId: string | null;
  action: CrmAuditMutation['action'];
  resourceKind: CrmAuditMutation['resourceKind'];
  resourceId: string;
  outcome: 'success' | 'denied' | 'failed';
  reasonCode: string | null;
  redactedDiff: {
    changedFields: string[];
    values: Record<string, { before: unknown; after: unknown }>;
  };
  securityDescriptor: CrmAuditMutation['securityDescriptor'];
};

// Callers verify runtime privileges before appending through the same transaction.
export const appendCrmAuditEntry = async (
  queryRunner: CrmAuditTransactionExecutor,
  payload: CrmAuditEntryPayload,
): Promise<void> => {
  const hash = auditPayloadHash(payload);

  await queryRunner.query(
    `INSERT INTO crm_audit."crmAuditEntry"
      ("workspaceId", "eventKey", "operationId", "attemptId", actor, initiator,
       action, "resourceKind", "resourceId", outcome, "reasonCode", "redactedDiff",
       "payloadHash", "securityDescriptor", "correlationId", "causationId", "schemaVersion")
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10,
       $11, $12::jsonb, $13, $14::jsonb, $15, $16, $17)
     ON CONFLICT ("workspaceId", "eventKey") DO NOTHING`,
    [
      payload.workspaceId,
      payload.eventKey,
      payload.operationId,
      payload.attemptId,
      canonicalAuditJson(payload.actor),
      canonicalAuditJson(payload.initiator),
      payload.action,
      payload.resourceKind,
      payload.resourceId,
      payload.outcome,
      payload.reasonCode,
      canonicalAuditJson(payload.redactedDiff),
      hash,
      canonicalAuditJson(payload.securityDescriptor),
      payload.correlationId,
      payload.causationId,
      payload.schemaVersion,
    ],
  );
  const rows = await queryRunner.query(
    `SELECT "payloadHash" FROM crm_audit."crmAuditEntry"
     WHERE "workspaceId" = $1 AND "eventKey" = $2`,
    [payload.workspaceId, payload.eventKey],
  );

  if (
    rows.length !== 1 ||
    typeof rows[0] !== 'object' ||
    rows[0] === null ||
    !('payloadHash' in rows[0]) ||
    rows[0].payloadHash !== hash
  ) {
    throw new Error('Audit event key conflicts with its immutable payload');
  }
};
