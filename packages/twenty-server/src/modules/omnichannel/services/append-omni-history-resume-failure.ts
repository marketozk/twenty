import { randomUUID } from 'node:crypto';

import { appendCrmAuditAttempt } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { type OmniHistoryApplyScope } from 'src/modules/omnichannel/services/apply-omni-history-receipt';
import { type OmniBlockedHistoryResumePrincipal } from 'src/modules/omnichannel/services/resume-omni-blocked-history-receipts';

export const appendOmniHistoryResumeFailure = async (
  scope: OmniHistoryApplyScope,
  principal: OmniBlockedHistoryResumePrincipal,
  operationId: string,
  denied: boolean,
): Promise<void> => {
  const executor = createCrmAuditWorkspaceExecutor(scope);

  if (scope.workspaceId !== principal.workspaceId)
    throw new Error('OMNI_HISTORY_RESUME_FAILURE_AUDIT_WORKSPACE_MISMATCH');

  const rows = await executor.query(
    `SELECT binding.id FROM core."omniAccountBinding" binding
    JOIN core."omniWorkspacePolicyState" policy ON policy."workspaceId"=binding."workspaceId"
    WHERE binding."workspaceId"=$1 AND binding.id=$2`,
    [principal.workspaceId, principal.bindingId],
  );

  if (rows.length === 0) return;
  if (rows.length !== 1)
    throw new Error('OMNI_HISTORY_RESUME_FAILURE_AUDIT_AMBIGUOUS_BINDING');

  await appendCrmAuditAttempt(
    executor,
    { workspaceId: principal.workspaceId, operationId, actor: principal.actor },
    {
      attemptId: randomUUID(),
      resourceKind: 'omniAccountBinding',
      resourceId: principal.bindingId,
      action: 'update',
      outcome: denied ? 'denied' : 'failed',
      reasonCode: denied ? 'history.resume.denied' : 'history.resume.failed',
      securityDescriptor: {
        resourceKind: 'omniAccountBinding',
        resourceId: principal.bindingId,
        bindingId: principal.bindingId,
      },
    },
  );
};
