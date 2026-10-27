import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { appendCrmAuditAttempt } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import {
  type OmniSentApplyPrincipal,
  type OmniSentApplyProof,
  type OmniSentApplyScope,
} from 'src/modules/omnichannel/services/apply-omni-sent-receipt';

// The owner calls this only after confirmed rollback, on a fresh strict scope.
export const appendOmniSentApplyFailure = async (
  scope: OmniSentApplyScope,
  principal: OmniSentApplyPrincipal,
  proof: OmniSentApplyProof,
  operationId: string,
  denied: boolean,
): Promise<void> => {
  if (scope.workspaceId !== principal.workspaceId)
    throw new Error('OMNI_SENT_APPLY_FAILURE_AUDIT_WORKSPACE_MISMATCH');
  const executor = createCrmAuditWorkspaceExecutor(scope);
  const rows = z.array(z.object({ id: z.uuid(), bindingId: z.uuid() })).parse(
    await executor.query(
      `SELECT receipt.id,binding.id AS "bindingId" FROM core."omniIncomingReceipt" receipt
     JOIN core."omniAccountBinding" binding ON binding.id=receipt."bindingId" AND binding."workspaceId"=receipt."workspaceId"
     JOIN core."omniWorkspacePolicyState" policy ON policy."workspaceId"=binding."workspaceId"
     WHERE receipt."workspaceId"=$1 AND receipt.id=$2 AND binding.id=$3 AND receipt.kind='command.sent'`,
      [principal.workspaceId, proof.receiptId, principal.bindingId],
    ),
  );
  if (rows.length === 0) return;
  if (
    rows.length !== 1 ||
    rows[0].id !== proof.receiptId ||
    rows[0].bindingId !== principal.bindingId
  )
    throw new Error('OMNI_SENT_APPLY_FAILURE_AUDIT_RESOURCE_MISMATCH');
  await appendCrmAuditAttempt(
    executor,
    { workspaceId: principal.workspaceId, operationId, actor: principal.actor },
    {
      attemptId: randomUUID(),
      resourceKind: 'omniIncomingReceipt',
      resourceId: proof.receiptId,
      action: 'update',
      outcome: denied ? 'denied' : 'failed',
      reasonCode: `sent_receipt.apply.${denied ? 'denied' : 'failed'}`,
      securityDescriptor: {
        resourceKind: 'omniIncomingReceipt',
        resourceId: proof.receiptId,
        bindingId: rows[0].bindingId,
      },
    },
  );
};
