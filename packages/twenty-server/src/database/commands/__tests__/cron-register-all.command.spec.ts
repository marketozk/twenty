import { Logger } from '@nestjs/common';

import { CronRegisterAllCommand } from 'src/database/commands/cron-register-all.command';

jest.mock(
  'src/engine/core-modules/application/application-marketplace/crons/commands/marketplace-catalog-sync.cron.command',
  () => ({
    MarketplaceCatalogSyncCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/core-modules/application/application-oauth/stale-registration-cleanup/commands/stale-registration-cleanup.cron.command',
  () => ({
    StaleRegistrationCleanupCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/core-modules/billing/app-billing/crons/commands/application-recurring-charge.cron.command',
  () => ({
    ApplicationRecurringChargeCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/core-modules/billing/reminders/crons/commands/billing-reminder.cron.command',
  () => ({
    BillingReminderCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/core-modules/emailing-domain/crons/commands/check-emailing-domain-verification.cron.command',
  () => ({
    CheckEmailingDomainVerificationCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/core-modules/enterprise/cron/command/organization-key-validation.cron.command',
  () => ({
    EnterpriseKeyValidationCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/core-modules/event-logs/cleanup/commands/event-log-cleanup.cron.command',
  () => ({
    EventLogCleanupCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/core-modules/file/file-upload/crons/commands/pending-file-cleanup.cron.command',
  () => ({
    PendingFileCleanupCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/core-modules/workspace-data-export/crons/commands/workspace-data-export-cleanup.cron.command',
  () => ({
    WorkspaceDataExportCleanupCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/core-modules/jwt/crons/commands/rotate-signing-keys.cron.command',
  () => ({
    RotateSigningKeysCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/core-modules/logic-function/logic-function-trigger/triggers/cron/cron-trigger.cron.command',
  () => ({
    CronTriggerCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/core-modules/pending-wake-up/crons/commands/pending-wake-up-sweep.cron.command',
  () => ({
    PendingWakeUpSweepCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/metadata-modules/ai/ai-agent-trigger/crons/agent-cron-trigger.cron.command',
  () => ({
    AgentCronTriggerCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/core-modules/public-domain/crons/commands/check-public-domains-valid-records.cron.command',
  () => ({
    CheckPublicDomainsValidRecordsCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({
    TwentyConfigService: jest.fn(),
  }),
);

jest.mock(
  'src/engine/core-modules/user-session/crons/commands/user-session-cleanup.cron.command',
  () => ({
    UserSessionCleanupCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/core-modules/workspace/crons/commands/check-custom-domain-valid-records.cron.command',
  () => ({
    CheckCustomDomainValidRecordsCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/modules/connected-account/webhook-subscription-manager/crons/commands/webhook-subscription-renewal.cron.command',
  () => ({
    WebhookSubscriptionRenewalCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/modules/emailing/crons/commands/emailing-ongoing-stale.cron.command',
  () => ({
    EmailingOngoingStaleCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/modules/emailing/crons/commands/reconcile-campaign-stats.cron.command',
  () => ({
    ReconcileCampaignStatsCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/trash-cleanup/commands/trash-cleanup.cron.command',
  () => ({
    TrashCleanupCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/crons/commands/deferred-workspace-migration-action-recovery.cron.command',
  () => ({
    DeferredWorkspaceMigrationActionRecoveryCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/workspace-manager/workspace-cleaner/commands/clean-onboarding-workspaces.cron.command',
  () => ({
    CleanOnboardingWorkspacesCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/engine/workspace-manager/workspace-cleaner/commands/clean-suspended-workspaces.cron.command',
  () => ({
    CleanSuspendedWorkspacesCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/modules/calendar/calendar-event-import-manager/crons/commands/calendar-event-list-fetch.cron.command',
  () => ({
    CalendarEventListFetchCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/modules/calendar/calendar-event-import-manager/crons/commands/calendar-import.cron.command',
  () => ({
    CalendarEventsImportCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/modules/calendar/calendar-event-import-manager/crons/commands/calendar-ongoing-stale.cron.command',
  () => ({
    CalendarOngoingStaleCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/modules/calendar/calendar-event-import-manager/crons/commands/calendar-relaunch-failed-calendar-channels.cron.command',
  () => ({
    CalendarRelaunchFailedCalendarChannelsCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/modules/messaging/message-import-manager/crons/commands/messaging-message-list-fetch.cron.command',
  () => ({
    MessagingMessageListFetchCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/modules/messaging/message-import-manager/crons/commands/messaging-messages-import.cron.command',
  () => ({
    MessagingMessagesImportCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/modules/messaging/message-import-manager/crons/commands/messaging-ongoing-stale.cron.command',
  () => ({
    MessagingOngoingStaleCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/modules/messaging/message-import-manager/crons/commands/messaging-relaunch-failed-message-channels.cron.command',
  () => ({
    MessagingRelaunchFailedMessageChannelsCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/modules/workflow/workflow-runner/workflow-run-queue/cron/command/workflow-clean-workflow-runs.cron.command',
  () => ({
    WorkflowCleanWorkflowRunsCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/modules/workflow/workflow-runner/workflow-run-queue/cron/command/workflow-handle-staled-runs.cron.command',
  () => ({
    WorkflowHandleStaledRunsCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/modules/workflow/workflow-runner/workflow-run-queue/cron/command/workflow-run-enqueue.cron.command',
  () => ({
    WorkflowRunEnqueueCronCommand: jest.fn(),
  }),
);

jest.mock(
  'src/modules/workflow/workflow-trigger/automated-trigger/crons/commands/workflow-cron-trigger.cron.command',
  () => ({
    WorkflowCronTriggerCronCommand: jest.fn(),
  }),
);

describe('CronRegisterAllCommand strict startup gate', () => {
  const run = jest.fn();
  const get = jest.fn();
  let command: CronRegisterAllCommand;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    run.mockReset().mockResolvedValue(undefined);
    get.mockReset().mockReturnValue(false);
    command = Reflect.construct(CronRegisterAllCommand, [
      ...Array.from({ length: CronRegisterAllCommand.length - 1 }, () => ({
        run,
      })),
      { get },
    ]) as CronRegisterAllCommand;
  });

  afterEach(() => jest.restoreAllMocks());

  it('keeps the parameterless best-effort call compatible', async () => {
    run.mockRejectedValue(new Error('queue unavailable'));
    await expect(command.run()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalled();
  });

  it('rejects strict registration failures after attempting remaining jobs', async () => {
    run.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(command.run([], { strict: true })).rejects.toThrow(
      'Failed to register cron jobs: MessagingMessagesImport',
    );
    expect(run.mock.calls.length).toBeGreaterThan(1);
  });

  it('allows strict success with optional jobs disabled', async () => {
    await expect(command.run([], { strict: true })).resolves.toBeUndefined();
    expect(run).toHaveBeenCalled();
  });

  it('parses the opt-in switch', () => {
    expect(command.parseStrict()).toBe(true);
  });
});
