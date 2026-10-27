import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { appendCrmAuditAttempt } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { type OmniSentReceiptPrincipal } from 'src/modules/omnichannel/contracts/omni-sent-receipt';
import { type OmniSentReceiptScope } from 'src/modules/omnichannel/services/omni-sent-receipt';

// Called only in a fresh strict transaction after the owner confirms rollback.
// The failed accept has no durable receipt yet: attribute that attempt to its known Command.
export const appendOmniSentReceiptFailure = async (
  scope: OmniSentReceiptScope,
  principal: OmniSentReceiptPrincipal,
  target: Readonly<{ operation: 'accept' | 'claim'; resourceId: string }>,
  operationId: string,
  denied: boolean,
): Promise<void> => {
  if (scope.workspaceId !== principal.workspaceId)
    throw new Error('OMNI_SENT_RECEIPT_FAILURE_AUDIT_WORKSPACE_MISMATCH');
  const executor = createCrmAuditWorkspaceExecutor(scope);
  const query =
    target.operation === 'accept'
      ? `SELECT command.id,conversation.id AS "conversationId",binding.id AS "bindingId"
       FROM core."omniOutgoingCommand" command
       JOIN core."omniConversation" conversation ON conversation.id=command."conversationId" AND conversation."workspaceId"=command."workspaceId"
       JOIN core."omniAccountBinding" binding ON binding.id=conversation."bindingId" AND binding."workspaceId"=conversation."workspaceId"
       JOIN core."omniWorkspacePolicyState" policy ON policy."workspaceId"=binding."workspaceId"
       WHERE command."workspaceId"=$1 AND command.id=$2 AND binding.id=$3`
      : `SELECT receipt.id,NULL::uuid AS "conversationId",binding.id AS "bindingId"
       FROM core."omniIncomingReceipt" receipt
       JOIN core."omniAccountBinding" binding ON binding.id=receipt."bindingId" AND binding."workspaceId"=receipt."workspaceId"
       JOIN core."omniWorkspacePolicyState" policy ON policy."workspaceId"=binding."workspaceId"
       WHERE receipt."workspaceId"=$1 AND receipt.id=$2 AND binding.id=$3 AND receipt.kind='command.sent'`;
  const rows = z
    .array(
      z.object({
        id: z.uuid(),
        conversationId: z.uuid().nullable(),
        bindingId: z.uuid(),
      }),
    )
    .parse(
      await executor.query(query, [
        principal.workspaceId,
        target.resourceId,
        principal.bindingId,
      ]),
    );
  if (rows.length === 0) return;
  if (
    rows.length !== 1 ||
    rows[0].id !== target.resourceId ||
    rows[0].bindingId !== principal.bindingId ||
    (target.operation === 'accept' && rows[0].conversationId === null)
  )
    throw new Error('OMNI_SENT_RECEIPT_FAILURE_AUDIT_RESOURCE_MISMATCH');
  const resourceKind =
    target.operation === 'accept'
      ? 'omniOutgoingCommand'
      : 'omniIncomingReceipt';
  await appendCrmAuditAttempt(
    executor,
    { workspaceId: principal.workspaceId, operationId, actor: principal.actor },
    {
      attemptId: randomUUID(),
      resourceKind,
      resourceId: target.resourceId,
      action: 'update',
      outcome: denied ? 'denied' : 'failed',
      reasonCode: `sent_receipt.${target.operation}.${denied ? 'denied' : 'failed'}`,
      securityDescriptor: {
        resourceKind,
        resourceId: target.resourceId,
        bindingId: rows[0].bindingId,
        ...(rows[0].conversationId
          ? { conversationId: rows[0].conversationId }
          : {}),
      },
    },
  );
};
