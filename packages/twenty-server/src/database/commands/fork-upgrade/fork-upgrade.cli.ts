import { DataSource } from 'typeorm';

import { ForkMigrationRunner } from 'src/database/commands/fork-upgrade/fork-migration-runner';
import { FORK_MIGRATIONS } from 'src/database/commands/fork-upgrade/fork-migrations';
import { FORK_SCHEMA_CHECKS } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-checks';
import { ForkSchemaVerifier } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-verifier';

// This entrypoint must not bootstrap AppModule before the fork schema exists.
export const runForkUpgrade = async (operation: string): Promise<void> => {
  if (operation !== 'apply' && operation !== 'verify') {
    throw new Error('Usage: fork-upgrade.cli.js apply|verify');
  }

  if (!process.env.PG_DATABASE_URL) {
    throw new Error('PG_DATABASE_URL is required');
  }

  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.PG_DATABASE_URL,
    synchronize: false,
    migrationsRun: false,
    poolSize: 1,
    ssl:
      process.env.PG_SSL_ALLOW_SELF_SIGNED === 'true'
        ? { rejectUnauthorized: false }
        : undefined,
  });

  try {
    await dataSource.initialize();

    if (operation === 'apply') {
      await new ForkMigrationRunner(dataSource, FORK_MIGRATIONS).apply();
    }

    await new ForkSchemaVerifier(dataSource, FORK_SCHEMA_CHECKS).verifyReady();
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
};

if (require.main === module) {
  runForkUpgrade(process.argv[2]).catch((error: unknown) => {
    // oxlint-disable-next-line no-console
    console.error(
      error instanceof Error ? error.message : 'Fork migration failed',
    );
    process.exitCode = 1;
  });
}
