import { type EntityManager } from 'typeorm';
import {
  lockOmniMetadataAccounts,
  OmniMetadataAccountNotFoundError,
} from 'src/modules/omnichannel/services/omni-metadata-transaction';
import { findOmniOwnedConnectedAccountIds } from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';

export class OrdinaryProviderAccountChangedError extends Error {
  constructor() {
    super('CONNECTED_ACCOUNT_CHANGED_RETRY_AUTHORIZATION');
  }
}

// The caller owns the shared workspace fence before taking any row locks.
export const lockOrdinaryProviderAccount = async (
  manager: EntityManager,
  workspaceId: string,
  accountId: string,
): Promise<void> => {
  try {
    await lockOmniMetadataAccounts(manager, workspaceId, [accountId], 'write');
  } catch (error) {
    if (error instanceof OmniMetadataAccountNotFoundError)
      throw new OrdinaryProviderAccountChangedError();
    throw error;
  }
  const owned = await findOmniOwnedConnectedAccountIds(
    { executeRawQuery: (sql, parameters) => manager.query(sql, parameters) },
    workspaceId,
    [accountId],
  );
  if (owned.size) throw new OrdinaryProviderAccountChangedError();
};
