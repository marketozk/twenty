import { spawn, type ChildProcess } from 'node:child_process';

import { Client } from 'pg';

const MIGRATOR_LOCK = [0x7477656e, 0x75706772];

export const runWithMigrationLock = async (
  databaseUrl: string,
  command: string,
  args: string[],
): Promise<void> => {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10000,
    ssl:
      process.env.PG_SSL_ALLOW_SELF_SIGNED === 'true'
        ? { rejectUnauthorized: false }
        : undefined,
  });
  let child: ChildProcess | undefined;
  let failure: Error | undefined;
  let closing = false;

  const stopChild = () => {
    if (child?.pid) {
      try {
        // A lost lock must also stop the shell's child processes.
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error;
        }
      }
    }
  };
  const abort = (error: Error) => {
    failure ??= error;
    stopChild();
  };
  const onSignal = () => abort(new Error('Migrator interrupted'));
  const onConnectionEnd = () => {
    if (!closing) {
      abort(new Error('Migrator lock connection closed'));
    }
  };

  client.on('error', abort);
  client.on('end', onConnectionEnd);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await client.connect();
    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired',
      MIGRATOR_LOCK,
    );

    if (!lock.rows[0].acquired) {
      throw new Error('Another migrator holds the instance upgrade lock');
    }

    const databaseState = await client.query<{ state: string }>(
      `SELECT CASE
        WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'core') THEN 'existing'
        WHEN EXISTS (SELECT 1 FROM pg_namespace
          WHERE nspname NOT IN ('public', 'information_schema') AND nspname !~ '^pg_')
          OR EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')) THEN 'partial'
        ELSE 'fresh' END AS state`,
    );

    if (databaseState.rows[0].state === 'partial') {
      throw new Error(
        'Database has objects but no core schema; initialization refused',
      );
    }

    if (failure) {
      throw failure;
    }

    await new Promise<void>((resolve, reject) => {
      child = spawn(command, args, {
        stdio: 'inherit',
        detached: true,
        env: {
          ...process.env,
          TWENTY_MIGRATION_DATABASE_STATE: databaseState.rows[0].state,
        },
      });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        child = undefined;
        if (failure) {
          reject(failure);
        } else if (code !== 0) {
          reject(new Error(`Migrator exited with ${signal ?? code}`));
        } else {
          resolve();
        }
      });
    });

    if (failure) {
      throw failure;
    }
  } finally {
    closing = true;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await client.end();
  }
};

if (require.main === module) {
  const databaseUrl = process.env.PG_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('PG_DATABASE_URL is required');
  }

  runWithMigrationLock(databaseUrl, 'sh', [
    '/app/omnichannel/migrate.sh',
  ]).catch((error: unknown) => {
    // oxlint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : 'Migrator failed');
    process.exitCode = 1;
  });
}
