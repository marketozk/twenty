import applicationSchema from 'src/engine/core-modules/omnichannel-storage/migrations/incoming-application-result.schema.json';
import manifest from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-manifest.json';
import { type QueryRunner } from 'typeorm';

import schema from 'src/engine/core-modules/omnichannel-storage/migrations/trusted-capture.schema.json';
import { verifyForkTableSnapshot } from 'src/engine/core-modules/omnichannel-storage/migrations/verify-fork-table-snapshot';

export const verifyTrustedCapture = async (
  queryRunner: QueryRunner,
  appliedMigrationIds: readonly string[] = [],
): Promise<void> => {
  await verifyForkTableSnapshot(
    queryRunner,
    appliedMigrationIds.includes(manifest[8].migrationId)
      ? applicationSchema
      : schema,
    'Omnichannel trusted capture schema does not match its manifest',
  );
};
