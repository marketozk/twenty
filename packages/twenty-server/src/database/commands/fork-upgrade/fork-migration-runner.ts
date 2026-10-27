import { type DataSource, type QueryRunner } from 'typeorm';

import { type ForkMigration } from 'src/database/commands/fork-upgrade/fork-migration.type';
import { validateForkMigrationManifest } from 'src/engine/core-modules/omnichannel-storage/migrations/validate-fork-migration-manifest';
import { verifyForkMigrationPrefix } from 'src/engine/core-modules/omnichannel-storage/migrations/verify-fork-migration-prefix';

// Transaction-scoped locks cannot leak into the connection pool after a crash.
const FORK_MIGRATION_LOCK = [0x7477656e, 0x666f726b];

export class ForkMigrationRunner {
  private readonly migrations: readonly ForkMigration[];

  constructor(
    private readonly dataSource: DataSource,
    migrations: readonly ForkMigration[],
  ) {
    validateForkMigrationManifest(migrations);

    if (migrations.some((migration) => migration.kind !== 'fork')) {
      throw new Error('Only fork migrations are allowed in the fork runner');
    }

    this.migrations = migrations.map((migration) =>
      Object.freeze({ ...migration }),
    );
  }

  async apply(): Promise<string[]> {
    const queryRunner = this.dataSource.createQueryRunner();
    const applied: string[] = [];

    try {
      await queryRunner.connect();

      while (true) {
        await queryRunner.startTransaction();

        try {
          await queryRunner.query(
            'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
            FORK_MIGRATION_LOCK,
          );
          await this.bootstrapLedger(queryRunner);

          const completedCount = await verifyForkMigrationPrefix(
            queryRunner,
            this.migrations,
          );
          const migration = this.migrations[completedCount];

          if (!migration) {
            await queryRunner.commitTransaction();

            return applied;
          }

          await migration.command.up(queryRunner);
          await migration.verify(queryRunner);
          await queryRunner.query(
            `INSERT INTO core."forkMigrationLedger"
              ("migrationId", "checksum", "status") VALUES ($1, $2, 'completed')`,
            [migration.migrationId, migration.checksum],
          );
          await queryRunner.commitTransaction();
          applied.push(migration.migrationId);
        } catch (error) {
          if (queryRunner.isTransactionActive) {
            await queryRunner.rollbackTransaction();
          }

          throw error;
        }
      }
    } finally {
      await queryRunner.release();
    }
  }

  private async bootstrapLedger(queryRunner: QueryRunner): Promise<void> {
    // core must already exist: the upstream upgrade precedes the fork runner.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS core."forkMigrationLedger" (
        "migrationId" text PRIMARY KEY,
        "checksum" text NOT NULL CHECK ("checksum" ~ '^[a-f0-9]{64}$'),
        "status" text NOT NULL CHECK ("status" = 'completed'),
        "appliedAt" timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
  }
}
