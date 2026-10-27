import { type Pool, type PoolClient } from 'pg';

import { POSTGRESQL_ERROR_CODES } from 'src/engine/api/graphql/workspace-query-runner/constants/postgres-error-codes.constants';
import {
  NativeTransactionOutcomeUnknownError,
  runInRollbackSafeTransaction,
} from 'src/engine/twenty-orm/datasource/utils/run-in-rollback-safe-transaction.util';
import { type WorkspaceTransactionLifecycle } from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';
import {
  TwentyOrmException,
  TwentyOrmExceptionCode,
} from 'src/engine/twenty-orm/exceptions/twenty-orm.exception';

const buildClient = () => ({
  query: jest.fn().mockResolvedValue({ rows: [], command: 'COMMIT' }),
  release: jest.fn(),
});

const buildPool = (client: ReturnType<typeof buildClient>): Pool =>
  ({
    connect: jest.fn().mockResolvedValue(client as unknown as PoolClient),
  }) as unknown as Pool;

describe('runInRollbackSafeTransaction', () => {
  it('exposes immutable lifecycle getters that close before COMMIT and release', async () => {
    const client = buildClient();
    let captured: WorkspaceTransactionLifecycle | undefined;

    client.query.mockImplementation(async (statement: string) => {
      if (statement === 'COMMIT') {
        expect(captured?.isTransactionActive).toBe(false);
        expect(captured?.isReleased).toBe(false);
      }

      return { rows: [], command: statement };
    });

    await runInRollbackSafeTransaction({
      pool: buildPool(client),
      commitOutcome: 'strict',
      work: async (_client, lifecycle) => {
        captured = lifecycle;
        expect(Object.isFrozen(lifecycle)).toBe(true);
        expect(lifecycle.isTransactionActive).toBe(true);
        expect(lifecycle.isReleased).toBe(false);
        expect(lifecycle.commitOutcome).toBe('strict');
      },
    });

    expect(captured?.isTransactionActive).toBe(false);
    expect(captured?.isReleased).toBe(true);
  });

  it('strict COMMIT failure is unknown and destroys the connection without ROLLBACK', async () => {
    const client = buildClient();
    const commitError = Object.assign(new Error('connection lost'), {
      code: POSTGRESQL_ERROR_CODES.CONNECTION_FAILURE,
    });

    client.query.mockImplementation(async (statement: string) => {
      if (statement === 'COMMIT') throw commitError;

      return { rows: [] };
    });

    const error = await runInRollbackSafeTransaction({
      pool: buildPool(client),
      commitOutcome: 'strict',
      work: async () => 'must not return',
    }).catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(NativeTransactionOutcomeUnknownError);
    expect(error).toMatchObject({ phase: 'commit', cause: commitError });
    expect(client.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('strict COMMIT returning ROLLBACK cannot acknowledge a swallowed SQL failure', async () => {
    const client = buildClient();

    client.query.mockResolvedValue({ rows: [], command: 'ROLLBACK' });

    await expect(
      runInRollbackSafeTransaction({
        pool: buildPool(client),
        commitOutcome: 'strict',
        work: async () => 'not saved',
      }),
    ).rejects.toMatchObject({ phase: 'commit' });
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('strict pre-COMMIT work failure rolls back and preserves the ordinary error', async () => {
    const client = buildClient();
    const workError = new Error('audit flush rejected');

    await expect(
      runInRollbackSafeTransaction({
        pool: buildPool(client),
        commitOutcome: 'strict',
        work: async () => {
          throw workError;
        },
      }),
    ).rejects.toBe(workError);

    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('strict ROLLBACK failure cannot be mistaken for a confirmed rollback', async () => {
    const client = buildClient();
    const workError = new Error('work failed');

    client.query.mockImplementation(async (statement: string) => {
      if (statement === 'ROLLBACK') throw new Error('connection lost');

      return { rows: [] };
    });

    await expect(
      runInRollbackSafeTransaction({
        pool: buildPool(client),
        commitOutcome: 'strict',
        work: async () => {
          throw workError;
        },
      }),
    ).rejects.toMatchObject({ phase: 'rollback', cause: workError });

    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('strict release failure after COMMIT is unknown and closes the lifecycle', async () => {
    const client = buildClient();
    const releaseError = new Error('release failed');
    let captured: WorkspaceTransactionLifecycle | undefined;

    client.release.mockImplementation(() => {
      throw releaseError;
    });

    await expect(
      runInRollbackSafeTransaction({
        pool: buildPool(client),
        commitOutcome: 'strict',
        work: async (_client, lifecycle) => {
          captured = lifecycle;
        },
      }),
    ).rejects.toMatchObject({ phase: 'release', cause: releaseError });

    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
    expect(captured?.isTransactionActive).toBe(false);
    expect(captured?.isReleased).toBe(true);
  });

  it('should map a transient failure raised while acquiring the connection', async () => {
    const connectionError = Object.assign(
      new Error('too many clients already'),
      { code: POSTGRESQL_ERROR_CODES.TOO_MANY_CONNECTIONS },
    );
    const pool = {
      connect: jest.fn().mockRejectedValue(connectionError),
    } as unknown as Pool;

    const error = await runInRollbackSafeTransaction({
      pool,
      work: async () => 'never runs',
    }).catch((thrownError: Error) => thrownError);

    expect(error).toBeInstanceOf(TwentyOrmException);
    expect((error as TwentyOrmException).code).toBe(
      TwentyOrmExceptionCode.TRANSIENT_DATABASE_ERROR,
    );
  });

  it('should wrap the work in BEGIN/COMMIT and release the client reusable', async () => {
    const client = buildClient();

    const result = await runInRollbackSafeTransaction({
      pool: buildPool(client),
      work: async () => 'done',
    });

    expect(result).toBe('done');
    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenNthCalledWith(2, 'COMMIT');
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('should roll back and rethrow the work error', async () => {
    const client = buildClient();
    const workError = new Error('work failed');

    await expect(
      runInRollbackSafeTransaction({
        pool: buildPool(client),
        work: async () => {
          throw workError;
        },
      }),
    ).rejects.toBe(workError);

    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('should rethrow the original error, not the rollback error, when ROLLBACK also fails', async () => {
    const client = buildClient();

    client.query.mockImplementation((statement: string) =>
      statement === 'ROLLBACK'
        ? Promise.reject(new Error('Query read timeout'))
        : Promise.resolve({ rows: [] }),
    );
    const workError = new Error('original failure');

    await expect(
      runInRollbackSafeTransaction({
        pool: buildPool(client),
        work: async () => {
          throw workError;
        },
      }),
    ).rejects.toBe(workError);
  });

  it('should destroy the connection instead of pooling it when ROLLBACK fails', async () => {
    const client = buildClient();

    client.query.mockImplementation((statement: string) =>
      statement === 'ROLLBACK'
        ? Promise.reject(new Error('Query read timeout'))
        : Promise.resolve({ rows: [] }),
    );

    await expect(
      runInRollbackSafeTransaction({
        pool: buildPool(client),
        work: async () => {
          throw new Error('original failure');
        },
      }),
    ).rejects.toThrow('original failure');

    expect(client.release).toHaveBeenCalledWith(true);
  });

  it.each([
    POSTGRESQL_ERROR_CODES.IDLE_IN_TRANSACTION_SESSION_TIMEOUT,
    POSTGRESQL_ERROR_CODES.CONNECTION_FAILURE,
    POSTGRESQL_ERROR_CODES.DEADLOCK_DETECTED,
  ])(
    'should surface the transient postgres failure %s raised at COMMIT as TRANSIENT_DATABASE_ERROR',
    async (code) => {
      const client = buildClient();
      const commitError = Object.assign(
        new Error('terminating connection due to idle-in-transaction timeout'),
        { code },
      );

      client.query.mockImplementation((statement: string) =>
        statement === 'COMMIT'
          ? Promise.reject(commitError)
          : Promise.resolve({ rows: [] }),
      );

      const error = await runInRollbackSafeTransaction({
        pool: buildPool(client),
        work: async () => 'done',
      }).catch((thrownError: Error) => thrownError);

      expect(error).toBeInstanceOf(TwentyOrmException);
      expect((error as TwentyOrmException).code).toBe(
        TwentyOrmExceptionCode.TRANSIENT_DATABASE_ERROR,
      );
      expect((error as Error & { cause?: Error }).cause).toBe(commitError);
    },
  );

  it('should still surface the original transient failure as TRANSIENT_DATABASE_ERROR when ROLLBACK also fails', async () => {
    const client = buildClient();
    const workError = Object.assign(
      new Error('terminating connection due to administrator command'),
      { code: POSTGRESQL_ERROR_CODES.ADMIN_SHUTDOWN },
    );

    client.query.mockImplementation((statement: string) =>
      statement === 'ROLLBACK'
        ? Promise.reject(new Error('Connection terminated unexpectedly'))
        : Promise.resolve({ rows: [] }),
    );

    const error = await runInRollbackSafeTransaction({
      pool: buildPool(client),
      work: async () => {
        throw workError;
      },
    }).catch((thrownError: Error) => thrownError);

    expect((error as TwentyOrmException).code).toBe(
      TwentyOrmExceptionCode.TRANSIENT_DATABASE_ERROR,
    );
    expect((error as Error & { cause?: Error }).cause).toBe(workError);
  });

  it('should rethrow a BEGIN failure and release the client reusable when ROLLBACK succeeds', async () => {
    const client = buildClient();
    const beginError = new Error('BEGIN failed');

    client.query.mockImplementation((statement: string) =>
      statement === 'BEGIN'
        ? Promise.reject(beginError)
        : Promise.resolve({ rows: [] }),
    );
    const work = jest.fn();

    await expect(
      runInRollbackSafeTransaction({ pool: buildPool(client), work }),
    ).rejects.toBe(beginError);

    expect(work).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('should roll back when COMMIT fails and release the client reusable', async () => {
    const client = buildClient();
    const commitError = new Error('COMMIT failed');

    client.query.mockImplementation((statement: string) =>
      statement === 'COMMIT'
        ? Promise.reject(commitError)
        : Promise.resolve({ rows: [] }),
    );

    await expect(
      runInRollbackSafeTransaction({
        pool: buildPool(client),
        work: async () => 'done',
      }),
    ).rejects.toBe(commitError);

    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledWith(false);
  });
});
