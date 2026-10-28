import { type PoolClient } from 'pg';
import { type DataSource, type QueryRunner } from 'typeorm';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

export class CoreAuditPostCommitError extends Error {
  readonly commitConfirmed = true;
  constructor(cause: unknown) {
    super('Core audit transaction committed but its postcommit hook failed', {
      cause,
    });
    this.name = 'CoreAuditPostCommitError';
  }
}

// Pinned PostgreSQL QueryRunner adapter. Unlike release(), this removes a broken
// connection from the pool and also unregisters the runner from TypeORM.
type PostgreSqlAuditRunner = QueryRunner & {
  releasePostgresConnection: (error?: Error) => Promise<void>;
};

export const runInCoreAuditTransaction = async <T>(
  dataSource: DataSource,
  work: (runner: QueryRunner) => Promise<T>,
): Promise<T> => {
  if (dataSource.options.type !== 'postgres')
    throw new Error('Core audit requires PostgreSQL');
  const runner = dataSource.createQueryRunner(
    'master',
  ) as PostgreSqlAuditRunner;
  if (typeof runner.releasePostgresConnection !== 'function')
    throw new Error(
      'Core audit requires the pinned PostgreSQL release contract',
    );
  const originalQuery = runner.query;
  let commitAttempted = false;
  let commitConfirmed = false;
  let destroyConnection = false;
  let failure: unknown;

  try {
    const client: PoolClient = await runner.connect();
    const query = originalQuery.bind(runner);
    runner.query = async (
      sql: string,
      parameters?: unknown[],
      structured?: true,
    ) => {
      if (sql !== 'COMMIT')
        return structured
          ? query(sql, parameters, true)
          : query(sql, parameters);
      commitAttempted = true;
      const result = await client.query('COMMIT');
      if (result.command !== 'COMMIT')
        throw new Error('Core audit transaction did not confirm COMMIT');
      commitConfirmed = true;
      return structured
        ? { records: result.rows, raw: result.rows, affected: result.rowCount }
        : result.rows;
    };
    await runner.startTransaction();
    const result = await work(runner);
    await runner.commitTransaction();
    return result;
  } catch (error) {
    failure = error;
    if (commitAttempted && !commitConfirmed) {
      destroyConnection = true;
      failure = new NativeTransactionOutcomeUnknownError('commit', error);
      throw failure;
    }
    if (!commitConfirmed && runner.isTransactionActive) {
      try {
        await runner.rollbackTransaction();
      } catch (rollbackError) {
        destroyConnection = true;
        failure = new NativeTransactionOutcomeUnknownError(
          'rollback',
          new AggregateError(
            [error, rollbackError],
            'Core audit rollback failed',
          ),
        );
      }
    }
    if (commitConfirmed) failure = new CoreAuditPostCommitError(error);
    throw failure;
  } finally {
    runner.query = originalQuery;
    try {
      await runner.releasePostgresConnection(
        destroyConnection
          ? new Error('Discard uncertain core audit connection')
          : undefined,
      );
    } catch (releaseError) {
      throw new NativeTransactionOutcomeUnknownError(
        'release',
        new AggregateError(
          [failure, releaseError],
          'Core audit release failed',
        ),
      );
    }
  }
};
