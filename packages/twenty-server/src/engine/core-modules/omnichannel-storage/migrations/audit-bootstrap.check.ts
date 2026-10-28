import operationSchema from 'src/engine/core-modules/omnichannel-storage/migrations/audit-operation-index.schema.json';
import manifest from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-manifest.json';
import { type QueryRunner } from 'typeorm';

import schema from 'src/engine/core-modules/omnichannel-storage/migrations/audit-bootstrap.schema.json';
import { verifyForkTableSnapshot } from 'src/engine/core-modules/omnichannel-storage/migrations/verify-fork-table-snapshot';

export const verifyAuditBootstrap = async (
  queryRunner: QueryRunner,
  appliedMigrationIds: readonly string[] = [],
): Promise<void> => {
  await verifyForkTableSnapshot(
    queryRunner,
    appliedMigrationIds.includes(manifest[9].migrationId)
      ? schema.map(
          (table) =>
            operationSchema.find((updated) => updated.name === table.name) ??
            table,
        )
      : schema,
    'Omnichannel audit/bootstrap schema does not match its manifest',
  );
};
