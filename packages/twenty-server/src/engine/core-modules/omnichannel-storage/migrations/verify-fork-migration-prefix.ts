import { type QueryRunner } from 'typeorm';

import { type ForkMigrationCheck } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-migration-check.type';

type LedgerEntry = {
  migrationId: string;
  checksum: string;
  status: string;
};

export const verifyForkMigrationPrefix = async (
  queryRunner: QueryRunner,
  migrations: readonly ForkMigrationCheck[],
): Promise<number> => {
  const columns: {
    name: string;
    type: string;
    notNull: boolean;
    primary: boolean;
  }[] = await queryRunner.query(`
      SELECT attribute.attname AS name,
             format_type(attribute.atttypid, attribute.atttypmod) AS type,
             attribute.attnotnull AS "notNull",
             EXISTS (
               SELECT 1 FROM pg_constraint constraint_definition
               WHERE constraint_definition.conrelid = attribute.attrelid
                 AND constraint_definition.contype = 'p'
                 AND constraint_definition.conkey = ARRAY[attribute.attnum]
             ) AS primary
      FROM pg_attribute attribute
      WHERE attribute.attrelid = to_regclass('core."forkMigrationLedger"')
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
      ORDER BY attribute.attname
    `);
  const expectedColumns = [
    {
      name: 'appliedAt',
      type: 'timestamp with time zone',
      notNull: true,
      primary: false,
    },
    { name: 'checksum', type: 'text', notNull: true, primary: false },
    { name: 'migrationId', type: 'text', notNull: true, primary: true },
    { name: 'status', type: 'text', notNull: true, primary: false },
  ];

  if (JSON.stringify(columns) !== JSON.stringify(expectedColumns)) {
    throw new Error('Missing or incompatible fork migration ledger schema');
  }

  const entries: LedgerEntry[] = await queryRunner.query(
    'SELECT "migrationId", "checksum", "status" FROM core."forkMigrationLedger"',
  );
  const applied = new Map(entries.map((entry) => [entry.migrationId, entry]));
  const knownIdentifiers = new Set(
    migrations.map((migration) => migration.migrationId),
  );

  if (
    applied.size !== entries.length ||
    entries.some((entry) => !knownIdentifiers.has(entry.migrationId))
  ) {
    throw new Error('Unknown or duplicate fork migration in ledger');
  }

  let completedCount = 0;

  for (const migration of migrations) {
    const entry = applied.get(migration.migrationId);

    if (!entry) {
      continue;
    }

    if (migrations[completedCount].migrationId !== entry.migrationId) {
      throw new Error('Fork migration ledger is not a manifest prefix');
    }

    if (entry.checksum !== migration.checksum || entry.status !== 'completed') {
      throw new Error(`Fork migration drift: ${migration.migrationId}`);
    }

    await migration.verify(queryRunner);
    completedCount++;
  }

  return completedCount;
};
