import { type ForkMigrationCheck } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-migration-check.type';

export const validateForkMigrationManifest = (
  migrations: readonly ForkMigrationCheck[],
): void => {
  const identifiers = new Set<string>();

  for (const migration of migrations) {
    if (
      !/^[a-z][a-z0-9-]{0,127}$/.test(migration.migrationId) ||
      !/^[a-f0-9]{64}$/.test(migration.checksum) ||
      identifiers.has(migration.migrationId) ||
      typeof migration.verify !== 'function'
    ) {
      throw new Error('Invalid or duplicate fork migration manifest entry');
    }

    identifiers.add(migration.migrationId);
  }
};
