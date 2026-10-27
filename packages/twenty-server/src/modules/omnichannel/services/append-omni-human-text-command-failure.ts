import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { appendCrmAuditAttempt } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import {
  type OmniHumanTextCommandInput,
  type OmniHumanTextCommandPrincipal,
} from 'src/modules/omnichannel/contracts/omni-human-text-command';
import {
  omniHumanTextCommandOperationId,
  type OmniHumanTextCommandScope,
} from 'src/modules/omnichannel/services/admit-omni-human-text-command';

export const appendOmniHumanTextCommandFailure = async (
  scope: OmniHumanTextCommandScope,
  principal: OmniHumanTextCommandPrincipal,
  input: OmniHumanTextCommandInput,
  denied: boolean,
): Promise<void> => {
  const workspaceId = z.uuid().parse(principal.workspaceId).toLowerCase();
  const executor = createCrmAuditWorkspaceExecutor(scope);
  if (scope.workspaceId !== workspaceId)
    throw new Error('OMNI_HUMAN_COMMAND_FAILURE_AUDIT_WORKSPACE_MISMATCH');

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
    throw new Error('OMNI_HUMAN_COMMAND_FAILURE_AUDIT_AMBIGUOUS_ACTOR');

  const rows = z.array(z.object({ id: z.uuid(), bindingId: z.uuid() })).parse(
    await executor.query(
      `SELECT conversation.id,conversation."bindingId" FROM core."omniConversation" conversation
       JOIN core."omniAccountBinding" binding ON binding.id=conversation."bindingId" AND binding."workspaceId"=conversation."workspaceId"
       JOIN core."omniWorkspacePolicyState" policy ON policy."workspaceId"=conversation."workspaceId"
       WHERE conversation."workspaceId"=$1 AND conversation.id=$2`,
      [workspaceId, input.conversationId],
    ),
  );
  if (rows.length === 0) return;
  if (rows.length !== 1 || rows[0].id !== input.conversationId)
    throw new Error('OMNI_HUMAN_COMMAND_FAILURE_AUDIT_AMBIGUOUS_CONVERSATION');

  await appendCrmAuditAttempt(
    executor,
    {
      workspaceId,
      operationId: omniHumanTextCommandOperationId(principal, input),
      actor: { kind: 'workspaceMember', id: principal.workspaceMemberId },
    },
    {
      attemptId: randomUUID(),
      resourceKind: 'omniConversation',
      resourceId: input.conversationId,
      action: 'update',
      outcome: denied ? 'denied' : 'failed',
      reasonCode: denied ? 'command.admit.denied' : 'command.admit.failed',
      securityDescriptor: {
        resourceKind: 'omniConversation',
        resourceId: input.conversationId,
        bindingId: rows[0].bindingId,
        conversationId: input.conversationId,
      },
    },
  );
};
