import { type ForkMigration } from 'src/database/commands/fork-upgrade/fork-migration.type';
import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { OmniConversationFoundationFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-conversation-foundation.migration';
import { FORK_SCHEMA_CHECKS } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-checks';

export const FORK_MIGRATIONS: readonly ForkMigration[] = [
  {
    ...FORK_SCHEMA_CHECKS[0],
    kind: OmniConversationFoundationFastInstanceCommand.kind,
    command: new OmniConversationFoundationFastInstanceCommand(),
  },
  {
    ...FORK_SCHEMA_CHECKS[1],
    kind: OmniAuditBootstrapFastInstanceCommand.kind,
    command: new OmniAuditBootstrapFastInstanceCommand(),
  },
];

if (FORK_MIGRATIONS.length !== FORK_SCHEMA_CHECKS.length) {
  throw new Error('Fork command and verifier registries differ');
}
