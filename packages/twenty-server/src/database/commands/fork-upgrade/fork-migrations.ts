import { type ForkMigration } from 'src/database/commands/fork-upgrade/fork-migration.type';
import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { OmniBindingConfigWakeupFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-binding-config-wakeup.migration';
import { OmniCommandRestoreContextFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-command-restore-context.migration';
import { OmniConversationFoundationFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-conversation-foundation.migration';
import { OmniEventGovernanceFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-event-governance.migration';
import { OmniMessagePersistenceFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-message-persistence.migration';
import { OmniTrustedCaptureFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-trusted-capture.migration';
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
  {
    ...FORK_SCHEMA_CHECKS[2],
    kind: OmniMessagePersistenceFastInstanceCommand.kind,
    command: new OmniMessagePersistenceFastInstanceCommand(),
  },
  {
    ...FORK_SCHEMA_CHECKS[3],
    kind: OmniEventGovernanceFastInstanceCommand.kind,
    command: new OmniEventGovernanceFastInstanceCommand(),
  },
  {
    ...FORK_SCHEMA_CHECKS[4],
    kind: OmniTrustedCaptureFastInstanceCommand.kind,
    command: new OmniTrustedCaptureFastInstanceCommand(),
  },
  {
    ...FORK_SCHEMA_CHECKS[5],
    kind: OmniBindingConfigWakeupFastInstanceCommand.kind,
    command: new OmniBindingConfigWakeupFastInstanceCommand(),
  },
  {
    ...FORK_SCHEMA_CHECKS[6],
    kind: OmniCommandRestoreContextFastInstanceCommand.kind,
    command: new OmniCommandRestoreContextFastInstanceCommand(),
  },
];

if (FORK_MIGRATIONS.length !== FORK_SCHEMA_CHECKS.length) {
  throw new Error('Fork command and verifier registries differ');
}
