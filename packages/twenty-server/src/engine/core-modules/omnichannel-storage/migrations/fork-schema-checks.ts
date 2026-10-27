import { verifyConversationFoundation } from 'src/engine/core-modules/omnichannel-storage/migrations/conversation-foundation.check';
import { type ForkMigrationCheck } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-migration-check.type';
import manifest from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-manifest.json';

if (
  manifest.length !== 1 ||
  manifest[0].migrationId !== 'omni-1793078228031-conversation-foundation'
) {
  throw new Error('Fork schema manifest and explicit verifier registry differ');
}

export const FORK_SCHEMA_CHECKS: readonly ForkMigrationCheck[] = [
  { ...manifest[0], verify: verifyConversationFoundation },
];
