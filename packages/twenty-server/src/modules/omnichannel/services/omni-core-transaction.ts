import { isUUID } from 'class-validator';
import { type DataSource, type QueryRunner } from 'typeorm';
import { lockOmniNativeOwnership } from 'src/modules/omnichannel/services/lock-omni-native-ownership';

export class OmniCoreTransactionOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super('OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN', { cause });
    this.name = 'OmniCoreTransactionOutcomeUnknownError';
  }
}

export const withOmniNativeOwnershipTransaction = async <TResult>(
  dataSource: DataSource,
  workspaceId: string,
  mode: 'shared' | 'exclusive',
  work: (runner: QueryRunner) => Promise<TResult>,
): Promise<TResult> => {
  if (!isUUID(workspaceId))
    throw new Error('OMNI_INVALID_CORE_TRANSACTION_SCOPE');
  const runner = dataSource.createQueryRunner('master');
  const discard = (
    runner as QueryRunner & {
      releasePostgresConnection?: (error: Error) => Promise<void>;
    }
  ).releasePostgresConnection;
  if (typeof discard !== 'function')
    throw new Error('OMNI_POSTGRES_LIFECYCLE_RUNNER_REQUIRED');
  let result!: TResult;
  let failure: unknown;
  let failed = false;
  let commitAttempted = false;
  let destroyConnection = false;
  try {
    await runner.connect();
    await runner.startTransaction('READ COMMITTED');
    await lockOmniNativeOwnership(
      { executeRawQuery: (sql, parameters) => runner.query(sql, parameters) },
      workspaceId,
      mode,
    );
    result = await work(runner);
    commitAttempted = true;
    await runner.commitTransaction();
  } catch (error) {
    failed = true;
    failure = error;
    destroyConnection = commitAttempted;
  } finally {
    if (runner.isTransactionActive && !destroyConnection) {
      try {
        await runner.rollbackTransaction();
      } catch (error) {
        failure = failed
          ? new AggregateError(
              [failure, error],
              'OMNI_CORE_ROLLBACK_UNCONFIRMED',
            )
          : error;
        failed = true;
        destroyConnection = true;
      }
    }
    // The Postgres runner removes itself from TypeORM's active list and passes
    // the error to pg.release; uncertain connections must never re-enter the pool.
    try {
      if (destroyConnection)
        await discard.call(
          runner,
          new Error('OMNI_CORE_TRANSACTION_UNCONFIRMED'),
        );
      else await runner.release();
    } catch (error) {
      failure = failed
        ? new AggregateError([failure, error], 'OMNI_CORE_RELEASE_FAILED')
        : error;
      failed = true;
    }
  }
  if (failed)
    throw commitAttempted
      ? new OmniCoreTransactionOutcomeUnknownError(failure)
      : failure;
  return result;
};
