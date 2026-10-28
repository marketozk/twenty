import { type QueryRunner } from 'typeorm';

import schema from 'src/engine/core-modules/omnichannel-storage/migrations/message-current-revision.schema.json';
import { verifyForkTableSnapshot } from 'src/engine/core-modules/omnichannel-storage/migrations/verify-fork-table-snapshot';

export const verifyMessageCurrentRevision = async (
  queryRunner: QueryRunner,
): Promise<void> => {
  await verifyForkTableSnapshot(
    queryRunner,
    schema,
    'Omnichannel current revision schema does not match its manifest',
  );
  const defaults: unknown[] = await queryRunner.query(
    `SELECT attribute.attname FROM pg_attribute attribute
     JOIN pg_attrdef definition ON definition.adrelid=attribute.attrelid AND definition.adnum=attribute.attnum
     WHERE attribute.attrelid='core."omniMessageLink"'::regclass
       AND attribute.attname='currentRevisionId' AND NOT attribute.attisdropped`,
  );
  if (defaults.length)
    throw new Error(
      'Omnichannel current revision schema does not match its manifest',
    );
};
