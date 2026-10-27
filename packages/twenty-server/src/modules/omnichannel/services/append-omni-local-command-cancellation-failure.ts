import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { appendCrmAuditAttempt } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import {
  type OmniLocalCommandCancellationInput,
  type OmniLocalCommandCancellationPrincipal,
} from 'src/modules/omnichannel/contracts/omni-local-command-cancellation';
import { type OmniLocalCommandCancellationScope } from 'src/modules/omnichannel/services/cancel-omni-local-human-command';

export const appendOmniLocalCommandCancellationFailure = async (
  scope: OmniLocalCommandCancellationScope,
  principal: OmniLocalCommandCancellationPrincipal,
  input: OmniLocalCommandCancellationInput,
  operationId: string,
  denied: boolean,
): Promise<void> => {
  const workspaceId = z.uuid().parse(principal.workspaceId).toLowerCase();
  const executor = createCrmAuditWorkspaceExecutor(scope);
  if (scope.workspaceId !== workspaceId)
    throw new Error(
      'OMNI_LOCAL_COMMAND_CANCEL_FAILURE_AUDIT_WORKSPACE_MISMATCH',
    );

  // Preserve Twenty's schema encoding without importing the Enterprise-linked utils barrel.
  const schema = `workspace_${BigInt(`0x${workspaceId.replaceAll('-', '')}`).toString(36)}`;
  // Retained membership proves the actor's identity even after revocation; it grants no access.
  const members = z.array(z.object({ id: z.uuid() })).parse(
    await executor.query(
      `SELECT member.id FROM "${schema}"."workspaceMember" member
     JOIN core."user" retained_user ON retained_user.id=member."userId"
     WHERE member.id=$2 AND member."userId"=$3 AND EXISTS (
       SELECT 1 FROM core."userWorkspace" membership
       WHERE membership."userId"=member."userId" AND membership."workspaceId"=$1
     )`,
      [workspaceId, principal.workspaceMemberId, principal.userId],
    ),
  );
  if (members.length === 0) return;
  if (members.length !== 1 || members[0].id !== principal.workspaceMemberId)
    throw new Error('OMNI_LOCAL_COMMAND_CANCEL_FAILURE_AUDIT_AMBIGUOUS_ACTOR');

  const rows = z
    .array(
      z.object({ id: z.uuid(), bindingId: z.uuid(), conversationId: z.uuid() }),
    )
    .parse(
      await executor.query(
        `SELECT command.id,conversation.id AS "conversationId",conversation."bindingId" FROM core."omniConversation" conversation JOIN core."omniOutgoingCommand" command ON command."conversationId"=conversation.id AND command."workspaceId"=conversation."workspaceId"
       JOIN core."omniAccountBinding" binding ON binding.id=conversation."bindingId" AND binding."workspaceId"=conversation."workspaceId"
       JOIN core."omniWorkspacePolicyState" policy ON policy."workspaceId"=conversation."workspaceId"
       WHERE conversation."workspaceId"=$1 AND command.id=$2`,
        [workspaceId, input.commandId],
      ),
    );
  if (rows.length === 0) return;
  if (rows.length !== 1 || rows[0].id !== input.commandId)
    throw new Error(
      'OMNI_LOCAL_COMMAND_CANCEL_FAILURE_AUDIT_AMBIGUOUS_CONVERSATION',
    );

  await appendCrmAuditAttempt(
    executor,
    {
      workspaceId,
      operationId,
      actor: { kind: 'workspaceMember', id: principal.workspaceMemberId },
    },
    {
      attemptId: randomUUID(),
      resourceKind: 'omniOutgoingCommand',
      resourceId: input.commandId,
      action: 'update',
      outcome: denied ? 'denied' : 'failed',
      reasonCode: denied
        ? 'command.cancel.local.denied'
        : 'command.cancel.local.failed',
      securityDescriptor: {
        resourceKind: 'omniOutgoingCommand',
        resourceId: input.commandId,
        bindingId: rows[0].bindingId,
        conversationId: rows[0].conversationId,
      },
    },
  );
};
