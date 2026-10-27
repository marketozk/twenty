import { isUUID } from 'class-validator';
import { type EntityManager } from 'typeorm';

import { withOmniNativeOwnershipTransaction } from 'src/modules/omnichannel/services/omni-core-transaction';

export class OmniMetadataAccountNotFoundError extends Error {
  constructor() {
    super('OMNI_METADATA_DESTINATION_ACCOUNT_NOT_FOUND');
  }
}

export const withOmniMetadataMutation = <TResult>(
  manager: EntityManager,
  workspaceId: string,
  work: (transaction: EntityManager) => Promise<TResult>,
): Promise<TResult> => {
  if (manager.queryRunner?.isTransactionActive)
    throw new Error('OMNI_METADATA_REQUIRES_FRESH_TRANSACTION');
  return withOmniNativeOwnershipTransaction(
    manager.connection,
    workspaceId,
    'shared',
    (runner) => work(runner.manager),
  );
};

export const lockOmniMetadataAccounts = async (
  manager: EntityManager,
  workspaceId: string,
  accountIds: readonly string[],
  mode: 'read' | 'write' = 'read',
): Promise<void> => {
  if (
    !manager.queryRunner?.isTransactionActive ||
    !isUUID(workspaceId) ||
    accountIds.some((id) => !isUUID(id))
  )
    throw new Error('OMNI_INVALID_METADATA_LOCK_SCOPE');
  const ids = [...new Set(accountIds.map((id) => id.toLowerCase()))].sort();
  if (ids.length === 0) return;
  const rows: { id: string }[] = await manager.query(
    `SELECT id FROM core."connectedAccount" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR ${mode === 'write' ? 'UPDATE' : 'SHARE'}`,
    [workspaceId, ids],
  );
  if (rows.length !== ids.length || rows.some((row) => !ids.includes(row.id)))
    throw new OmniMetadataAccountNotFoundError();
};

// Discover first, lock accounts in stable order, then lock and recheck the child.
// A competing reparent must not turn an old account snapshot into authorization.
export const lockOmniMetadataChannel = async (
  manager: EntityManager,
  workspaceId: string,
  channelId: string,
  destinationAccountId?: string | null,
): Promise<void> => {
  if (
    !manager.queryRunner?.isTransactionActive ||
    !isUUID(workspaceId) ||
    !isUUID(channelId)
  )
    throw new Error('OMNI_INVALID_METADATA_LOCK_SCOPE');
  const before: { connectedAccountId: string }[] = await manager.query(
    'SELECT "connectedAccountId" FROM core."messageChannel" WHERE "workspaceId"=$1 AND id=$2',
    [workspaceId, channelId],
  );
  if (before.length > 1)
    throw new Error('OMNI_INVALID_METADATA_CHANNEL_RESULT');
  await lockOmniMetadataAccounts(manager, workspaceId, [
    ...(before.length ? [before[0].connectedAccountId] : []),
    ...(destinationAccountId == null ? [] : [destinationAccountId]),
  ]);
  const after: { connectedAccountId: string }[] = await manager.query(
    'SELECT "connectedAccountId" FROM core."messageChannel" WHERE "workspaceId"=$1 AND id=$2 FOR UPDATE',
    [workspaceId, channelId],
  );
  if (
    after.length > 1 ||
    before[0]?.connectedAccountId !== after[0]?.connectedAccountId
  )
    throw new Error('OMNI_METADATA_PARENT_CHANGED_RETRY');
};
