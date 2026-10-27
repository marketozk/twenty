import { isUUID } from 'class-validator';

export type OmniNativeOwnershipQuery = {
  executeRawQuery: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
};

// Ownership can first appear during binding bootstrap, when no policy row exists
// yet. Shared native writes and exclusive enrollment/domain apply therefore fence
// on a transaction advisory lock before policy/record locks. Hash collisions only
// serialize unrelated work; they cannot grant access. Never acquire after row locks.
export const lockOmniNativeOwnership = async (
  query: OmniNativeOwnershipQuery,
  workspaceId: string,
  mode: 'shared' | 'exclusive',
): Promise<void> => {
  if (!isUUID(workspaceId))
    throw new Error('OMNI_INVALID_NATIVE_OWNERSHIP_SCOPE');
  const lock =
    mode === 'shared'
      ? 'pg_advisory_xact_lock_shared'
      : 'pg_advisory_xact_lock';
  await query.executeRawQuery(`SELECT ${lock}(hashtextextended($1, 0))`, [
    `twenty:omni-native:${workspaceId.toLowerCase()}`,
  ]);
};
