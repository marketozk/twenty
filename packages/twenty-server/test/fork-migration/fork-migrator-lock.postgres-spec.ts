import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from 'pg';

import { runWithMigrationLock } from 'src/database/commands/fork-upgrade/fork-migrator.cli';

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;

if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
) {
  throw new Error(
    'A dedicated twenty_rob764_test_<16 hex> database is required',
  );
}

const lockKeys = [0x7477656e, 0x75706772];
const client = new Client({ connectionString: databaseUrl });
const run = (script: string) =>
  runWithMigrationLock(databaseUrl, process.execPath, ['-e', script]);

describe('whole-instance migrator lock', () => {
  beforeAll(() => client.connect());
  afterAll(() => client.end());
  afterEach(() => client.query('SELECT pg_advisory_unlock_all()'));

  it('refuses a concurrent migrator before starting its child', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fork-lock-'));
    const marker = join(directory, 'started');

    try {
      await client.query(
        'SELECT pg_advisory_lock($1::integer,$2::integer)',
        lockKeys,
      );
      await expect(
        run(`require('fs').writeFileSync(${JSON.stringify(marker)},'yes')`),
      ).rejects.toThrow('Another migrator');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('releases the lock after both a failed and a successful process', async () => {
    await expect(run('process.exit(3)')).rejects.toThrow('exited with 3');
    await expect(run('process.exit(0)')).resolves.toBeUndefined();
    const acquired = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::integer,$2::integer) AS acquired',
      lockKeys,
    );

    expect(acquired.rows[0].acquired).toBe(true);
  });

  it('terminates the child when PostgreSQL terminates the lock session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fork-lock-loss-'));
    const marker = join(directory, 'pid');
    const outcome = run(
      `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    try {
      const deadline = Date.now() + 5000;

      while (!existsSync(marker) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(existsSync(marker)).toBe(true);
      const terminated = await client.query<{ stopped: boolean }>(
        `SELECT pg_terminate_backend(pid) AS stopped FROM pg_locks
          WHERE locktype='advisory' AND classid=$1 AND objid=$2
            AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
            AND granted AND pid<>pg_backend_pid()`,
        lockKeys,
      );

      expect(terminated.rows).toEqual([{ stopped: true }]);
      expect(await outcome).toBeInstanceOf(Error);
      const childPid = Number(readFileSync(marker, 'utf8'));

      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_locks
          WHERE locktype='advisory' AND classid=$1 AND objid=$2
            AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
            AND granted AND pid<>pg_backend_pid()`,
        lockKeys,
      );
      await outcome;
      rmSync(directory, { recursive: true });
    }
  });
});
