import { type QueryRunner } from 'typeorm';
import schema from 'src/engine/core-modules/omnichannel-storage/migrations/audit-operation-index.schema.json';
import { verifyForkTableSnapshot } from 'src/engine/core-modules/omnichannel-storage/migrations/verify-fork-table-snapshot';

export const verifyAuditOperationIndex = async (
  queryRunner: QueryRunner,
): Promise<void> => {
  await verifyForkTableSnapshot(
    queryRunner,
    schema,
    'CRM audit operation index schema does not match its manifest',
  );
};
