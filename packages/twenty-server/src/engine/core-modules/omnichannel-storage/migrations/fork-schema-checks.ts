import { verifyAuditBootstrap } from 'src/engine/core-modules/omnichannel-storage/migrations/audit-bootstrap.check';
import { verifyConversationFoundation } from 'src/engine/core-modules/omnichannel-storage/migrations/conversation-foundation.check';
import { verifyEventGovernance } from 'src/engine/core-modules/omnichannel-storage/migrations/event-governance.check';
import { type ForkMigrationCheck } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-migration-check.type';
import manifest from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-manifest.json';
import { verifyMessagePersistence } from 'src/engine/core-modules/omnichannel-storage/migrations/message-persistence.check';

if (
  manifest.length !== 4 ||
  manifest[0].migrationId !== 'omni-1793078228031-conversation-foundation' ||
  manifest[1].migrationId !== 'omni-1793091163781-audit-bootstrap' ||
  manifest[2].migrationId !== 'omni-1793094313685-message-persistence' ||
  manifest[3].migrationId !== 'omni-1793095884267-event-governance'
) {
  throw new Error('Fork schema manifest and explicit verifier registry differ');
}

export const FORK_SCHEMA_CHECKS: readonly ForkMigrationCheck[] = [
  { ...manifest[0], verify: verifyConversationFoundation },
  { ...manifest[1], verify: verifyAuditBootstrap },
  { ...manifest[2], verify: verifyMessagePersistence },
  { ...manifest[3], verify: verifyEventGovernance },
];
