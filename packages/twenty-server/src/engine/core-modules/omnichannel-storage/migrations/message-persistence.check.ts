import { type QueryRunner } from 'typeorm';

import restoreSchema from 'src/engine/core-modules/omnichannel-storage/migrations/command-restore-context.schema.json';
import governanceSchema from 'src/engine/core-modules/omnichannel-storage/migrations/event-governance.schema.json';
import manifest from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-manifest.json';
import schema from 'src/engine/core-modules/omnichannel-storage/migrations/message-persistence.schema.json';
import captureSchema from 'src/engine/core-modules/omnichannel-storage/migrations/trusted-capture.schema.json';
import { verifyForkTableSnapshot } from 'src/engine/core-modules/omnichannel-storage/migrations/verify-fork-table-snapshot';

export const verifyMessagePersistence = async (
  queryRunner: QueryRunner,
  appliedMigrationIds: readonly string[] = [],
): Promise<void> => {
  const governanceMigration = manifest[3];
  let expectedSchema: readonly { name: string }[] = schema;

  if (
    governanceMigration &&
    appliedMigrationIds.includes(governanceMigration.migrationId)
  ) {
    const updatedEvent = governanceSchema.find(
      (table) => table.name === 'core.omniDomainEvent',
    );

    if (!updatedEvent) {
      throw new Error('Missing domain event snapshot for governance migration');
    }

    expectedSchema = schema.map((table) =>
      table.name === 'core.omniDomainEvent' ? updatedEvent : table,
    );
  }

  const captureMigration = manifest[4];

  if (
    captureMigration &&
    appliedMigrationIds.includes(captureMigration.migrationId)
  ) {
    const updatedReceipt = captureSchema.find(
      (table) => table.name === 'core.omniIncomingReceipt',
    );

    if (!updatedReceipt) {
      throw new Error('Missing receipt snapshot for trusted capture migration');
    }

    expectedSchema = expectedSchema.map((table) =>
      table.name === 'core.omniIncomingReceipt' ? updatedReceipt : table,
    );
  }

  if (appliedMigrationIds.includes(manifest[6].migrationId)) {
    const updatedCommand = restoreSchema.find(
      (table) => table.name === 'core.omniOutgoingCommand',
    );
    if (!updatedCommand)
      throw new Error('Missing command restore context snapshot');
    expectedSchema = expectedSchema.map((table) =>
      table.name === 'core.omniOutgoingCommand' ? updatedCommand : table,
    );
  }

  await verifyForkTableSnapshot(
    queryRunner,
    expectedSchema,
    'Omnichannel message persistence schema does not match its manifest',
  );
};
