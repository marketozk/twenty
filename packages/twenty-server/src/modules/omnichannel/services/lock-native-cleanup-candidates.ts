import { isUUID } from 'class-validator';
import { type WorkspaceTransactionLifecycle } from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';

type CleanupScope = {
  workspaceId: string;
  transactionLifecycle?: WorkspaceTransactionLifecycle;
  executeRawQuery: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
};
export const lockNativeCleanupCandidates = async (
  scope: CleanupScope,
  table:
    | 'messageThread'
    | 'message'
    | 'calendarEvent'
    | 'messageChannelMessageAssociation'
    | 'calendarChannelEventAssociation',
  inputIds: readonly string[],
): Promise<void> => {
  const ids = [...new Set(inputIds.map((id) => id.toLowerCase()))].sort();
  if (
    !scope.transactionLifecycle?.isTransactionActive ||
    scope.transactionLifecycle.isReleased
  )
    throw new Error('NATIVE_CLEANUP_REQUIRES_ACTIVE_TRANSACTION');
  if (
    !isUUID(scope.workspaceId) ||
    !ids.every((id) => isUUID(id)) ||
    ![
      'messageThread',
      'message',
      'calendarEvent',
      'messageChannelMessageAssociation',
      'calendarChannelEventAssociation',
    ].includes(table)
  )
    throw new Error('NATIVE_CLEANUP_INVALID_SCOPE');
  if (!ids.length) return;
  const schema = `workspace_${BigInt(`0x${scope.workspaceId.replaceAll('-', '')}`).toString(36)}`;
  await scope.executeRawQuery(
    `SELECT id FROM "${schema}"."${table}" WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [ids],
  );
};
