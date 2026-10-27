import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { ForkMigrationRunner } from 'src/database/commands/fork-upgrade/fork-migration-runner';
import { FORK_MIGRATIONS } from 'src/database/commands/fork-upgrade/fork-migrations';
import { runForkUpgrade } from 'src/database/commands/fork-upgrade/fork-upgrade.cli';
import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { verifyAuditBootstrap } from 'src/engine/core-modules/omnichannel-storage/migrations/audit-bootstrap.check';
import { verifyConversationFoundation } from 'src/engine/core-modules/omnichannel-storage/migrations/conversation-foundation.check';
import { ForkSchemaVerifier } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-verifier';
import { FORK_SCHEMA_CHECKS } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-checks';

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
  extra: { max: 3, statement_timeout: 10000 },
});

beforeAll(async () => {
  await dataSource.initialize();
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
});

beforeEach(async () => {
  await dataSource.query('DROP SCHEMA IF EXISTS crm_audit CASCADE');
  await dataSource.query('DROP SCHEMA IF EXISTS core CASCADE');
  await dataSource.query('CREATE SCHEMA core');
  await dataSource.query('CREATE TABLE core.workspace (id uuid PRIMARY KEY)');
  await dataSource.query(
    'CREATE TABLE core."connectedAccount" (id uuid PRIMARY KEY)',
  );
  await dataSource.query(
    'CREATE TABLE core."messageChannel" (id uuid PRIMARY KEY)',
  );
});

afterAll(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});

describe('audit/bootstrap migration and manifest', () => {
  it('runtime CLI refuses an owner but accepts a distinct append-only role', async () => {
    await new ForkMigrationRunner(dataSource, FORK_MIGRATIONS).apply();
    const oldUrl = process.env.PG_DATABASE_URL;
    const role = `audit_startup_${randomUUID().replaceAll('-', '')}`;
    const runtimeUrl = new URL(databaseUrl!);

    runtimeUrl.username = role;
    runtimeUrl.password = 'isolated-startup-fixture';
    await dataSource.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated-startup-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    try {
      await dataSource.query(
        `GRANT USAGE ON SCHEMA core, crm_audit TO "${role}"`,
      );
      await dataSource.query(
        `GRANT SELECT ON ALL TABLES IN SCHEMA core TO "${role}"`,
      );
      await dataSource.query(
        `GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${role}"`,
      );
      process.env.PG_DATABASE_URL = databaseUrl;
      await expect(runForkUpgrade('verify')).rejects.toThrow(
        'append-only privileges',
      );
      process.env.PG_DATABASE_URL = runtimeUrl.toString();
      await expect(runForkUpgrade('verify')).resolves.toBeUndefined();
    } finally {
      if (oldUrl === undefined) delete process.env.PG_DATABASE_URL;
      else process.env.PG_DATABASE_URL = oldUrl;
      await dataSource.query(`DROP OWNED BY "${role}"`);
      await dataSource.query(`DROP ROLE "${role}"`);
    }
  });

  it('upgrades the existing fork prefix and replays without duplicating ledger entries', async () => {
    await new ForkMigrationRunner(
      dataSource,
      FORK_MIGRATIONS.slice(0, 1),
    ).apply();
    const runner = new ForkMigrationRunner(dataSource, FORK_MIGRATIONS);

    expect(await runner.apply()).toEqual([FORK_MIGRATIONS[1].migrationId]);
    expect(await runner.apply()).toEqual([]);
    await new ForkSchemaVerifier(dataSource, FORK_SCHEMA_CHECKS).verifyReady();
    expect(
      await dataSource.query(
        'SELECT count(*)::int AS count FROM core."forkMigrationLedger"',
      ),
    ).toEqual([{ count: 2 }]);
  });

  it('reverses empty new tables without removing the earlier foundation or audit schema', async () => {
    await new ForkMigrationRunner(dataSource, FORK_MIGRATIONS).apply();
    await dataSource.transaction(async (manager) => {
      const queryRunner = manager.queryRunner!;
      const migration = new OmniAuditBootstrapFastInstanceCommand();

      await migration.down(queryRunner);
      await verifyConversationFoundation(queryRunner);
      expect(
        await queryRunner.query(
          'SELECT to_regclass(\'crm_audit."crmAuditEntry"\') AS relation',
        ),
      ).toEqual([{ relation: null }]);
      await migration.up(queryRunner);
      await verifyAuditBootstrap(queryRunner);
    });
  });

  it('refuses readiness after audit schema drift', async () => {
    await new ForkMigrationRunner(dataSource, FORK_MIGRATIONS).apply();
    await dataSource.query(
      'ALTER TABLE crm_audit."crmAuditEntry" ALTER COLUMN "payloadHash" DROP NOT NULL',
    );
    await expect(
      new ForkSchemaVerifier(dataSource, FORK_SCHEMA_CHECKS).verifyReady(),
    ).rejects.toThrow('audit/bootstrap schema');
  });
});
