import { type QueryRunner } from 'typeorm';

import schema from 'src/engine/core-modules/omnichannel-storage/migrations/conversation-foundation.schema.json';
import manifest from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-manifest.json';
import messageSchema from 'src/engine/core-modules/omnichannel-storage/migrations/message-persistence.schema.json';
import { verifyForkTableSnapshot } from 'src/engine/core-modules/omnichannel-storage/migrations/verify-fork-table-snapshot';

export const verifyConversationFoundation = async (
  queryRunner: QueryRunner,
  appliedMigrationIds: readonly string[] = [],
): Promise<void> => {
  const messageMigration = manifest[2];
  let expectedSchema: readonly { name: string }[] = schema;

  if (
    messageMigration &&
    appliedMigrationIds.includes(messageMigration.migrationId)
  ) {
    const updatedConversation = messageSchema.find(
      (table) => table.name === 'core.omniConversation',
    );

    if (!updatedConversation) {
      throw new Error('Missing conversation snapshot for message migration');
    }

    expectedSchema = schema.map((table) =>
      table.name === 'core.omniConversation' ? updatedConversation : table,
    );
  }

  await verifyForkTableSnapshot(
    queryRunner,
    expectedSchema,
    'Omnichannel conversation schema does not match its manifest',
  );
};
