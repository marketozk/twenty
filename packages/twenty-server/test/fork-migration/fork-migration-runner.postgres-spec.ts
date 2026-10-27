import { createHash } from 'node:crypto';

import { DataSource, type QueryRunner } from 'typeorm';

import { ForkMigrationRunner } from 'src/database/commands/fork-upgrade/fork-migration-runner';
import { type ForkMigration } from 'src/database/commands/fork-upgrade/fork-migration.type';
import { ForkSchemaVerifier } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-verifier';

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;

if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
) {
  throw new Error(
    'A dedicated twenty_rob764_test_<16 hex> database is required',
  );
}

const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  migrationsRun: false,
  extra: { max: 4, statement_timeout: 10000 },
});

const checksum = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const createMigration = (suffix = 'one'): ForkMigration => {
  const tableName = suffix === 'one' ? 'fixtureOne' : 'fixtureTwo';

  return {
    kind: 'fork',
    migrationId: `omni-test-${suffix}`,
    checksum: checksum(suffix),
    command: {
      up: async (queryRunner: QueryRunner) => {
        await queryRunner.query(
          `CREATE TABLE core."${tableName}" (id integer PRIMARY KEY)`,
        );
        await queryRunner.query(`INSERT INTO core."${tableName}" VALUES (1)`);
      },
      down: async (queryRunner: QueryRunner) => {
        await queryRunner.query(`DROP TABLE core."${tableName}"`);
      },
    },
    verify: async (queryRunner: QueryRunner) => {
      await queryRunner.query(`SELECT id FROM core."${tableName}" LIMIT 0`);
    },
  };
};

const runner = (migrations = [createMigration()]) =>
  new ForkMigrationRunner(dataSource, migrations);

const verifier = (migrations = [createMigration()]) =>
  new ForkSchemaVerifier(dataSource, migrations);

beforeAll(async () => {
  await dataSource.initialize();
});

beforeEach(async () => {
  await dataSource.query('DROP SCHEMA IF EXISTS core CASCADE');
  await dataSource.query('CREATE SCHEMA core');
});

afterAll(async () => {
  if (dataSource.isInitialized) {
    await dataSource.destroy();
  }
});

describe('fork migration transactions on PostgreSQL', () => {
  it('applies once, verifies schema, and preserves existing application data', async () => {
    await dataSource.query('CREATE TABLE core.existing (id integer)');
    await dataSource.query('INSERT INTO core.existing VALUES (42)');

    expect(await runner().apply()).toEqual(['omni-test-one']);
    expect(await runner().apply()).toEqual([]);
    await expect(verifier().verifyReady()).resolves.toBeUndefined();
    expect(await dataSource.query('SELECT * FROM core.existing')).toEqual([
      { id: 42 },
    ]);
    expect(await dataSource.query('SELECT * FROM core."fixtureOne"')).toEqual([
      { id: 1 },
    ]);
  });

  it('applies a new step without changing an already advanced upstream cursor', async () => {
    await dataSource.query('CREATE TABLE core."upstreamFixture" (cursor text)');
    await dataSource.query('INSERT INTO core."upstreamFixture" VALUES ($1)', [
      '2.52/workspace-completed',
    ]);
    await runner().apply();

    const extendedRunner = runner([createMigration(), createMigration('two')]);

    await expect(
      verifier([createMigration(), createMigration('two')]).verifyReady(),
    ).rejects.toThrow('Pending fork migrations');
    expect(await extendedRunner.apply()).toEqual(['omni-test-two']);
    expect(
      await dataSource.query('SELECT * FROM core."upstreamFixture"'),
    ).toEqual([{ cursor: '2.52/workspace-completed' }]);
  });

  it('rolls back DDL and ledger bootstrap on a failure before recording success', async () => {
    const migration = createMigration();

    await expect(
      runner([
        {
          ...migration,
          verify: async () => {
            throw new Error('injected-after-DDL');
          },
        },
      ]).apply(),
    ).rejects.toThrow('injected-after-DDL');
    expect(
      await dataSource.query(
        `SELECT to_regclass('core."fixtureOne"') AS fixture,
                to_regclass('core."forkMigrationLedger"') AS ledger`,
      ),
    ).toEqual([{ fixture: null, ledger: null }]);
    expect(await runner().apply()).toEqual(['omni-test-one']);
  });

  it('supplies the exact validated schema prefix before and after an additive upgrade', async () => {
    const observations: { migrationId: string; prefix: readonly string[] }[] =
      [];
    const first = createMigration();
    const second = createMigration('two');
    const firstWithVersionedCheck: ForkMigration = {
      ...first,
      verify: async (queryRunner, appliedMigrationIds = []) => {
        observations.push({
          migrationId: first.migrationId,
          prefix: appliedMigrationIds,
        });
        expect(Object.isFrozen(appliedMigrationIds)).toBe(true);
        const [{ exists }]: { exists: boolean }[] = await queryRunner.query(
          `SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'core' AND table_name = 'fixtureOne'
              AND column_name = 'newColumn'
          ) AS exists`,
        );

        expect(exists).toBe(appliedMigrationIds.includes(second.migrationId));
      },
    };
    const secondWithVersionedCheck: ForkMigration = {
      ...second,
      command: {
        ...second.command,
        up: async (queryRunner) => {
          await second.command.up(queryRunner);
          await queryRunner.query(
            'ALTER TABLE core."fixtureOne" ADD COLUMN "newColumn" text',
          );
        },
      },
      verify: async (queryRunner, appliedMigrationIds = []) => {
        observations.push({
          migrationId: second.migrationId,
          prefix: appliedMigrationIds,
        });
        expect(Object.isFrozen(appliedMigrationIds)).toBe(true);
        await queryRunner.query('SELECT "newColumn" FROM core."fixtureOne"');
      },
    };

    await runner([firstWithVersionedCheck]).apply();
    observations.length = 0;
    await runner([firstWithVersionedCheck, secondWithVersionedCheck]).apply();
    expect(observations).toEqual([
      { migrationId: first.migrationId, prefix: [first.migrationId] },
      {
        migrationId: second.migrationId,
        prefix: [first.migrationId, second.migrationId],
      },
      {
        migrationId: first.migrationId,
        prefix: [first.migrationId, second.migrationId],
      },
      {
        migrationId: second.migrationId,
        prefix: [first.migrationId, second.migrationId],
      },
    ]);
    observations.length = 0;
    await verifier([
      firstWithVersionedCheck,
      secondWithVersionedCheck,
    ]).verifyReady();
    expect(observations).toEqual([
      {
        migrationId: first.migrationId,
        prefix: [first.migrationId, second.migrationId],
      },
      {
        migrationId: second.migrationId,
        prefix: [first.migrationId, second.migrationId],
      },
    ]);
  });

  it('rejects a later ledger checksum before invoking any schema verifier', async () => {
    const migrations = [createMigration(), createMigration('two')];

    await runner(migrations).apply();
    await dataSource.query(
      'UPDATE core."forkMigrationLedger" SET checksum = $1 WHERE "migrationId" = $2',
      [checksum('tampered'), migrations[1].migrationId],
    );
    const observed: string[] = [];
    const observedMigrations = migrations.map((migration) => ({
      ...migration,
      verify: async () => {
        observed.push(migration.migrationId);
      },
    }));

    await expect(runner(observedMigrations).apply()).rejects.toThrow(
      'Fork migration drift: omni-test-two',
    );
    await expect(verifier(observedMigrations).verifyReady()).rejects.toThrow(
      'Fork migration drift: omni-test-two',
    );
    expect(observed).toEqual([]);
  });

  it('retains a committed prefix and retries only a failed next step', async () => {
    const second = createMigration('two');

    await expect(
      runner([
        createMigration(),
        {
          ...second,
          verify: async () => {
            throw new Error('injected');
          },
        },
      ]).apply(),
    ).rejects.toThrow('injected');
    expect(await runner([createMigration(), second]).apply()).toEqual([
      'omni-test-two',
    ]);
  });

  it('serializes two concurrent migrators and records exactly one application', async () => {
    const migration = createMigration();
    const slowMigration = {
      ...migration,
      command: {
        ...migration.command,
        up: async (queryRunner: QueryRunner) => {
          await queryRunner.query('SELECT pg_sleep(0.1)');
          await migration.command.up(queryRunner);
        },
      },
    };
    const results = await Promise.all([
      runner([slowMigration]).apply(),
      runner([slowMigration]).apply(),
    ]);

    expect(results.flat()).toEqual(['omni-test-one']);
    expect(
      await dataSource.query(
        'SELECT count(*)::integer AS count FROM core."forkMigrationLedger"',
      ),
    ).toEqual([{ count: 1 }]);
  });

  it('rejects a checksum change before applying another step', async () => {
    await runner().apply();

    await expect(
      runner([
        { ...createMigration(), checksum: checksum('changed') },
        createMigration('two'),
      ]).apply(),
    ).rejects.toThrow('Fork migration drift');
    expect(
      await dataSource.query(`SELECT to_regclass('core."fixtureTwo"') AS name`),
    ).toEqual([{ name: null }]);
  });

  it('rejects unknown ledger entries instead of adopting a newer schema', async () => {
    await runner([createMigration(), createMigration('two')]).apply();

    await expect(runner().apply()).rejects.toThrow(
      'Unknown or duplicate fork migration',
    );
    await expect(verifier().verifyReady()).rejects.toThrow(
      'Unknown or duplicate fork migration',
    );
  });

  it('rejects a non-prefix ledger and does not recreate the missing entry', async () => {
    await runner([createMigration(), createMigration('two')]).apply();
    await dataSource.query(
      'DELETE FROM core."forkMigrationLedger" WHERE "migrationId" = $1',
      ['omni-test-one'],
    );

    await expect(
      runner([createMigration(), createMigration('two')]).apply(),
    ).rejects.toThrow('not a manifest prefix');
  });

  it('does not adopt an unrecorded pre-existing business table', async () => {
    await dataSource.query('CREATE TABLE core."fixtureOne" (id integer)');
    await dataSource.query('INSERT INTO core."fixtureOne" VALUES (9)');

    await expect(runner().apply()).rejects.toThrow('already exists');
    expect(await dataSource.query('SELECT * FROM core."fixtureOne"')).toEqual([
      { id: 9 },
    ]);
  });

  it('readiness fails without creating a ledger', async () => {
    await expect(verifier().verifyReady()).rejects.toThrow('ledger schema');
    expect(
      await dataSource.query(
        `SELECT to_regclass('core."forkMigrationLedger"') AS name`,
      ),
    ).toEqual([{ name: null }]);
  });

  it('readiness checks schema even when ledger checksums match', async () => {
    await runner().apply();
    await dataSource.query('ALTER TABLE core."fixtureOne" DROP COLUMN id');

    await expect(verifier().verifyReady()).rejects.toThrow('does not exist');
    await expect(runner().apply()).rejects.toThrow('does not exist');
  });

  it('readiness rejects an accidentally mutating verifier', async () => {
    await runner().apply();

    await expect(
      verifier([
        {
          ...createMigration(),
          verify: async (queryRunner) => {
            await queryRunner.query('DELETE FROM core."fixtureOne"');
          },
        },
      ]).verifyReady(),
    ).rejects.toThrow('read-only transaction');
  });

  it('rejects malformed or duplicate manifest entries before connecting', () => {
    expect(() => verifier([createMigration(), createMigration()])).toThrow(
      'duplicate',
    );
    expect(() =>
      verifier([{ ...createMigration(), checksum: 'unverified' }]),
    ).toThrow('Invalid');
    expect(() => runner([createMigration(), createMigration()])).toThrow(
      'duplicate',
    );
    expect(() =>
      runner([{ ...createMigration(), checksum: 'unverified' }]),
    ).toThrow('Invalid');
  });

  it('rejects an empty but incompatible ledger before applying business DDL', async () => {
    await dataSource.query(`CREATE TABLE core."forkMigrationLedger" (
      "migrationId" text, checksum text, status text, "appliedAt" timestamptz
    )`);

    await expect(runner().apply()).rejects.toThrow('ledger schema');
    expect(
      await dataSource.query(`SELECT to_regclass('core."fixtureOne"') AS name`),
    ).toEqual([{ name: null }]);
  });

  it('recovers after the database connection dies during a migration', async () => {
    const migration = createMigration();

    await expect(
      runner([
        {
          ...migration,
          verify: async (queryRunner) => {
            const [{ pid }]: { pid: number }[] = await queryRunner.query(
              'SELECT pg_backend_pid() AS pid',
            );

            await dataSource.query('SELECT pg_terminate_backend($1)', [pid]);
            await queryRunner.query('SELECT 1');
          },
        },
      ]).apply(),
    ).rejects.toThrow();
    expect(
      await dataSource.query(`SELECT to_regclass('core."fixtureOne"') AS name`),
    ).toEqual([{ name: null }]);
    expect(await runner().apply()).toEqual(['omni-test-one']);
  });

  it('allows readiness with a read-only role but refuses migration writes', async () => {
    await runner().apply();

    const role = `runtime_${new URL(databaseUrl!).pathname.slice(-16)}`;
    const runtimeUrl = new URL(databaseUrl!);

    runtimeUrl.username = role;
    runtimeUrl.password = 'isolated-test-only';
    await dataSource.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated-test-only'`,
    );
    await dataSource.query(`GRANT USAGE ON SCHEMA core TO "${role}"`);
    await dataSource.query(
      `GRANT SELECT ON ALL TABLES IN SCHEMA core TO "${role}"`,
    );

    const runtime = new DataSource({
      type: 'postgres',
      url: runtimeUrl.toString(),
    });

    try {
      await runtime.initialize();
      await expect(
        new ForkSchemaVerifier(runtime, [createMigration()]).verifyReady(),
      ).resolves.toBeUndefined();
      await expect(
        new ForkMigrationRunner(runtime, [
          createMigration(),
          createMigration('two'),
        ]).apply(),
      ).rejects.toThrow('permission denied');
      await expect(
        runtime.query('DELETE FROM core."forkMigrationLedger"'),
      ).rejects.toThrow('permission denied');
    } finally {
      if (runtime.isInitialized) await runtime.destroy();
      await dataSource.query(`DROP OWNED BY "${role}"`);
      await dataSource.query(`DROP ROLE "${role}"`);
    }
  });
});
