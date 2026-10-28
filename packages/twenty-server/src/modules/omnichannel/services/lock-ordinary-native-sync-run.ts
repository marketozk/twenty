import { isUUID } from 'class-validator';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
import { findOmniOwnedConnectedAccountIds } from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';

type NativeSyncScope = {
  workspaceId: string;
  transactionLifecycle?: {
    readonly isTransactionActive: boolean;
    readonly isReleased: boolean;
    readonly commitOutcome: 'strict' | 'legacy';
  };
  executeRawQuery: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
};

// The native transaction already holds the shared ownership fence before this callback.
export const lockOrdinaryNativeSyncRun = async (
  scope: NativeSyncScope,
  run: OrdinaryMetadataSyncRun,
): Promise<boolean> => {
  run = { ...run };
  if (
    !scope.transactionLifecycle?.isTransactionActive ||
    scope.transactionLifecycle.isReleased ||
    scope.transactionLifecycle.commitOutcome !== 'strict'
  )
    throw new Error('ORDINARY_SYNC_APPLY_REQUIRES_ACTIVE_STRICT_TRANSACTION');
  if (
    scope.workspaceId !== run.workspaceId ||
    ![run.workspaceId, run.channelId, run.connectedAccountId].every((id) =>
      isUUID(id),
    ) ||
    !['message', 'calendar'].includes(run.kind) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(run.startedAt)
  )
    throw new Error('ORDINARY_SYNC_APPLY_INVALID_PROOF');
  const accounts = await scope.executeRawQuery(
    'SELECT id,provider,"applicationId","connectionProviderId" FROM core."connectedAccount" WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
    [run.workspaceId, run.connectedAccountId],
  );
  const table = run.kind === 'message' ? 'messageChannel' : 'calendarChannel';
  const channels = await scope.executeRawQuery(
    `SELECT "connectedAccountId","isSyncEnabled","syncStage", "syncStageStartedAt"=$3::timestamptz AS "sameRun" FROM core."${table}" WHERE "workspaceId"=$1 AND id=$2 FOR UPDATE`,
    [run.workspaceId, run.channelId, run.startedAt],
  );
  const account = accounts[0],
    channel = channels[0];
  if (
    !account ||
    !channel ||
    channel.connectedAccountId !== run.connectedAccountId ||
    channel.isSyncEnabled !== true ||
    channel.syncStage !== run.stage ||
    channel.sameRun !== true ||
    (account.provider === 'app' &&
      account.applicationId === null &&
      account.connectionProviderId === null)
  )
    return false;
  const owned = await findOmniOwnedConnectedAccountIds(scope, run.workspaceId, [
    run.connectedAccountId,
  ]);
  return owned.size === 0;
};
