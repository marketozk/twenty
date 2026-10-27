import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { appendCrmAuditAttempt } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import {
  type OmniHumanCommandLeaseInput,
  type OmniHumanCommandLeasePrincipal,
} from 'src/modules/omnichannel/contracts/omni-human-command-lease';
import { type OmniHumanCommandLeaseScope } from 'src/modules/omnichannel/services/claim-omni-human-command';

// Only the strict transaction owner invokes this after confirmed rollback.
export const appendOmniHumanCommandLeaseFailure = async (
  scope: OmniHumanCommandLeaseScope,
  principal: OmniHumanCommandLeasePrincipal,
  input: OmniHumanCommandLeaseInput,
  operationId: string,
  denied: boolean,
): Promise<void> => {
  if (scope.workspaceId !== principal.workspaceId)
    throw new Error(
      'OMNI_HUMAN_COMMAND_LEASE_FAILURE_AUDIT_WORKSPACE_MISMATCH',
    );
  const executor = createCrmAuditWorkspaceExecutor(scope);
  const rows = z
    .array(
      z.object({ id: z.uuid(), conversationId: z.uuid(), bindingId: z.uuid() }),
    )
    .parse(
      await executor.query(
        `SELECT command.id,conversation.id AS "conversationId",binding.id AS "bindingId"
     FROM core."omniOutgoingCommand" command
     JOIN core."omniConversation" conversation ON conversation.id=command."conversationId" AND conversation."workspaceId"=command."workspaceId"
     JOIN core."omniAccountBinding" binding ON binding.id=conversation."bindingId" AND binding."workspaceId"=conversation."workspaceId"
     JOIN core."omniWorkspacePolicyState" policy ON policy."workspaceId"=binding."workspaceId"
     WHERE command."workspaceId"=$1 AND command.id=$2 AND binding.id=$3`,
        [principal.workspaceId, input.commandId, principal.bindingId],
      ),
    );
  if (rows.length === 0) return;
  if (
    rows.length !== 1 ||
    rows[0].id !== input.commandId ||
    rows[0].bindingId !== principal.bindingId
  )
    throw new Error('OMNI_HUMAN_COMMAND_LEASE_FAILURE_AUDIT_RESOURCE_MISMATCH');
  await appendCrmAuditAttempt(
    executor,
    {
      workspaceId: principal.workspaceId,
      operationId,
      actor: principal.actor,
    },
    {
      attemptId: randomUUID(),
      resourceKind: 'omniOutgoingCommand',
      resourceId: input.commandId,
      action: 'update',
      outcome: denied ? 'denied' : 'failed',
      reasonCode: denied ? 'command.claim.denied' : 'command.claim.failed',
      securityDescriptor: {
        resourceKind: 'omniOutgoingCommand',
        resourceId: input.commandId,
        bindingId: rows[0].bindingId,
        conversationId: rows[0].conversationId,
      },
    },
  );
};
