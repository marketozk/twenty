import { type QueryRunner } from 'typeorm';

import schema from 'src/engine/core-modules/omnichannel-storage/migrations/event-governance.schema.json';
import { verifyForkTableSnapshot } from 'src/engine/core-modules/omnichannel-storage/migrations/verify-fork-table-snapshot';

export const verifyEventGovernance = async (
  queryRunner: QueryRunner,
): Promise<void> => {
  await verifyForkTableSnapshot(
    queryRunner,
    schema,
    'Omnichannel event governance schema does not match its manifest',
  );
};
