import { AsyncLocalStorage } from 'node:async_hooks';
import { isUUID } from 'class-validator';

import { withCrmAuditIdentity } from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { systemMembershipCleanupIdentity } from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { getRegisteredWorkspaceCommandMetadata } from 'src/engine/core-modules/upgrade/decorators/registered-workspace-command.decorator';

const storage = new AsyncLocalStorage<
  { workspaceId: string; consumed: boolean; active: boolean } | undefined
>();

// Execution identity, not the migration cursor: the historical command stays unchanged.
export const withAccountScopeRepairExecution = async <T>(
  command: object,
  workspaceId: string,
  work: () => Promise<T>,
): Promise<T> => {
  const metadata = getRegisteredWorkspaceCommandMetadata(command.constructor);
  if (metadata?.version !== '2.51.0' || metadata.timestamp !== 1792675225627)
    return storage.run(undefined, work);
  if (!isUUID(workspaceId))
    throw new Error('Invalid account scope repair workspace');
  const scope = {
    workspaceId: workspaceId.toLowerCase(),
    consumed: false,
    active: true,
  };
  try {
    return await storage.run(scope, () =>
      withCrmAuditIdentity(
        scope.workspaceId,
        systemMembershipCleanupIdentity(
          scope.workspaceId,
          'DeleteConnectedAccountsOutsideProviderScopeCommand',
        ),
        work,
      ),
    );
  } finally {
    scope.active = false;
  }
};

// Consume before any provider hook can inherit the asynchronous execution context.
export const consumeAccountScopeRepairExecution = (
  workspaceId: string,
): boolean => {
  const scope = storage.getStore();
  if (!scope) return false;
  if (
    !scope.active ||
    scope.consumed ||
    scope.workspaceId !== workspaceId.toLowerCase()
  )
    throw new Error('Account scope repair execution is unavailable');
  scope.consumed = true;
  return true;
};
