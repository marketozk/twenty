import { type Pool } from 'pg';

import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/datasource/utils/run-in-rollback-safe-transaction.util';
import { WorkspaceDataSource } from 'src/engine/twenty-orm/datasource/workspace-data-source';
import { type WorkspaceInternalContext } from 'src/engine/twenty-orm/interfaces/workspace-internal-context.interface';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';

const fixture = () => {
  const client = {
    query: jest
      .fn()
      .mockResolvedValue({ rows: [{ value: 1 }], command: 'COMMIT' }),
    release: jest.fn(),
  };
  const pool = {
    connect: jest.fn().mockResolvedValue(client),
    query: jest.fn(),
  };
  const dataSource = new WorkspaceDataSource({
    pool: pool as unknown as Pool,
    internalContext: {
      workspaceId: '61c65668-1496-45b8-9375-a39902342677',
      eventEmitterService: { emitDatabaseBatchEvent: jest.fn() },
      recordStock: {},
    } as unknown as WorkspaceInternalContext,
    authContext: {} as WorkspaceAuthContext,
    objectPermissionsByRoleId: {},
  });

  return { client, pool, dataSource };
};

describe('WorkspaceDataSource strict transactions', () => {
  it('uses the client for raw writes and closes retained scope before callbacks', async () => {
    const { client, pool, dataSource } = fixture();
    const afterCommit = jest.fn();
    let captured: WorkspaceTransactionScope | undefined;

    const result = await dataSource.transaction(
      async (scope) => {
        captured = scope;
        expect(scope.transactionLifecycle?.commitOutcome).toBe('strict');
        expect(scope.transactionLifecycle?.isTransactionActive).toBe(true);
        scope.afterCommit(afterCommit);

        return scope.executeRawQuery('SELECT $1 AS value', [1]);
      },
      { commitOutcome: 'strict' },
    );

    expect(result).toEqual([{ value: 1 }]);
    expect(client.query).toHaveBeenCalledWith({
      text: 'SELECT $1 AS value',
      values: [1],
    });
    expect(pool.query).not.toHaveBeenCalled();
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(captured?.transactionLifecycle?.isTransactionActive).toBe(false);
    expect(captured?.transactionLifecycle?.isReleased).toBe(true);
    await expect(captured?.executeRawQuery('SELECT 2')).rejects.toThrow(
      'Workspace transaction is no longer active',
    );
    expect(() => captured?.getRepository('message')).toThrow(
      'Workspace transaction is no longer active',
    );
    expect(() => captured?.afterCommit(jest.fn())).toThrow(
      'Workspace transaction is no longer active',
    );
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
  });

  it.each(['commit', 'release'])(
    'does not emit after-commit callbacks on unknown %s outcome',
    async (phase) => {
      const { client, dataSource } = fixture();
      const callback = jest.fn();

      if (phase === 'commit') {
        client.query.mockImplementation(async (statement: unknown) => {
          if (statement === 'COMMIT') throw new Error('lost ACK');

          return { rows: [] };
        });
      } else {
        client.release.mockImplementation(() => {
          throw new Error('release failed');
        });
      }

      await expect(
        dataSource.transaction(
          async (scope) => {
            scope.afterCommit(callback);

            return 'not acknowledged';
          },
          { commitOutcome: 'strict' },
        ),
      ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
      expect(callback).not.toHaveBeenCalled();
    },
  );

  it('preserves the legacy default for upstream callers', async () => {
    const { dataSource } = fixture();

    await dataSource.transaction(async (scope) => {
      expect(scope.transactionLifecycle?.commitOutcome).toBe('legacy');
    });
  });
});
