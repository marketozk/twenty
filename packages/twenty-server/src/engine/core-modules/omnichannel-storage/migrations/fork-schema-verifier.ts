import { type DataSource } from 'typeorm';

import { type ForkMigrationCheck } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-migration-check.type';
import { validateForkMigrationManifest } from 'src/engine/core-modules/omnichannel-storage/migrations/validate-fork-migration-manifest';
import { verifyForkMigrationPrefix } from 'src/engine/core-modules/omnichannel-storage/migrations/verify-fork-migration-prefix';

export class ForkSchemaVerifier {
  private readonly migrations: readonly ForkMigrationCheck[];

  constructor(
    private readonly dataSource: DataSource,
    migrations: readonly ForkMigrationCheck[],
  ) {
    validateForkMigrationManifest(migrations);
    this.migrations = migrations.map(({ migrationId, checksum, verify }) =>
      Object.freeze({ migrationId, checksum, verify }),
    );
  }

  async verifyReady(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction('REPEATABLE READ');
      await queryRunner.query('SET TRANSACTION READ ONLY');

      if (
        (await verifyForkMigrationPrefix(queryRunner, this.migrations)) !==
        this.migrations.length
      ) {
        throw new Error('Pending fork migrations');
      }

      await queryRunner.commitTransaction();
    } finally {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }

      await queryRunner.release();
    }
  }
}
