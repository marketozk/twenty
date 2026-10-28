import { verifyIncomingApplicationResult } from 'src/engine/core-modules/omnichannel-storage/migrations/incoming-application-result.check';
import { verifyMessageCurrentRevision } from 'src/engine/core-modules/omnichannel-storage/migrations/message-current-revision.check';
import { verifyAuditBootstrap } from 'src/engine/core-modules/omnichannel-storage/migrations/audit-bootstrap.check';
import { verifyBindingConfigWakeup } from 'src/engine/core-modules/omnichannel-storage/migrations/binding-config-wakeup.check';
import { verifyCommandRestoreContext } from 'src/engine/core-modules/omnichannel-storage/migrations/command-restore-context.check';
import { verifyConversationFoundation } from 'src/engine/core-modules/omnichannel-storage/migrations/conversation-foundation.check';
import { verifyEventGovernance } from 'src/engine/core-modules/omnichannel-storage/migrations/event-governance.check';
import { type ForkMigrationCheck } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-migration-check.type';
import manifest from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-manifest.json';
import { verifyMessagePersistence } from 'src/engine/core-modules/omnichannel-storage/migrations/message-persistence.check';
import { verifyTrustedCapture } from 'src/engine/core-modules/omnichannel-storage/migrations/trusted-capture.check';

if (
  manifest.length !== 9 ||
  manifest[0].migrationId !== 'omni-1793078228031-conversation-foundation' ||
  manifest[1].migrationId !== 'omni-1793091163781-audit-bootstrap' ||
  manifest[2].migrationId !== 'omni-1793094313685-message-persistence' ||
  manifest[3].migrationId !== 'omni-1793095884267-event-governance' ||
  manifest[4].migrationId !== 'omni-1793104418386-trusted-capture' ||
  manifest[5].migrationId !== 'omni-1793116941052-binding-config-wakeup' ||
  manifest[6].migrationId !== 'omni-1793127619000-command-restore-context' ||
  manifest[7].migrationId !== 'omni-1793163618643-message-current-revision' ||
  manifest[8].migrationId !== 'omni-1793165655229-incoming-application-result'
) {
  throw new Error('Fork schema manifest and explicit verifier registry differ');
}

export const FORK_SCHEMA_CHECKS: readonly ForkMigrationCheck[] = [
  { ...manifest[0], verify: verifyConversationFoundation },
  { ...manifest[1], verify: verifyAuditBootstrap },
  { ...manifest[2], verify: verifyMessagePersistence },
  { ...manifest[3], verify: verifyEventGovernance },
  { ...manifest[4], verify: verifyTrustedCapture },
  { ...manifest[5], verify: verifyBindingConfigWakeup },
  { ...manifest[6], verify: verifyCommandRestoreContext },
  { ...manifest[7], verify: verifyMessageCurrentRevision },
  { ...manifest[8], verify: verifyIncomingApplicationResult },
];
