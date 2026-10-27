import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { appendCrmAuditAttempt } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import {
  type OmniBindingConfigRecoveryCommand,
  type OmniBindingConfigWakeupPrincipal,
  type OmniBindingConfigWakeupScope,
} from 'src/modules/omnichannel/services/omni-binding-config-wakeup';

const operationSchema = z.enum([
  'claim',
  'process',
  'reconcile',
  'rearm',
  'housekeeping',
]);

export const appendOmniBindingConfigWakeupFailure = async (
  scope: OmniBindingConfigWakeupScope,
  principal: OmniBindingConfigWakeupPrincipal,
  operationId: string,
  operation: OmniBindingConfigRecoveryCommand['operation'],
  denied: boolean,
): Promise<void> => {
  const action = operationSchema.parse(operation);
  const executor = createCrmAuditWorkspaceExecutor(scope);

  if (scope.workspaceId !== principal.workspaceId)
    throw new Error('OMNI_CONFIG_WAKEUP_FAILURE_AUDIT_WORKSPACE_MISMATCH');

  const rows = z.array(z.object({ id: z.uuid() })).parse(
    await executor.query(
      `SELECT binding.id FROM core."omniAccountBinding" binding
       JOIN core."omniWorkspacePolicyState" policy ON policy."workspaceId"=binding."workspaceId"
       WHERE binding."workspaceId"=$1 AND binding.id=$2`,
      [principal.workspaceId, principal.bindingId],
    ),
  );

  if (rows.length === 0) return;
  if (rows.length !== 1 || rows[0].id !== principal.bindingId)
    throw new Error('OMNI_CONFIG_WAKEUP_FAILURE_AUDIT_AMBIGUOUS_BINDING');

  await appendCrmAuditAttempt(
    executor,
    { workspaceId: principal.workspaceId, operationId, actor: principal.actor },
    {
      attemptId: randomUUID(),
      resourceKind: 'omniAccountBinding',
      resourceId: principal.bindingId,
      action: 'update',
      outcome: denied ? 'denied' : 'failed',
      reasonCode: `config_wakeup.${action}.${denied ? 'denied' : 'failed'}`,
      securityDescriptor: {
        resourceKind: 'omniAccountBinding',
        resourceId: principal.bindingId,
        bindingId: principal.bindingId,
      },
    },
  );
};
