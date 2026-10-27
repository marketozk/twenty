import { type QueryRunner } from 'typeorm';

import schema from 'src/engine/core-modules/omnichannel-storage/migrations/conversation-foundation.schema.json';
import { snapshotForkTables } from 'src/engine/core-modules/omnichannel-storage/migrations/snapshot-fork-tables';

export const verifyConversationFoundation = async (
  queryRunner: QueryRunner,
): Promise<void> => {
  const tableNames = schema.map((table) => table.name);
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

  if (JSON.stringify(actual) !== JSON.stringify(schema)) {
    throw new Error(
      'Omnichannel conversation schema does not match its manifest',
    );
  }
};
