import { type QueryRunner } from 'typeorm';

import { snapshotForkTables } from 'src/engine/core-modules/omnichannel-storage/migrations/snapshot-fork-tables';

export const verifyForkTableSnapshot = async (
  queryRunner: QueryRunner,
  expected: readonly { name: string }[],
  mismatchMessage: string,
): Promise<void> => {
  const tableNames = expected.map((table) => table.name);
  const invalidConstraints: unknown[] = await queryRunner.query(
    `SELECT conname FROM pg_constraint
      WHERE conrelid IN (
        SELECT to_regclass(format('%I.%I', split_part(name, '.', 1), split_part(name, '.', 2)))
        FROM unnest($1::text[]) name
      )
        AND (NOT convalidated OR condeferrable)`,
    [tableNames],
  );
  const invalidIndexes: unknown[] = await queryRunner.query(
    `SELECT indexrelid FROM pg_index
      WHERE indrelid IN (
        SELECT to_regclass(format('%I.%I', split_part(name, '.', 1), split_part(name, '.', 2)))
        FROM unnest($1::text[]) name
      )
        AND (NOT indisvalid OR NOT indisready)`,
    [tableNames],
  );

  if (invalidConstraints.length > 0 || invalidIndexes.length > 0) {
    throw new Error('Omnichannel constraints or indexes are not ready');
  }

  const actual = await snapshotForkTables(queryRunner, tableNames);

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(mismatchMessage);
  }
};
