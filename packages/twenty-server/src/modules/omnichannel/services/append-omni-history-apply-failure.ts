import { randomUUID } from 'node:crypto';

import { appendCrmAuditAttempt } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import {
  omniHistoryApplyOperationId,
  type OmniHistoryApplyScope,
  type OmniHistoryApplyPrincipal,
  type OmniHistoryApplyProof,
} from 'src/modules/omnichannel/services/apply-omni-history-receipt';

export const appendOmniHistoryApplyFailure = async (
  scope: OmniHistoryApplyScope,
  principal: OmniHistoryApplyPrincipal,
  proof: OmniHistoryApplyProof,
  denied: boolean,
): Promise<void> => {
  const executor = createCrmAuditWorkspaceExecutor(scope);
  if (scope.workspaceId !== principal.workspaceId)
    throw new Error('OMNI_HISTORY_FAILURE_AUDIT_WORKSPACE_MISMATCH');
  const rows = await executor.query(
    `SELECT receipt.id FROM core."omniIncomingReceipt" receipt
    JOIN core."omniAccountBinding" binding ON binding.id=receipt."bindingId" AND binding."workspaceId"=receipt."workspaceId"
    JOIN core."omniWorkspacePolicyState" policy ON policy."workspaceId"=receipt."workspaceId"
    WHERE receipt."workspaceId"=$1 AND receipt."bindingId"=$2 AND receipt.id=$3`,
    [principal.workspaceId, principal.bindingId, proof.receiptId],
  );
  // A foreign or nonexistent receipt cannot become an audited resource in this workspace.
  if (rows.length === 0) return;
  if (rows.length !== 1)
    throw new Error('OMNI_HISTORY_FAILURE_AUDIT_AMBIGUOUS_RECEIPT');
  await appendCrmAuditAttempt(
    executor,
    {
      workspaceId: principal.workspaceId,
      operationId: omniHistoryApplyOperationId(proof.receiptId),
      actor: principal.actor,
    },
    {
      attemptId: randomUUID(),
      resourceKind: 'omniIncomingReceipt',
      resourceId: proof.receiptId,
      action: 'update',
      outcome: denied ? 'denied' : 'failed',
      reasonCode: denied ? 'history.apply.denied' : 'history.apply.failed',
      securityDescriptor: {
        resourceKind: 'omniIncomingReceipt',
        resourceId: proof.receiptId,
        bindingId: principal.bindingId,
      },
    },
  );
};
