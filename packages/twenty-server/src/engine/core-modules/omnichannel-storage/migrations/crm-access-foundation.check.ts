import { type QueryRunner } from 'typeorm';

import schema from 'src/engine/core-modules/omnichannel-storage/migrations/crm-access-foundation.schema.json';
import { verifyForkTableSnapshot } from 'src/engine/core-modules/omnichannel-storage/migrations/verify-fork-table-snapshot';

export const verifyCrmAccessFoundation = async (
  queryRunner: QueryRunner,
): Promise<void> => {
  await verifyForkTableSnapshot(
    queryRunner,
    schema,
    'CRM access foundation schema does not match its manifest',
  );
};
