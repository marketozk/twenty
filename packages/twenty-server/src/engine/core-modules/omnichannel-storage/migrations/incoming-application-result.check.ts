import { type QueryRunner } from 'typeorm';
import schema from 'src/engine/core-modules/omnichannel-storage/migrations/incoming-application-result.schema.json';
import { verifyForkTableSnapshot } from 'src/engine/core-modules/omnichannel-storage/migrations/verify-fork-table-snapshot';

export const verifyIncomingApplicationResult = async (
  queryRunner: QueryRunner,
): Promise<void> => {
  await verifyForkTableSnapshot(
    queryRunner,
    schema,
    'Omnichannel application result schema does not match its manifest',
  );
};
