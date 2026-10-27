import { Logger } from '@nestjs/common';

import { type Pool, type PoolClient } from 'pg';

import { computeTwentyOrmException } from 'src/engine/twenty-orm/error-handling/compute-twenty-orm-exception.util';
import {
  type WorkspaceTransactionLifecycle,
  type WorkspaceTransactionOptions,
} from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';

const logger = new Logger('runInRollbackSafeTransaction');

export class NativeTransactionOutcomeUnknownError extends Error {
  constructor(
    readonly phase: 'commit' | 'rollback' | 'release',
    cause: unknown,
  ) {
    super(`Native transaction outcome is unknown after ${phase}`, { cause });
    this.name = 'NativeTransactionOutcomeUnknownError';
  }
}

export const runInRollbackSafeTransaction = async <T>({
  pool,
  work,
  commitOutcome = 'legacy',
}: {
  pool: Pool;
  work: (
    client: PoolClient,
    lifecycle: WorkspaceTransactionLifecycle,
  ) => Promise<T>;
} & WorkspaceTransactionOptions): Promise<T> => {
  const client = await pool.connect().catch((error: unknown) => {
    throw computeTwentyOrmException(error);
  });
  let shouldDestroyConnection = false;
  let isTransactionActive = false;
  let isReleased = false;
  let commitAttempted = false;
  const lifecycle: WorkspaceTransactionLifecycle = Object.freeze({
    get isTransactionActive() {
      return isTransactionActive;
    },
    get isReleased() {
      return isReleased;
    },
    commitOutcome,
  });

  try {
    await client.query('BEGIN');
    isTransactionActive = true;

    const result = await work(client, lifecycle);

    isTransactionActive = false;
    commitAttempted = true;
    const commitResult = await client.query('COMMIT');

    if (commitOutcome === 'strict' && commitResult.command !== 'COMMIT') {
      throw new Error('Native transaction did not confirm COMMIT');
    }

    return result;
  } catch (error) {
    isTransactionActive = false;
    if (commitOutcome === 'strict' && commitAttempted) {
      shouldDestroyConnection = true;
      throw new NativeTransactionOutcomeUnknownError('commit', error);
    }
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      shouldDestroyConnection = true;

      if (commitOutcome === 'strict') {
        throw new NativeTransactionOutcomeUnknownError('rollback', error);
      }

      logger.warn(
        `Destroying connection after failed transaction ROLLBACK: ${
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError)
        }`,
      );
    }

    throw computeTwentyOrmException(error);
  } finally {
    isTransactionActive = false;
    try {
      client.release(shouldDestroyConnection);
    } catch (error) {
      if (commitOutcome === 'strict') {
        throw new NativeTransactionOutcomeUnknownError('release', error);
      }
      throw error;
    } finally {
      isReleased = true;
    }
  }
};
