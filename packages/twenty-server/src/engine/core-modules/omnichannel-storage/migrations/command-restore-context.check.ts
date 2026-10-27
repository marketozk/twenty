import { type QueryRunner } from 'typeorm';

import schema from 'src/engine/core-modules/omnichannel-storage/migrations/command-restore-context.schema.json';
import { verifyForkTableSnapshot } from 'src/engine/core-modules/omnichannel-storage/migrations/verify-fork-table-snapshot';

export const verifyCommandRestoreContext = async (
  queryRunner: QueryRunner,
): Promise<void> => {
  await verifyForkTableSnapshot(
    queryRunner,
    schema,
    'Omnichannel command restore context schema does not match its manifest',
  );
  // TypeORM maps UUID generators to isGenerated and omits them from column.default.
  const defaults: unknown[] = await queryRunner.query(
    `SELECT attribute.attname FROM pg_attribute attribute
     JOIN pg_attrdef definition ON definition.adrelid=attribute.attrelid AND definition.adnum=attribute.attnum
     WHERE attribute.attrelid='core."omniOutgoingCommand"'::regclass
       AND attribute.attname='createdRestoreIncarnation' AND NOT attribute.attisdropped`,
  );
  if (defaults.length > 0)
    throw new Error(
      'Omnichannel command restore context schema does not match its manifest',
    );
};
