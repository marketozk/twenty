import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
// Provider network behavior is supplied explicitly by each calendar fetch test.
jest.mock(
  'src/modules/calendar/calendar-event-import-manager/services/calendar-get-events.service',
  () => ({ CalendarGetCalendarEventsService: class {} }),
);
import {
  calendarImportCacheKey,
  legacyCalendarImportCacheKey,
} from 'src/modules/calendar/common/utils/calendar-import-cache-key';
import { CalendarEventWebhookSyncService } from 'src/modules/connected-account-sync-webhooks/calendar-event-webhook-sync/services/calendar-event-webhook-sync.service';
import { WebhookSyncTriggerService } from 'src/modules/connected-account/webhook-subscription-manager/services/webhook-sync-trigger.service';
import { BlocklistReimportMessagesJob } from 'src/modules/messaging/blocklist-manager/jobs/messaging-blocklist-reimport-messages.job';
import { BlocklistReimportCalendarEventsJob } from 'src/modules/calendar/blocklist-manager/jobs/blocklist-reimport-calendar-events.job';
import { MessagingMessageListFetchCronJob } from 'src/modules/messaging/message-import-manager/crons/jobs/messaging-message-list-fetch.cron.job';
import { MessagingMessageWebhookSyncService } from 'src/modules/connected-account-sync-webhooks/messaging-message-webhook-sync/services/messaging-message-webhook-sync.service';
import { BlocklistScope } from 'twenty-shared/types';
import { MessagingMessagesImportCronJob } from 'src/modules/messaging/message-import-manager/crons/jobs/messaging-messages-import.cron.job';
import { CalendarEventListFetchCronJob } from 'src/modules/calendar/calendar-event-import-manager/crons/jobs/calendar-event-list-fetch.cron.job';
import { CalendarEventsImportCronJob } from 'src/modules/calendar/calendar-event-import-manager/crons/jobs/calendar-events-import.cron.job';
import { CalendarTriggerEventListFetchCommand } from 'src/modules/calendar/calendar-event-import-manager/commands/calendar-trigger-event-list-fetch.command';
import { MessagingMessagesImportJob } from 'src/modules/messaging/message-import-manager/jobs/messaging-messages-import.job';
import { CalendarEventsImportJob } from 'src/modules/calendar/calendar-event-import-manager/jobs/calendar-events-import.job';
import { MessagingOngoingStaleJob } from 'src/modules/messaging/message-import-manager/jobs/messaging-ongoing-stale.job';
import { CalendarOngoingStaleJob } from 'src/modules/calendar/calendar-event-import-manager/jobs/calendar-ongoing-stale.job';
import { OnboardingRecentMessagesImportService } from 'src/modules/onboarding-recent-messages-import/services/onboarding-recent-messages-import.service';
jest.mock(
  'src/modules/onboarding-recent-messages-import/services/recent-messages.service',
  () => ({ RecentMessagesService: class {} }),
);
import {
  messageImportCacheKeys,
  legacyMessageImportCacheKeys,
} from 'src/modules/messaging/common/utils/message-import-cache-keys';
import { MessagingCleanCacheJob } from 'src/modules/messaging/message-import-manager/jobs/messaging-clean-cache';
import { MessagingMessageListFetchJob } from 'src/modules/messaging/message-import-manager/jobs/messaging-message-list-fetch.job';
import { CalendarEventListFetchJob } from 'src/modules/calendar/calendar-event-import-manager/jobs/calendar-event-list-fetch.job';
jest.mock(
  'src/modules/calendar/calendar-event-import-manager/services/calendar-fetch-events.service',
  () => ({ CalendarFetchEventsService: class {} }),
);
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { MessagingMessageListFetchService } from 'src/modules/messaging/message-import-manager/services/messaging-message-list-fetch.service';
import { MessagingRelaunchFailedMessageChannelJob } from 'src/modules/messaging/message-import-manager/jobs/messaging-relaunch-failed-message-channel.job';
import { CalendarRelaunchFailedCalendarChannelJob } from 'src/modules/calendar/calendar-event-import-manager/jobs/calendar-relaunch-failed-calendar-channel.job';
import { MessagingTriggerMessageListFetchCommand } from 'src/modules/messaging/message-import-manager/commands/messaging-trigger-message-list-fetch.command';
import {
  MessageImportDriverException,
  MessageImportDriverExceptionCode,
} from 'src/modules/messaging/message-import-manager/drivers/exceptions/message-import-driver.exception';
import {
  CalendarEventImportDriverException,
  CalendarEventImportDriverExceptionCode,
} from 'src/modules/calendar/calendar-event-import-manager/drivers/exceptions/calendar-event-import-driver.exception';
import {
  ConnectedAccountRefreshAccessTokenException,
  ConnectedAccountRefreshAccessTokenExceptionCode,
} from 'src/engine/metadata-modules/connected-account/exceptions/connected-account-refresh-tokens.exception';
import { CalendarEventsImportService } from 'src/modules/calendar/calendar-event-import-manager/services/calendar-events-import.service';
import { MessagingMessagesImportService } from 'src/modules/messaging/message-import-manager/services/messaging-messages-import.service';
import {
  CalendarEventImportErrorHandlerService,
  CalendarEventImportSyncStep,
} from 'src/modules/calendar/calendar-event-import-manager/services/calendar-event-import-exception-handler.service';
import {
  MessageImportExceptionHandlerService,
  MessageImportSyncStep,
} from 'src/modules/messaging/message-import-manager/services/messaging-import-exception-handler.service';
import { randomUUID } from 'node:crypto';
import {
  DataSource,
  EntitySchema,
  type QueryRunner,
  type Repository,
} from 'typeorm';
import {
  ConnectedAccountProvider,
  MessageChannelSyncStage,
  MessageChannelSyncStatus,
  CalendarChannelSyncStage,
  CalendarChannelSyncStatus,
  MessageFolderPendingSyncAction,
} from 'twenty-shared/types';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { MessageFolderEntity } from 'src/engine/metadata-modules/message-folder/entities/message-folder.entity';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { MessageChannelSyncStatusService } from 'src/modules/messaging/common/services/message-channel-sync-status.service';
import { CalendarChannelSyncStatusService } from 'src/modules/calendar/common/services/calendar-channel-sync-status.service';
import { bootstrapOmniAccountBinding } from 'src/modules/omnichannel/services/omni-binding-bootstrap';
import { withOrdinaryMetadataChannels } from 'src/modules/omnichannel/services/with-ordinary-metadata-channels';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';
jest.mock(
  'src/engine/metadata-modules/connected-account/entities/connected-account.entity',
  () => ({ ConnectedAccountEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/message-channel/entities/message-channel.entity',
  () => ({ MessageChannelEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity',
  () => ({ CalendarChannelEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/message-folder/entities/message-folder.entity',
  () => ({ MessageFolderEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.entity',
  () => ({ UserWorkspaceEntity: class {} }),
);
jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock(
  'src/engine/core-modules/cache-storage/services/cache-storage.service',
  () => ({ CacheStorageService: class {} }),
);
jest.mock('src/engine/core-modules/metrics/metrics.service', () => ({
  MetricsService: class {},
}));
jest.mock(
  'src/modules/connected-account/services/accounts-to-reconnect.service',
  () => ({ AccountsToReconnectService: class {} }),
);
jest.mock(
  'src/engine/subscriptions/workspace-event-broadcaster/workspace-event-broadcaster.service',
  () => ({ WorkspaceEventBroadcaster: class {} }),
);

jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);

const fixture = createOmniNativeMessageFixture({
  additionalTables: ['messageChannelMessageAssociationMessageFolder'],
});
const accountSchema = new EntitySchema<ConnectedAccountEntity>({
  name: 'SyncAccountFixture',
  target: ConnectedAccountEntity,
  schema: 'core',
  tableName: 'connectedAccount',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    provider: { type: 'text' },
    applicationId: { type: 'uuid', nullable: true },
    connectionProviderId: { type: 'uuid', nullable: true },
    userWorkspaceId: { type: 'uuid' },
    authFailedAt: { type: 'timestamptz', nullable: true },
    authFailedReason: { type: 'text', nullable: true },
    handleAliases: { type: 'jsonb', nullable: true },
  },
});
const common = {
  id: { type: 'uuid', primary: true },
  workspaceId: { type: 'uuid' },
  connectedAccountId: { type: 'uuid' },
  syncStatus: { type: 'text' },
  syncStage: { type: 'text' },
  syncCursor: { type: 'text' },
  syncStageStartedAt: { type: 'timestamptz', nullable: true },
  syncedAt: { type: 'timestamptz', nullable: true },
  throttleFailureCount: { type: 'int' },
  isSyncEnabled: { type: 'boolean' },
} as const;
const messageSchema = new EntitySchema<MessageChannelEntity>({
  name: 'SyncMessageFixture',
  target: MessageChannelEntity,
  schema: 'core',
  tableName: 'messageChannel',
  relations: {
    connectedAccount: {
      type: 'many-to-one',
      target: () => ConnectedAccountEntity,
      joinColumn: { name: 'connectedAccountId' },
    },
    messageFolders: {
      type: 'one-to-many',
      target: () => MessageFolderEntity,
      inverseSide: 'messageChannel',
    },
  },
  columns: {
    ...common,
    type: { type: 'text' },
    throttleRetryAfter: { type: 'timestamptz', nullable: true },
    pendingGroupEmailsAction: { type: 'text', nullable: true },
  },
});
const calendarSchema = new EntitySchema<CalendarChannelEntity>({
  name: 'SyncCalendarFixture',
  target: CalendarChannelEntity,
  schema: 'core',
  tableName: 'calendarChannel',
  relations: {
    connectedAccount: {
      type: 'many-to-one',
      target: () => ConnectedAccountEntity,
      joinColumn: { name: 'connectedAccountId' },
    },
  },
  columns: common,
});
const folderSchema = new EntitySchema<MessageFolderEntity>({
  name: 'SyncFolderFixture',
  target: MessageFolderEntity,
  schema: 'core',
  tableName: 'messageFolder',
  relations: {
    messageChannel: {
      type: 'many-to-one',
      target: () => MessageChannelEntity,
      joinColumn: { name: 'messageChannelId' },
      inverseSide: 'messageFolders',
    },
  },
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    messageChannelId: { type: 'uuid' },
    syncCursor: { type: 'text' },
    pendingSyncAction: { type: 'text' },
  },
});
const userSchema = new EntitySchema<UserWorkspaceEntity>({
  name: 'SyncUserFixture',
  target: UserWorkspaceEntity,
  schema: 'core',
  tableName: 'userWorkspace',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    userId: { type: 'uuid' },
  },
});
const runtime = new DataSource({
  type: 'postgres',
  url: fixture.runtimeDatabaseUrl,
  entities: [
    accountSchema,
    messageSchema,
    calendarSchema,
    folderSchema,
    userSchema,
  ],
  synchronize: false,
  migrationsRun: false,
  extra: { max: 8, statement_timeout: 10000 },
});
let ordinary: {
  account: string;
  message: string;
  calendar: string;
  userWorkspace: string;
  user: string;
  folder: string;
};
let protectedIds: typeof ordinary;
const repo = (kind: 'message' | 'calendar') =>
  kind === 'message'
    ? runtime.getRepository(MessageChannelEntity)
    : runtime.getRepository(CalendarChannelEntity);
const makeService = <T extends object>(prototype: T, dependencies: object): T =>
  Object.assign(Object.create(prototype), dependencies);
let messaging: MessageChannelSyncStatusService,
  calendar: CalendarChannelSyncStatusService;
let cache: {
    mdel: jest.Mock;
    del: jest.Mock;
    mget: jest.Mock;
    getSetLength: jest.Mock;
  },
  metrics: { incrementCounterForEvents: jest.Mock },
  broadcast: { broadcast: jest.Mock },
  reconnect: { addAccountToReconnectByKey: jest.Mock };
const bootstrap = (ids: typeof ordinary) =>
  bootstrapOmniAccountBinding(
    runtime,
    { kind: 'system', id: 'sync-test' },
    {
      workspaceId: fixture.workspaceId,
      platform: 'telegram',
      connectorInstanceId: 'sync-test',
      accountId: ids.account,
      connectedAccountId: ids.account,
      messageChannelId: ids.message,
      idempotencyKey: randomUUID(),
      expectedRevision: '0',
    },
    async () => undefined,
  );
const scheduleImport = async (kind: 'message' | 'calendar') => {
  if (kind === 'message')
    await runtime.getRepository(MessageChannelEntity).update(ordinary.message, {
      syncStage: MessageChannelSyncStage.MESSAGES_IMPORT_SCHEDULED,
      syncStageStartedAt: new Date(),
    });
  else
    await runtime
      .getRepository(CalendarChannelEntity)
      .update(ordinary.calendar, {
        syncStage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_SCHEDULED,
        syncStageStartedAt: new Date(),
      });
};
const seed = async (native = false) => {
  const ids = {
    account: randomUUID(),
    message: randomUUID(),
    calendar: randomUUID(),
    userWorkspace: randomUUID(),
    user: randomUUID(),
    folder: randomUUID(),
  };
  await runtime.getRepository(UserWorkspaceEntity).insert({
    id: ids.userWorkspace,
    workspaceId: fixture.workspaceId,
    userId: ids.user,
  });
  await runtime.getRepository(ConnectedAccountEntity).insert({
    id: ids.account,
    workspaceId: fixture.workspaceId,
    userWorkspaceId: ids.userWorkspace,
    handleAliases: [],
    provider: native
      ? ConnectedAccountProvider.APP
      : ConnectedAccountProvider.GOOGLE,
  });
  const commonData = {
    workspaceId: fixture.workspaceId,
    connectedAccountId: ids.account,
    syncCursor: 'old-cursor',
    syncStageStartedAt: new Date('2029-01-01'),
    throttleFailureCount: 2,
    isSyncEnabled: true,
  };
  await runtime.getRepository(MessageChannelEntity).insert({
    ...commonData,
    id: ids.message,
    type: 'APP' as never,
    syncStatus: MessageChannelSyncStatus.ACTIVE,
    syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
  });
  await runtime.getRepository(CalendarChannelEntity).insert({
    ...commonData,
    id: ids.calendar,
    syncStatus: CalendarChannelSyncStatus.ACTIVE,
    syncStage: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
  });
  await runtime.getRepository(MessageFolderEntity).insert({
    id: ids.folder,
    workspaceId: fixture.workspaceId,
    messageChannelId: ids.message,
    syncCursor: 'folder-cursor',
    pendingSyncAction: 'old-action' as never,
  });
  if (native) await bootstrap(ids);
  return ids;
};
beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid,ADD provider text,ADD "applicationId" uuid,ADD "connectionProviderId" uuid,ADD "userWorkspaceId" uuid,ADD "authFailedAt" timestamptz,ADD "authFailedReason" text,ADD "archivedAt" timestamptz,ADD "handleAliases" jsonb',
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageChannel" ADD "connectedAccountId" uuid REFERENCES core."connectedAccount"(id),ADD "throttleRetryAfter" timestamptz,ADD "pendingGroupEmailsAction" text,ADD "updatedAt" timestamptz DEFAULT now()',
  );
  await fixture.owner.query(
    'CREATE TABLE core."calendarChannel" (id uuid PRIMARY KEY,"workspaceId" uuid,"connectedAccountId" uuid REFERENCES core."connectedAccount"(id),"updatedAt" timestamptz DEFAULT now())',
  );
  for (const table of ['messageChannel', 'calendarChannel'])
    await fixture.owner.query(
      `ALTER TABLE core."${table}" ADD "syncStatus" text,ADD "syncStage" text,ADD "syncCursor" text,ADD "syncStageStartedAt" timestamptz,ADD "syncedAt" timestamptz,ADD "throttleFailureCount" int,ADD "isSyncEnabled" boolean`,
    );
  await fixture.owner.query(
    'ALTER TABLE core."messageFolder" ADD "syncCursor" text,ADD "pendingSyncAction" text',
  );
  await fixture.owner.query(
    'CREATE TABLE core."userWorkspace"(id uuid PRIMARY KEY,"workspaceId" uuid,"userId" uuid)',
  );
  await fixture.owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "${fixture.roleName}"`,
  );
  await runtime.initialize();
});
beforeEach(async () => {
  await fixture.reset();
  await fixture.owner.query(
    'TRUNCATE core.workspace,core."connectedAccount",core."messageChannel",core."calendarChannel",core."userWorkspace" CASCADE',
  );
  await fixture.owner.query('INSERT INTO core.workspace(id) VALUES ($1)', [
    fixture.workspaceId,
  ]);
  ordinary = await seed();
  protectedIds = await seed(true);
  cache = {
    mdel: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    mget: jest.fn().mockResolvedValue([undefined, undefined]),
    getSetLength: jest.fn().mockResolvedValue(0),
  };
  metrics = {
    incrementCounterForEvents: jest.fn().mockResolvedValue(undefined),
  };
  broadcast = { broadcast: jest.fn().mockResolvedValue(undefined) };
  reconnect = {
    addAccountToReconnectByKey: jest.fn().mockResolvedValue(undefined),
  };
  const dependencies = {
    cacheStorage: cache,
    metricsService: metrics,
    workspaceEventBroadcaster: broadcast,
    accountsToReconnectService: reconnect,
    workspaceOrmManager: {
      getWorkspaceId: () => fixture.workspaceId,
      executeInWorkspaceContext: async (work: () => Promise<unknown>) => work(),
      getRepository: () => ({
        findOne: async ({ where }: { where: { userId: string } }) => ({
          userId: where.userId,
        }),
      }),
    },
    messageChannelRepository: runtime.getRepository(MessageChannelEntity),
    calendarChannelRepository: runtime.getRepository(CalendarChannelEntity),
    connectedAccountRepository: runtime.getRepository(ConnectedAccountEntity),
    userWorkspaceRepository: runtime.getRepository(UserWorkspaceEntity),
    messageFolderRepository: new WorkspaceScopedRepository(
      runtime.getRepository(MessageFolderEntity),
    ),
    logger: { warn: jest.fn() },
  };
  messaging = makeService(
    MessageChannelSyncStatusService.prototype,
    dependencies,
  );
  calendar = makeService(
    CalendarChannelSyncStatusService.prototype,
    dependencies,
  );
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (runtime.isInitialized) await runtime.destroy();
  await fixture.dispose();
});
const messageOperations = {
  pending: (ids: string[], ws: string) =>
    messaging.markAsMessagesListFetchPending(ids, ws),
  importPending: (ids: string[], ws: string) =>
    messaging.markAsMessagesImportPending(ids, ws),
  reset: (ids: string[], ws: string) =>
    messaging.resetAndMarkAsMessagesListFetchPending(ids, ws),
  resetStart: (ids: string[], ws: string) =>
    messaging.resetSyncStageStartedAt(ids, ws),
  scheduled: (ids: string[], ws: string) =>
    messaging.markAsMessagesListFetchScheduled(ids, ws),
  conditional: (ids: string[], ws: string) =>
    messaging.markAsMessagesListFetchScheduledIfPending(ids, ws),
  ongoing: (ids: string[], ws: string) =>
    messaging.markAsMessagesListFetchOngoing(ids, ws),
  completed: (ids: string[], ws: string) =>
    messaging.markAsMessageSyncCompleted(ids, ws),
  importScheduled: (ids: string[], ws: string) =>
    messaging.markAsMessagesImportScheduled(ids, ws),
  importOngoing: (ids: string[], ws: string) =>
    messaging.markAsMessagesImportOngoing(ids, ws),
  failed: (ids: string[], ws: string) =>
    messaging.markAsFailed({
      messageChannelIds: ids,
      workspaceId: ws,
      syncStatus: MessageChannelSyncStatus.FAILED_UNKNOWN,
    }),
  authFailed: (ids: string[], ws: string) =>
    messaging.markAsFailed({
      messageChannelIds: ids,
      workspaceId: ws,
      syncStatus: MessageChannelSyncStatus.FAILED_INSUFFICIENT_PERMISSIONS,
      authFailedReason: 'expired',
    }),
};
const calendarOperations = {
  pending: (ids: string[], ws: string) =>
    calendar.markAsCalendarEventListFetchPending(ids, ws),
  ongoing: (ids: string[], ws: string) =>
    calendar.markAsCalendarEventListFetchOngoing(ids, ws),
  reset: (ids: string[], ws: string) =>
    calendar.resetAndMarkAsCalendarEventListFetchPending(ids, ws),
  resetStart: (ids: string[], ws: string) =>
    calendar.resetSyncStageStartedAt(ids, ws),
  importPending: (ids: string[], ws: string) =>
    calendar.markAsCalendarEventsImportPending(ids, ws),
  importOngoing: (ids: string[], ws: string) =>
    calendar.markAsCalendarEventsImportOngoing(ids, ws),
  completed: (ids: string[], ws: string) =>
    calendar.markAsCalendarEventSyncCompleted(ids, ws),
  failed: (ids: string[], ws: string) =>
    calendar.markAsFailedUnknownAndFlushCalendarEventsToImport(ids, ws),
  authFailed: (ids: string[], ws: string) =>
    calendar.markAsFailedInsufficientPermissionsAndFlushCalendarEventsToImport(
      ids,
      ws,
    ),
};
for (const kind of ['message', 'calendar'] as const) {
  const operations =
    kind === 'message' ? messageOperations : calendarOperations;
  describe(kind + ' actual batch status owner', () => {
    it.each(Object.entries(operations))(
      'mixed %s excludes owned rows and their side effects',
      async (_name, operation) => {
        const before = await repo(kind).findOneByOrFail({
          id: protectedIds[kind],
        });
        await operation(
          [protectedIds[kind], ordinary[kind], ordinary[kind]],
          fixture.workspaceId,
        );
        expect(
          await repo(kind).findOneByOrFail({ id: protectedIds[kind] }),
        ).toEqual(before);
        expect(
          await runtime
            .getRepository(ConnectedAccountEntity)
            .findOneByOrFail({ id: protectedIds.account }),
        ).toMatchObject({ authFailedAt: null });
        expect(
          JSON.stringify([
            cache.mdel.mock.calls,
            cache.del.mock.calls,
            metrics.incrementCounterForEvents.mock.calls,
            broadcast.broadcast.mock.calls,
            reconnect.addAccountToReconnectByKey.mock.calls,
          ]),
        ).not.toContain(protectedIds[kind]);
        expect(
          JSON.stringify(reconnect.addAccountToReconnectByKey.mock.calls),
        ).not.toContain(protectedIds.account);
      },
    );
    it.each(Object.entries(operations))(
      'unbound native %s is not ordinary work',
      async (_name, operation) => {
        await runtime
          .getRepository(ConnectedAccountEntity)
          .update(ordinary.account, { provider: ConnectedAccountProvider.APP });
        const before = await repo(kind).findOneByOrFail({ id: ordinary[kind] });
        await operation([ordinary[kind]], fixture.workspaceId);
        expect(
          await repo(kind).findOneByOrFail({ id: ordinary[kind] }),
        ).toEqual(before);
        expect(cache.mdel).not.toHaveBeenCalled();
        expect(cache.del).not.toHaveBeenCalled();
        expect(metrics.incrementCounterForEvents).not.toHaveBeenCalled();
        expect(broadcast.broadcast).not.toHaveBeenCalled();
        expect(reconnect.addAccountToReconnectByKey).not.toHaveBeenCalled();
      },
    );
    it('auth failure writes ordinary account and uses its captured recipient only', async () => {
      await operations.authFailed(
        [ordinary[kind], protectedIds[kind]],
        fixture.workspaceId,
      );
      expect(
        (
          await runtime
            .getRepository(ConnectedAccountEntity)
            .findOneByOrFail({ id: ordinary.account })
        ).authFailedAt,
      ).toBeInstanceOf(Date);
      expect(reconnect.addAccountToReconnectByKey).toHaveBeenCalledTimes(1);
      expect(
        reconnect.addAccountToReconnectByKey.mock.calls[0].slice(1),
      ).toEqual([ordinary.user, fixture.workspaceId, ordinary.account]);
    });
    it('parallel reversed batches serialize without lock upgrades or partial writes', async () => {
      const second = await seed();
      await Promise.all([
        operations.authFailed(
          [ordinary[kind], second[kind]],
          fixture.workspaceId,
        ),
        operations.authFailed(
          [second[kind], ordinary[kind]],
          fixture.workspaceId,
        ),
      ]);
      for (const id of [ordinary.account, second.account])
        expect(
          (
            await runtime
              .getRepository(ConnectedAccountEntity)
              .findOneByOrFail({ id })
          ).authFailedAt,
        ).toBeInstanceOf(Date);
    });
    it('auth write failure rolls back channel status and emits no effects', async () => {
      const before = await repo(kind).findOneByOrFail({ id: ordinary[kind] });
      await fixture.owner.query(
        `REVOKE UPDATE ON core."connectedAccount" FROM "${fixture.roleName}"`,
      );
      try {
        await expect(
          operations.authFailed([ordinary[kind]], fixture.workspaceId),
        ).rejects.toThrow('permission denied');
        expect(
          await repo(kind).findOneByOrFail({ id: ordinary[kind] }),
        ).toEqual(before);
        expect(metrics.incrementCounterForEvents).not.toHaveBeenCalled();
        expect(cache.mdel).not.toHaveBeenCalled();
        expect(cache.del).not.toHaveBeenCalled();
        expect(broadcast.broadcast).not.toHaveBeenCalled();
        expect(reconnect.addAccountToReconnectByKey).not.toHaveBeenCalled();
      } finally {
        await fixture.owner.query(
          `GRANT UPDATE ON core."connectedAccount" TO "${fixture.roleName}"`,
        );
      }
    });
    it('lost commit ACK produces no postcommit side effects', async () => {
      const original = runtime.createQueryRunner.bind(runtime);
      jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
        const runner = original(),
          commit = runner.commitTransaction.bind(runner);
        runner.commitTransaction = async () => {
          await commit();
          throw new Error('sync-lost-ACK');
        };
        return runner;
      });
      await expect(
        operations.authFailed([ordinary[kind]], fixture.workspaceId),
      ).rejects.toThrow('OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN');
      expect(
        (
          await runtime
            .getRepository(ConnectedAccountEntity)
            .findOneByOrFail({ id: ordinary.account })
        ).authFailedAt,
      ).toBeInstanceOf(Date);
      expect(metrics.incrementCounterForEvents).not.toHaveBeenCalled();
      expect(cache.mdel).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
      expect(broadcast.broadcast).not.toHaveBeenCalled();
      expect(reconnect.addAccountToReconnectByKey).not.toHaveBeenCalled();
    });
  });
}
it('conditional scheduling preserves pending/enabled predicates and returns accepted IDs only', async () => {
  const disabled = await seed(),
    ongoing = await seed();
  await repo('message').update(disabled.message, { isSyncEnabled: false });
  await runtime.getRepository(MessageChannelEntity).update(ongoing.message, {
    syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_ONGOING,
  });
  expect(
    await messaging.markAsMessagesListFetchScheduledIfPending(
      [
        protectedIds.message,
        ordinary.message,
        disabled.message,
        ongoing.message,
      ],
      fixture.workspaceId,
    ),
  ).toEqual([{ id: ordinary.message, connectedAccountId: ordinary.account }]);
  expect(
    await messaging.markAsMessagesListFetchScheduledIfPending(
      [ordinary.message],
      fixture.workspaceId,
    ),
  ).toEqual([]);
});
it('message and folder resets commit together, with only ordinary folder affected', async () => {
  await messaging.resetAndMarkAsMessagesListFetchPending(
    [ordinary.message, protectedIds.message],
    fixture.workspaceId,
  );
  expect(
    await runtime
      .getRepository(MessageFolderEntity)
      .findOneByOrFail({ id: ordinary.folder }),
  ).toMatchObject({
    syncCursor: '',
    pendingSyncAction: MessageFolderPendingSyncAction.NONE,
  });
  expect(
    await runtime
      .getRepository(MessageFolderEntity)
      .findOneByOrFail({ id: protectedIds.folder }),
  ).toMatchObject({
    syncCursor: 'folder-cursor',
    pendingSyncAction: 'old-action',
  });
  expect(
    await repo('message').findOneByOrFail({ id: ordinary.message }),
  ).toMatchObject({
    syncCursor: '',
    throttleFailureCount: 0,
    syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
  });
});
it('folder reset failure rolls back channel reset before cache and broadcast', async () => {
  const before = await repo('message').findOneByOrFail({
    id: ordinary.message,
  });
  await fixture.owner.query(
    `REVOKE UPDATE ON core."messageFolder" FROM "${fixture.roleName}"`,
  );
  try {
    await expect(
      messaging.resetAndMarkAsMessagesListFetchPending(
        [ordinary.message],
        fixture.workspaceId,
      ),
    ).rejects.toThrow('permission denied');
    expect(
      await repo('message').findOneByOrFail({ id: ordinary.message }),
    ).toEqual(before);
    expect(cache.mdel).not.toHaveBeenCalled();
    expect(broadcast.broadcast).not.toHaveBeenCalled();
  } finally {
    await fixture.owner.query(
      `GRANT UPDATE ON core."messageFolder" TO "${fixture.roleName}"`,
    );
  }
});
it('ordinary reparent during batch discovery is excluded without locking new parent out of order', async () => {
  const destination = await seed();
  const original = runtime.createQueryRunner.bind(runtime);
  let moved = false;
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
    const runner = original(),
      query = runner.query.bind(runner);
    runner.query = async (...args: Parameters<QueryRunner['query']>) => {
      const rows = await query(...args);
      if (
        !moved &&
        args[0].startsWith(
          'SELECT id, "connectedAccountId" FROM core."messageChannel"',
        ) &&
        !args[0].includes('FOR UPDATE')
      ) {
        moved = true;
        await fixture.owner.query(
          'UPDATE core."messageChannel" SET "connectedAccountId"=$2 WHERE id=$1',
          [ordinary.message, destination.account],
        );
      }
      return rows;
    };
    return runner;
  });
  expect(
    await messaging.markAsMessagesListFetchScheduledIfPending(
      [ordinary.message],
      fixture.workspaceId,
    ),
  ).toEqual([]);
  expect(moved).toBe(true);
});
it('batch helper rejects nested transaction and invalid IDs before executing work', async () => {
  const work = jest.fn();
  await runtime.transaction(async (manager) => {
    expect(() =>
      withOrdinaryMetadataChannels(
        manager,
        fixture.workspaceId,
        [ordinary.message],
        'message',
        work,
      ),
    ).toThrow('OMNI_METADATA_REQUIRES_FRESH_TRANSACTION');
  });
  expect(() =>
    withOrdinaryMetadataChannels(
      runtime.manager,
      fixture.workspaceId,
      ['invalid'],
      'message',
      work,
    ),
  ).toThrow('OMNI_INVALID_METADATA_CHANNEL_BATCH');
  expect(work).not.toHaveBeenCalled();
});

jest.mock(
  'src/engine/core-modules/exception-handler/exception-handler.service',
  () => ({ ExceptionHandlerService: class {} }),
);

jest.mock(
  'src/modules/messaging/monitoring/services/messaging-monitoring.service',
  () => ({ MessagingMonitoringService: class {} }),
);

jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({ TwentyConfigService: class {} }),
);

jest.mock('src/engine/core-modules/workspace/workspace.entity', () => ({
  WorkspaceEntity: class {},
}));

jest.mock('src/modules/blocklist/repositories/blocklist.repository', () => ({
  BlocklistRepository: class {},
}));

jest.mock(
  'src/modules/connected-account/email-alias-manager/services/email-alias-manager.service',
  () => ({ EmailAliasManagerService: class {} }),
);

jest.mock(
  'src/modules/messaging/message-import-manager/services/messaging-get-messages.service',
  () => ({ MessagingGetMessagesService: class {} }),
);

jest.mock(
  'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service',
  () => ({ MessagingSaveMessagesAndEnqueueContactCreationService: class {} }),
);

jest.mock(
  'src/modules/calendar/calendar-event-cleaner/services/calendar-event-cleaner.service',
  () => ({ CalendarEventCleanerService: class {} }),
);

jest.mock(
  'src/modules/calendar/calendar-event-import-manager/services/calendar-import-events.service',
  () => ({ CalendarImportEventsService: class {} }),
);

jest.mock(
  'src/modules/calendar/calendar-event-import-manager/services/calendar-save-events.service',
  () => ({ CalendarSaveEventsService: class {} }),
);

for (const kind of ['message', 'calendar'] as const) {
  const handler = () =>
    kind === 'message'
      ? makeService(MessageImportExceptionHandlerService.prototype, {
          messageChannelSyncStatusService: messaging,
          messagingMonitoringService: { track: jest.fn() },
          exceptionHandlerService: { captureExceptions: jest.fn() },
        })
      : makeService(CalendarEventImportErrorHandlerService.prototype, {
          calendarChannelSyncStatusService: calendar,
          exceptionHandlerService: { captureExceptions: jest.fn() },
          logger: { error: jest.fn() },
        });
  it(
    kind +
      ' credential error snapshot cannot mark the new ordinary parent as failed',
    async () => {
      const snapshot = await repo(kind).findOneByOrFail({ id: ordinary[kind] });
      const destination = await seed();
      await repo(kind).update(ordinary[kind], {
        connectedAccountId: destination.account,
      });
      const error = new ConnectedAccountRefreshAccessTokenException(
        'expired',
        ConnectedAccountRefreshAccessTokenExceptionCode.INVALID_REFRESH_TOKEN,
      );
      const h = handler();
      if (h instanceof MessageImportExceptionHandlerService)
        await h.handleDriverException(
          error,
          MessageImportSyncStep.MESSAGES_IMPORT_ONGOING,
          snapshot,
          fixture.workspaceId,
        );
      else
        await h.handleDriverException(
          error,
          CalendarEventImportSyncStep.CALENDAR_EVENTS_IMPORT,
          snapshot,
          fixture.workspaceId,
        );
      expect(
        (
          await runtime
            .getRepository(ConnectedAccountEntity)
            .findOneByOrFail({ id: destination.account })
        ).authFailedAt,
      ).toBeNull();
      expect(
        (await repo(kind).findOneByOrFail({ id: ordinary[kind] })).syncStatus,
      ).toBe(snapshot.syncStatus);
      expect(reconnect.addAccountToReconnectByKey).not.toHaveBeenCalled();
      expect(metrics.incrementCounterForEvents).not.toHaveBeenCalled();
    },
  );
  it(
    kind +
      ' actual import completion preserves unknown commit and does not replay/cache/fail',
    async () => {
      await scheduleImport(kind);
      const original = runtime.createQueryRunner.bind(runtime);
      let commits = 0;
      jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
        const runner = original(),
          commit = runner.commitTransaction.bind(runner);
        runner.commitTransaction = async () => {
          await commit();
          commits++;
          if (commits === 2) throw new Error('import-completed-ACK-lost');
        };
        return runner;
      });
      const emptyCache = {
        ...cache,
        setPop: jest.fn().mockResolvedValue([]),
        setAdd: jest.fn().mockResolvedValue(undefined),
      };
      const dependencies = {
        cacheStorage: emptyCache,
        workspaceOrmManager: {
          executeInWorkspaceContext: async (work: () => Promise<unknown>) =>
            work(),
        },
        messageChannelSyncStatusService: messaging,
        calendarChannelSyncStatusService: calendar,
        messageImportErrorHandlerService: handler(),
        calendarEventImportErrorHandlerService: handler(),
        messagingMonitoringService: { track: jest.fn() },
        logger: { error: jest.fn() },
      };
      const channel = await repo(kind).findOneByOrFail({ id: ordinary[kind] });
      const account = await runtime
        .getRepository(ConnectedAccountEntity)
        .findOneByOrFail({ id: ordinary.account });
      account.handleAliases = [];
      let work: Promise<void>;
      if (kind === 'message') {
        const message = channel as MessageChannelEntity;
        message.syncStage = MessageChannelSyncStage.MESSAGES_IMPORT_SCHEDULED;
        work = makeService(
          MessagingMessagesImportService.prototype,
          dependencies,
        ).processMessageBatchImport(message, account, fixture.workspaceId, 1);
      } else
        work = makeService(
          CalendarEventsImportService.prototype,
          dependencies,
        ).processCalendarEventsImport(
          channel as CalendarChannelEntity,
          account,
          fixture.workspaceId,
        );
      await expect(work).rejects.toThrow(
        'OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN',
      );
      expect(commits).toBe(2);
      expect(
        (await repo(kind).findOneByOrFail({ id: ordinary[kind] })).syncStatus,
      ).toBe('ACTIVE');
      expect(emptyCache.setAdd).not.toHaveBeenCalled();
      expect(cache.mdel).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
      expect(metrics.incrementCounterForEvents).not.toHaveBeenCalled();
      expect(reconnect.addAccountToReconnectByKey).not.toHaveBeenCalled();
    },
  );
}
it('input IDs are snapshotted before asynchronous workspace setup', async () => {
  const ids = [ordinary.message, protectedIds.message];
  Object.assign(messaging, {
    workspaceOrmManager: {
      getWorkspaceId: () => fixture.workspaceId,
      executeInWorkspaceContext: async (work: () => Promise<unknown>) => {
        await Promise.resolve();
        ids.splice(0, ids.length, randomUUID());
        return work();
      },
    },
  });
  await messaging.resetAndMarkAsMessagesListFetchPending(
    ids,
    fixture.workspaceId,
  );
  expect(
    (await repo('message').findOneByOrFail({ id: ordinary.message }))
      .syncCursor,
  ).toBe('');
  expect(
    (await repo('message').findOneByOrFail({ id: protectedIds.message }))
      .syncCursor,
  ).toBe('old-cursor');
});
it('wrong workspace and empty batches produce no mutations or effects', async () => {
  await messaging.resetAndMarkAsMessagesListFetchPending(
    [],
    fixture.workspaceId,
  );
  Object.assign(messaging, {
    workspaceOrmManager: {
      getWorkspaceId: () => randomUUID(),
      executeInWorkspaceContext: async (work: () => Promise<unknown>) => work(),
    },
  });
  await expect(
    messaging.resetAndMarkAsMessagesListFetchPending(
      [ordinary.message],
      fixture.workspaceId,
    ),
  ).rejects.toThrow('WORKSPACE_MISMATCH');
  expect(cache.mdel).not.toHaveBeenCalled();
  expect(broadcast.broadcast).not.toHaveBeenCalled();
});
it('unreadable ownership denies reset before all DB/cache/broadcast effects', async () => {
  const before = await repo('message').findOneByOrFail({
    id: ordinary.message,
  });
  await fixture.owner.query(
    `REVOKE SELECT ON core."omniAccountBinding" FROM "${fixture.roleName}"`,
  );
  try {
    await expect(
      messaging.resetAndMarkAsMessagesListFetchPending(
        [ordinary.message],
        fixture.workspaceId,
      ),
    ).rejects.toThrow('permission denied');
    expect(
      await repo('message').findOneByOrFail({ id: ordinary.message }),
    ).toEqual(before);
    expect(cache.mdel).not.toHaveBeenCalled();
    expect(broadcast.broadcast).not.toHaveBeenCalled();
  } finally {
    await fixture.owner.query(
      `GRANT SELECT ON core."omniAccountBinding" TO "${fixture.roleName}"`,
    );
  }
});

for (const kind of ['message', 'calendar'] as const) {
  it(
    kind +
      ' legacy binding and derived ownership exclude ordinary-provider account writes',
    async () => {
      await runtime
        .getRepository(ConnectedAccountEntity)
        .update(protectedIds.account, {
          provider: ConnectedAccountProvider.GOOGLE,
        });
      const before = await repo(kind).findOneByOrFail({
        id: protectedIds[kind],
      });
      const operation =
        kind === 'message'
          ? messageOperations.authFailed
          : calendarOperations.authFailed;
      await operation([protectedIds[kind]], fixture.workspaceId);
      expect(
        await repo(kind).findOneByOrFail({ id: protectedIds[kind] }),
      ).toEqual(before);
      await repo('message').update(protectedIds.message, {
        connectedAccountId: ordinary.account,
      });
      await operation([ordinary[kind]], fixture.workspaceId);
      expect(
        (
          await runtime
            .getRepository(ConnectedAccountEntity)
            .findOneByOrFail({ id: ordinary.account })
        ).authFailedAt,
      ).toBeNull();
      expect(reconnect.addAccountToReconnectByKey).not.toHaveBeenCalled();
      expect(metrics.incrementCounterForEvents).not.toHaveBeenCalled();
    },
  );
  it(
    kind +
      ' SQL error after channel write rolls back status and auth atomically',
    async () => {
      const before = await repo(kind).findOneByOrFail({ id: ordinary[kind] });
      const original = runtime.createQueryRunner.bind(runtime);
      let hit = false;
      jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
        const runner = original(),
          query = runner.query.bind(runner);
        runner.query = async (...args: Parameters<QueryRunner['query']>) => {
          if (args[0].startsWith('UPDATE "core"."connectedAccount"')) {
            hit = true;
            await query('SELECT 1/0');
          }
          return query(...args);
        };
        return runner;
      });
      const operation =
        kind === 'message'
          ? messageOperations.authFailed
          : calendarOperations.authFailed;
      await expect(
        operation([ordinary[kind]], fixture.workspaceId),
      ).rejects.toThrow('division by zero');
      expect(hit).toBe(true);
      expect(await repo(kind).findOneByOrFail({ id: ordinary[kind] })).toEqual(
        before,
      );
      expect(
        (
          await runtime
            .getRepository(ConnectedAccountEntity)
            .findOneByOrFail({ id: ordinary.account })
        ).authFailedAt,
      ).toBeNull();
      expect(cache.mdel).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
      expect(broadcast.broadcast).not.toHaveBeenCalled();
      expect(metrics.incrementCounterForEvents).not.toHaveBeenCalled();
      expect(reconnect.addAccountToReconnectByKey).not.toHaveBeenCalled();
    },
  );
}

jest.mock(
  'src/engine/core-modules/message-queue/services/message-queue.service',
  () => ({ MessageQueueService: class {} }),
);

for (const kind of ['message', 'calendar'] as const) {
  const temporary = async (
    snapshot: Pick<
      MessageChannelEntity,
      'id' | 'connectedAccountId' | 'throttleFailureCount'
    >,
  ) => {
    if (kind === 'message')
      return new MessageImportExceptionHandlerService(
        messaging,
        { captureExceptions: jest.fn() } as never,
        { track: jest.fn() } as never,
      ).handleDriverException(
        new MessageImportDriverException(
          'temporary',
          MessageImportDriverExceptionCode.TEMPORARY_ERROR,
        ),
        MessageImportSyncStep.MESSAGES_IMPORT_ONGOING,
        snapshot,
        fixture.workspaceId,
      );
    return new CalendarEventImportErrorHandlerService(calendar, {
      captureExceptions: jest.fn(),
    } as never).handleDriverException(
      new CalendarEventImportDriverException(
        'temporary',
        CalendarEventImportDriverExceptionCode.TEMPORARY_ERROR,
      ),
      CalendarEventImportSyncStep.CALENDAR_EVENTS_IMPORT,
      snapshot,
      fixture.workspaceId,
    );
  };
  const read = () => repo(kind).findOneByOrFail({ id: ordinary[kind] });
  const relaunch = async (id: string) => {
    const context = {
      executeInWorkspaceContext: async (work: () => Promise<unknown>) => work(),
    };
    if (kind === 'message')
      return new MessagingRelaunchFailedMessageChannelJob(
        context as never,
        runtime.getRepository(MessageChannelEntity),
      ).handle({ workspaceId: fixture.workspaceId, messageChannelId: id });
    return new CalendarRelaunchFailedCalendarChannelJob(
      context as never,
      runtime.getRepository(CalendarChannelEntity),
    ).handle({ workspaceId: fixture.workspaceId, calendarChannelId: id });
  };
  describe(kind + ' atomic temporary errors and relaunch', () => {
    it('updates count and retry stage together while preserving the stage start time', async () => {
      const before = await read();
      await temporary(before);
      expect(await read()).toMatchObject({
        throttleFailureCount: 3,
        syncStage:
          kind === 'message'
            ? 'MESSAGES_IMPORT_PENDING'
            : 'CALENDAR_EVENTS_IMPORT_PENDING',
        syncStageStartedAt: before.syncStageStartedAt,
      });
    });
    it('uses current count at the limit despite a stale low snapshot', async () => {
      const stale = await read();
      await repo(kind).update(ordinary[kind], { throttleFailureCount: 5 });
      const result = temporary(stale);
      if (kind === 'calendar')
        await expect(result).rejects.toThrow('Temporary error');
      else await result;
      expect(await read()).toMatchObject({
        throttleFailureCount: 5,
        syncStage: 'FAILED',
        syncStatus: 'FAILED_UNKNOWN',
      });
    });
    it('concurrent failures serialize threshold decisions', async () => {
      await repo(kind).update(ordinary[kind], { throttleFailureCount: 4 });
      const before = await read();
      const results = await Promise.allSettled([
        temporary(before),
        temporary(before),
      ]);
      expect(results.filter((x) => x.status === 'rejected')).toHaveLength(
        kind === 'calendar' ? 1 : 0,
      );
      expect(await read()).toMatchObject({
        throttleFailureCount: 5,
        syncStage: 'FAILED',
        syncStatus: 'FAILED_UNKNOWN',
      });
    });
    it.each(['bound', 'unbound'])(
      'ignores %s native temporary failure',
      async (mode) => {
        const id = mode === 'bound' ? protectedIds[kind] : ordinary[kind];
        if (mode === 'unbound')
          await runtime
            .getRepository(ConnectedAccountEntity)
            .update(ordinary.account, {
              provider: ConnectedAccountProvider.APP,
            });
        const before = await repo(kind).findOneByOrFail({ id });
        await temporary(before);
        expect(await repo(kind).findOneByOrFail({ id })).toEqual(before);
        expect(metrics.incrementCounterForEvents).not.toHaveBeenCalled();
        expect(broadcast.broadcast).not.toHaveBeenCalled();
        expect(cache.del).not.toHaveBeenCalled();
        expect(cache.mdel).not.toHaveBeenCalled();
      },
    );
    it('declines a temporary callback for the previous ordinary parent', async () => {
      const before = await read(),
        other = await seed();
      await repo(kind).update(ordinary[kind], {
        connectedAccountId: other.account,
      });
      await temporary(before);
      expect(await read()).toMatchObject({
        throttleFailureCount: 2,
        syncStage: before.syncStage,
      });
    });
    it('rolls back count and stage when SQL fails after the update', async () => {
      const before = await read(),
        original = runtime.createQueryRunner.bind(runtime);
      jest.spyOn(runtime, 'createQueryRunner').mockImplementationOnce(() => {
        const runner = original(),
          query = runner.query.bind(runner);
        runner.query = async (...args: Parameters<QueryRunner['query']>) => {
          const result = await query(...args);
          if (args[0].startsWith('UPDATE "core"."' + kind + 'Channel"'))
            await query('SELECT 1/0');
          return result;
        };
        return runner;
      });
      await expect(temporary(before)).rejects.toThrow();
      expect(await read()).toEqual(before);
      expect(metrics.incrementCounterForEvents).not.toHaveBeenCalled();
    });
    it('propagates unknown commit without postcommit failure effects', async () => {
      await repo(kind).update(ordinary[kind], { throttleFailureCount: 5 });
      const before = await read(),
        original = runtime.createQueryRunner.bind(runtime);
      jest.spyOn(runtime, 'createQueryRunner').mockImplementationOnce(() => {
        const runner = original(),
          commit = runner.commitTransaction.bind(runner);
        runner.commitTransaction = async () => {
          await commit();
          throw new Error('throttle ACK lost');
        };
        return runner;
      });
      await expect(temporary(before)).rejects.toThrow(
        'OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN',
      );
      expect(await read()).toMatchObject({ syncStatus: 'FAILED_UNKNOWN' });
      expect(metrics.incrementCounterForEvents).not.toHaveBeenCalled();
      expect(broadcast.broadcast).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
      expect(cache.mdel).not.toHaveBeenCalled();
    });
    it('relaunches ordinary failed-unknown but leaves protected and nonfailed rows alone', async () => {
      await repo(kind)
        .createQueryBuilder()
        .update()
        .set({
          syncStage: 'FAILED' as never,
          syncStatus: 'FAILED_UNKNOWN' as never,
        })
        .where('id IN (:...ids)', { ids: [ordinary[kind], protectedIds[kind]] })
        .execute();
      const protectedBefore = await repo(kind).findOneByOrFail({
        id: protectedIds[kind],
      });
      await relaunch(ordinary[kind]);
      await relaunch(protectedIds[kind]);
      expect(await read()).toMatchObject({
        syncStatus: 'ACTIVE',
        throttleFailureCount: 0,
      });
      expect(
        await repo(kind).findOneByOrFail({ id: protectedIds[kind] }),
      ).toEqual(protectedBefore);
      const before = await read();
      await relaunch(ordinary[kind]);
      expect(await read()).toEqual(before);
    });
  });
}
it('nonfinal imported batch resets throttle and stage atomically', async () => {
  expect(
    await messaging.markAsMessageBatchImported(
      ordinary.message,
      ordinary.account,
      fixture.workspaceId,
    ),
  ).toBe(true);
  expect(
    await repo('message').findOneByOrFail({ id: ordinary.message }),
  ).toMatchObject({
    syncStage: 'MESSAGES_IMPORT_PENDING',
    throttleFailureCount: 0,
    throttleRetryAfter: null,
    syncStageStartedAt: null,
  });
});
it.each([false, true])(
  'import completion declines stale parent (last=%s)',
  async (last) => {
    const other = await seed();
    await repo('message').update(ordinary.message, {
      connectedAccountId: other.account,
    });
    const before = await repo('message').findOneByOrFail({
      id: ordinary.message,
    });
    const result = last
      ? await messaging.markAsMessageSyncCompleted(
          [ordinary.message],
          fixture.workspaceId,
          ordinary.account,
        )
      : await messaging.markAsMessageBatchImported(
          ordinary.message,
          ordinary.account,
          fixture.workspaceId,
        );
    expect(result).toBe(false);
    expect(
      await repo('message').findOneByOrFail({ id: ordinary.message }),
    ).toEqual(before);
    expect(metrics.incrementCounterForEvents).not.toHaveBeenCalled();
    expect(broadcast.broadcast).not.toHaveBeenCalled();
  },
);
it('manual CLI queues only ordinary channels admitted by the conditional update', async () => {
  const disabled = await seed();
  await runtime
    .getRepository(MessageChannelEntity)
    .update(disabled.message, { isSyncEnabled: false });
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const command = new MessagingTriggerMessageListFetchCommand(
    {
      executeInWorkspaceContext: async (work: () => Promise<unknown>) => work(),
    } as never,
    runtime.getRepository(MessageChannelEntity),
    queue as never,
  );
  await command.run([], { workspaceId: fixture.workspaceId });
  expect(queue.add.mock.calls.map((x) => x[1].messageChannelId)).toEqual([
    ordinary.message,
  ]);
  expect(queue.add.mock.calls[0][1].expectedConnectedAccountId).toBe(
    ordinary.account,
  );
  expect(
    (await repo('message').findOneByOrFail({ id: protectedIds.message }))
      .syncStage,
  ).toBe(MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING);
});
it('manual CLI does not enqueue after an unknown schedule commit', async () => {
  const queue = { add: jest.fn().mockResolvedValue(undefined) },
    original = runtime.createQueryRunner.bind(runtime);
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
    const runner = original(),
      commit = runner.commitTransaction.bind(runner);
    runner.commitTransaction = async () => {
      await commit();
      throw new Error('CLI schedule ACK lost');
    };
    return runner;
  });
  const command = new MessagingTriggerMessageListFetchCommand(
    {
      executeInWorkspaceContext: async (work: () => Promise<unknown>) => work(),
    } as never,
    runtime.getRepository(MessageChannelEntity),
    queue as never,
  );
  await expect(
    command.run([], { workspaceId: fixture.workspaceId }),
  ).rejects.toThrow('OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN');
  expect(queue.add).not.toHaveBeenCalled();
});

jest.mock(
  'src/modules/messaging/message-cleaner/services/messaging-message-cleaner.service',
  () => ({ MessagingMessageCleanerService: class {} }),
);

jest.mock(
  'src/modules/messaging/message-folder-manager/services/sync-message-folders.service',
  () => ({ SyncMessageFoldersService: class {} }),
);

jest.mock(
  'src/modules/messaging/message-import-manager/services/messaging-get-message-list.service',
  () => ({ MessagingGetMessageListService: class {} }),
);

jest.mock(
  'src/modules/messaging/message-import-manager/services/messaging-process-group-email-actions.service',
  () => ({ MessagingProcessGroupEmailActionsService: class {} }),
);

jest.mock(
  'src/modules/messaging/message-import-manager/services/messaging-process-folder-actions.service',
  () => ({ MessagingProcessFolderActionsService: class {} }),
);

jest.mock(
  'src/modules/messaging/message-import-manager/services/messaging-cursor.service',
  () => ({ MessagingCursorService: class {} }),
);

it('actual zero-message list fetch cannot complete the replacement ordinary parent', async () => {
  const snapshot = await runtime
    .getRepository(MessageChannelEntity)
    .findOneByOrFail({ id: ordinary.message });
  snapshot.messageFolders = [];
  const other = await seed();
  const service = makeService(MessagingMessageListFetchService.prototype, {
    cacheStorage: cache,
    messageChannelSyncStatusService: messaging,
    workspaceOrmManager: {
      executeInWorkspaceContext: async (work: () => Promise<unknown>) => work(),
      getRepository: () => ({}),
    },
    syncMessageFoldersService: { syncMessageFolders: async () => [] },
    messagingGetMessageListService: {
      getMessageLists: async () => {
        await runtime
          .getRepository(MessageChannelEntity)
          .update(ordinary.message, { connectedAccountId: other.account });
        return [];
      },
    },
    messageImportErrorHandlerService: {
      handleDriverException: async (error: unknown) => {
        throw error;
      },
    },
    logger: { log: jest.fn(), debug: jest.fn(), error: jest.fn() },
  });
  await service.processMessageListFetch(snapshot, fixture.workspaceId);
  expect(
    await runtime
      .getRepository(MessageChannelEntity)
      .findOneByOrFail({ id: ordinary.message }),
  ).toMatchObject({
    connectedAccountId: other.account,
    syncStage: 'MESSAGE_LIST_FETCH_ONGOING',
    syncStatus: 'ONGOING',
  });
  expect(metrics.incrementCounterForEvents).not.toHaveBeenCalled();
  // The pre-existing list-fetch cache clear is separate from the declined final completion.
  expect(cache.mdel).toHaveBeenCalledTimes(1);
});

it('native cleanup unknown outcome bypasses import failure classification', async () => {
  const capture = { captureExceptions: jest.fn() },
    monitor = { track: jest.fn() },
    error = new NativeTransactionOutcomeUnknownError(
      'commit',
      new Error('fixture lost ACK'),
    );
  const handler = new MessageImportExceptionHandlerService(
    messaging,
    capture as never,
    monitor as never,
  );
  const before = await repo('message').findOneByOrFail({
    id: ordinary.message,
  });
  await expect(
    handler.handleDriverException(
      error,
      MessageImportSyncStep.MESSAGE_LIST_FETCH,
      before,
      fixture.workspaceId,
    ),
  ).rejects.toBe(error);
  expect(
    await repo('message').findOneByOrFail({ id: ordinary.message }),
  ).toEqual(before);
  expect(capture.captureExceptions).not.toHaveBeenCalled();
  expect(monitor.track).not.toHaveBeenCalled();
  expect(cache.mdel).not.toHaveBeenCalled();
  expect(broadcast.broadcast).not.toHaveBeenCalled();
});
it('stale folder discovery stops downstream fetch/cache/completion', async () => {
  const fetch = jest.fn(),
    completed = jest.fn();
  const service = makeService(MessagingMessageListFetchService.prototype, {
    workspaceOrmManager: {
      executeInWorkspaceContext: async (work: () => Promise<unknown>) => work(),
    },
    messageChannelSyncStatusService: {
      markAsMessagesListFetchOngoing: jest.fn(),
      markAsMessageSyncCompleted: completed,
    },
    syncMessageFoldersService: { syncMessageFolders: async () => null },
    messagingGetMessageListService: { getMessageLists: fetch },
    cacheStorage: cache,
    messageImportErrorHandlerService: {
      handleDriverException: async (error: unknown) => {
        throw error;
      },
    },
    logger: { log: jest.fn(), debug: jest.fn(), error: jest.fn() },
  });
  const before = await repo('message').findOneByOrFail({
    id: ordinary.message,
  });
  await service.processMessageListFetch(
    {
      ...before,
      pendingGroupEmailsAction: 'NONE',
      messageFolders: [],
    } as never,
    fixture.workspaceId,
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(completed).not.toHaveBeenCalled();
  expect(cache.mdel).not.toHaveBeenCalled();
});
it('stale group work aborts list fetch before folder/status/cache side effects', async () => {
  const folders = { processFolderActions: jest.fn() },
    groups = { processGroupEmailActions: jest.fn().mockResolvedValue(false) };
  const service = makeService(MessagingMessageListFetchService.prototype, {
    workspaceOrmManager: {
      executeInWorkspaceContext: async (work: () => Promise<unknown>) => work(),
    },
    messagingProcessGroupEmailActionsService: groups,
    messagingProcessFolderActionsService: folders,
    messageChannelSyncStatusService: messaging,
    cacheStorage: cache,
    messageImportErrorHandlerService: {
      handleDriverException: async (error: unknown) => {
        throw error;
      },
    },
    logger: { log: jest.fn(), debug: jest.fn(), error: jest.fn() },
  });
  const before = await repo('message').findOneByOrFail({
    id: ordinary.message,
  });
  await service.processMessageListFetch(
    {
      ...before,
      pendingGroupEmailsAction: 'GROUP_EMAILS_DELETION',
      messageFolders: [],
    } as never,
    fixture.workspaceId,
  );
  expect(groups.processGroupEmailActions).toHaveBeenCalledTimes(1);
  expect(folders.processFolderActions).not.toHaveBeenCalled();
  expect(cache.mdel).not.toHaveBeenCalled();
  expect(
    await repo('message').findOneByOrFail({ id: ordinary.message }),
  ).toEqual(before);
});

describe('reconnect scheduling and queued parent admission', () => {
  for (const kind of ['message', 'calendar'] as const) {
    const reset = (ids: string[], account = ordinary.account) =>
      kind === 'message'
        ? messaging.resetAndScheduleMessagesListFetch(
            ids,
            fixture.workspaceId,
            account,
          )
        : calendar.resetAndScheduleCalendarEventListFetch(
            ids,
            fixture.workspaceId,
            account,
          );
    const scheduled =
      kind === 'message'
        ? MessageChannelSyncStage.MESSAGE_LIST_FETCH_SCHEDULED
        : CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_SCHEDULED;
    const pendingConfiguration =
      kind === 'message'
        ? MessageChannelSyncStage.PENDING_CONFIGURATION
        : CalendarChannelSyncStage.PENDING_CONFIGURATION;
    const job = (work: jest.Mock) => {
      const commonDependencies = {
        workspaceOrmManager: {
          executeInWorkspaceContext: async (callback: () => Promise<void>) =>
            callback(),
        },
        messageChannelRepository: runtime.getRepository(MessageChannelEntity),
        calendarChannelRepository: runtime.getRepository(CalendarChannelEntity),
      };
      return kind === 'message'
        ? makeService(MessagingMessageListFetchJob.prototype, {
            ...commonDependencies,
            messagingMessageListFetchService: { processMessageListFetch: work },
            messagingMonitoringService: { track: jest.fn() },
            messageImportErrorHandlerService: {
              handleDriverException: jest.fn(async (error) => {
                throw error;
              }),
            },
          })
        : makeService(CalendarEventListFetchJob.prototype, {
            ...commonDependencies,
            calendarFetchEventsService: { fetchCalendarEvents: work },
          });
    };
    const run = (work: jest.Mock, account = ordinary.account) =>
      job(work).handle({
        workspaceId: fixture.workspaceId,
        messageChannelId: ordinary.message,
        calendarChannelId: ordinary.calendar,
        expectedConnectedAccountId: account,
      });
    it(
      kind +
        ' commits reset and scheduled together then job accepts same parent',
      async () => {
        expect(await reset([ordinary[kind]])).toEqual([ordinary[kind]]);
        expect(
          await repo(kind).findOneByOrFail({ id: ordinary[kind] }),
        ).toMatchObject({
          syncCursor: '',
          syncStage: scheduled,
          syncStatus: 'ONGOING',
          throttleFailureCount: 0,
        });
        const work = jest.fn();
        await run(work);
        expect(work).toHaveBeenCalledTimes(1);
        expect(work.mock.calls[0][0].connectedAccountId).toBe(ordinary.account);
      },
    );
    it.each(['parent', 'disabled', 'configuration', 'owned'] as const)(
      kind + ' refuses %s before reset without effects',
      async (mutation) => {
        if (mutation === 'parent')
          await repo(kind).update(ordinary[kind], {
            connectedAccountId: (await seed()).account,
          });
        if (mutation === 'disabled')
          await repo(kind).update(ordinary[kind], { isSyncEnabled: false });
        if (mutation === 'configuration')
          await runtime.query(
            `UPDATE core."${kind}Channel" SET "syncStage"=$2 WHERE id=$1`,
            [ordinary[kind], pendingConfiguration],
          );
        if (mutation === 'owned') {
          await runtime
            .getRepository(ConnectedAccountEntity)
            .update(ordinary.account, {
              provider: ConnectedAccountProvider.APP,
            });
          await bootstrap(ordinary);
          await runtime
            .getRepository(ConnectedAccountEntity)
            .update(ordinary.account, {
              provider: ConnectedAccountProvider.GOOGLE,
            });
        }
        const before = await repo(kind).findOneByOrFail({ id: ordinary[kind] });
        expect(await reset([ordinary[kind]])).toEqual([]);
        expect(
          await repo(kind).findOneByOrFail({ id: ordinary[kind] }),
        ).toEqual(before);
        expect(cache.mdel).not.toHaveBeenCalled();
        expect(cache.del).not.toHaveBeenCalled();
        expect(broadcast.broadcast).not.toHaveBeenCalled();
      },
    );
    it(kind + ' returns only accepted IDs in a mixed batch', async () => {
      const other = await seed();
      expect(
        await reset([
          other[kind],
          protectedIds[kind],
          ordinary[kind],
          ordinary[kind],
          randomUUID(),
        ]),
      ).toEqual([ordinary[kind]]);
      expect(
        (await repo(kind).findOneByOrFail({ id: other[kind] })).syncCursor,
      ).toBe('old-cursor');
    });
    it.each(['parent', 'disabled', 'configuration', 'owned'] as const)(
      kind + ' rejects queued job after %s changes',
      async (mutation) => {
        await reset([ordinary[kind]]);
        if (mutation === 'parent')
          await repo(kind).update(ordinary[kind], {
            connectedAccountId: (await seed()).account,
          });
        if (mutation === 'disabled')
          await repo(kind).update(ordinary[kind], { isSyncEnabled: false });
        if (mutation === 'configuration')
          await runtime.query(
            `UPDATE core."${kind}Channel" SET "syncStage"=$2 WHERE id=$1`,
            [ordinary[kind], pendingConfiguration],
          );
        if (mutation === 'owned') {
          await runtime
            .getRepository(ConnectedAccountEntity)
            .update(ordinary.account, {
              provider: ConnectedAccountProvider.APP,
            });
          await bootstrap(ordinary);
          await runtime
            .getRepository(ConnectedAccountEntity)
            .update(ordinary.account, {
              provider: ConnectedAccountProvider.GOOGLE,
            });
        }
        const work = jest.fn();
        await run(work);
        expect(work).not.toHaveBeenCalled();
      },
    );
    it(
      kind + ' unknown reset commit emits no cache/broadcast/accepted IDs',
      async () => {
        const original = runtime.createQueryRunner.bind(runtime);
        jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
          const runner = original(),
            commit = runner.commitTransaction.bind(runner);
          runner.commitTransaction = async () => {
            await commit();
            throw new Error('reset ACK lost');
          };
          return runner;
        });
        await expect(reset([ordinary[kind]])).rejects.toThrow(
          'OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN',
        );
        expect(cache.mdel).not.toHaveBeenCalled();
        expect(cache.del).not.toHaveBeenCalled();
        expect(broadcast.broadcast).not.toHaveBeenCalled();
      },
    );
    it(
      kind + ' unknown job admission commit prevents provider work',
      async () => {
        await reset([ordinary[kind]]);
        const original = runtime.createQueryRunner.bind(runtime);
        jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
          const runner = original(),
            commit = runner.commitTransaction.bind(runner);
          runner.commitTransaction = async () => {
            await commit();
            throw new Error('admission ACK lost');
          };
          return runner;
        });
        const work = jest.fn();
        await expect(run(work)).rejects.toThrow(
          'OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN',
        );
        expect(work).not.toHaveBeenCalled();
      },
    );
  }
});

describe('account-scoped import cache and legacy recovery', () => {
  const keys = (account = ordinary.account) =>
    messageImportCacheKeys({
      workspaceId: fixture.workspaceId,
      messageChannelId: ordinary.message,
      connectedAccountId: account,
    });
  const legacy = () =>
    legacyMessageImportCacheKeys(fixture.workspaceId, ordinary.message);
  const memory = () => {
    const values = new Map<string, unknown>();
    cache.mget.mockImplementation(async (names: string[]) =>
      names.map((name) => values.get(name)),
    );
    cache.mdel.mockImplementation(async (names: string[]) => {
      for (const name of names) values.delete(name);
    });
    cache.getSetLength.mockImplementation(
      async (name: string) =>
        (values.get(name) as Set<string> | undefined)?.size ?? 0,
    );
    return values;
  };
  it('reset after commit clears only its captured account even after reparent', async () => {
    const other = await seed(),
      values = memory(),
      oldKeys = keys(),
      newKeys = keys(other.account);
    for (const name of Object.values(oldKeys)) values.set(name, 1);
    for (const name of Object.values(newKeys)) values.set(name, 2);
    const original = runtime.createQueryRunner.bind(runtime);
    let moved = false;
    jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
      const runner = original(),
        commit = runner.commitTransaction.bind(runner);
      runner.commitTransaction = async () => {
        await commit();
        if (!moved) {
          moved = true;
          await fixture.owner.query(
            'UPDATE core."messageChannel" SET "connectedAccountId"=$2 WHERE id=$1',
            [ordinary.message, other.account],
          );
        }
      };
      return runner;
    });
    await messaging.resetAndScheduleMessagesListFetch(
      [ordinary.message],
      fixture.workspaceId,
      ordinary.account,
    );
    for (const name of Object.values(oldKeys))
      expect(values.has(name)).toBe(false);
    for (const name of Object.values(newKeys)) expect(values.get(name)).toBe(2);
  });
  it('progress reads the current account namespace, never the previous one', async () => {
    const other = await seed(),
      values = memory();
    values.set(keys().total, 100);
    values.set(keys().imported, 50);
    values.set(keys(other.account).total, 20);
    values.set(keys(other.account).imported, 5);
    expect(
      await messaging.getImportProgress({
        workspaceId: fixture.workspaceId,
        messageChannelId: ordinary.message,
      }),
    ).toBe(50);
    await repo('message').update(ordinary.message, {
      connectedAccountId: other.account,
    });
    expect(
      await messaging.getImportProgress({
        workspaceId: fixture.workspaceId,
        messageChannelId: ordinary.message,
      }),
    ).toBe(25);
  });
  it('protected or missing channel exposes no import progress', async () => {
    for (const id of [protectedIds.message, randomUUID()])
      expect(
        await messaging.getImportProgress({
          workspaceId: fixture.workspaceId,
          messageChannelId: id,
        }),
      ).toBeNull();
    expect(cache.mget).not.toHaveBeenCalled();
  });
  it.each(['pending', 'total', 'imported'] as const)(
    'legacy %s triggers reset/refetch and preserves pending actions',
    async (field) => {
      const values = memory(),
        oldKeys = legacy();
      values.set(
        oldKeys[field],
        field === 'pending' ? new Set(['untrusted-id']) : 1,
      );
      await repo('message').update(ordinary.message, {
        pendingGroupEmailsAction: 'GROUP_EMAILS_DELETION' as never,
      });
      expect(
        await messaging.recoverLegacyMessageImport(
          ordinary.message,
          fixture.workspaceId,
          ordinary.account,
        ),
      ).toBe(true);
      expect(
        await repo('message').findOneByOrFail({ id: ordinary.message }),
      ).toMatchObject({
        syncCursor: '',
        syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
        pendingGroupEmailsAction: 'GROUP_EMAILS_DELETION',
      });
      expect(
        await runtime
          .getRepository(MessageFolderEntity)
          .findOneByOrFail({ id: ordinary.folder }),
      ).toMatchObject({ syncCursor: '', pendingSyncAction: 'old-action' });
      for (const name of Object.values(oldKeys))
        expect(values.has(name)).toBe(false);
    },
  );
  it('legacy stale parent stops import without deleting backlog or resetting new parent', async () => {
    const values = memory(),
      oldKeys = legacy();
    values.set(oldKeys.pending, new Set(['untrusted']));
    const other = await seed();
    await repo('message').update(ordinary.message, {
      connectedAccountId: other.account,
    });
    expect(
      await messaging.recoverLegacyMessageImport(
        ordinary.message,
        fixture.workspaceId,
        ordinary.account,
      ),
    ).toBe(true);
    expect(values.has(oldKeys.pending)).toBe(true);
    expect(
      (await repo('message').findOneByOrFail({ id: ordinary.message }))
        .syncCursor,
    ).toBe('old-cursor');
    expect(cache.mdel).not.toHaveBeenCalled();
  });
  it('legacy unknown commit keeps backlog and emits no cleanup', async () => {
    const values = memory(),
      oldKeys = legacy();
    values.set(oldKeys.pending, new Set(['untrusted']));
    const original = runtime.createQueryRunner.bind(runtime);
    jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
      const runner = original(),
        commit = runner.commitTransaction.bind(runner);
      runner.commitTransaction = async () => {
        await commit();
        throw new Error('legacy reset ACK lost');
      };
      return runner;
    });
    await expect(
      messaging.recoverLegacyMessageImport(
        ordinary.message,
        fixture.workspaceId,
        ordinary.account,
      ),
    ).rejects.toThrow('OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN');
    expect(values.has(oldKeys.pending)).toBe(true);
    expect(cache.mdel).not.toHaveBeenCalled();
  });
  it('missing legacy backlog leaves current cursor unchanged', async () => {
    memory();
    expect(
      await messaging.recoverLegacyMessageImport(
        ordinary.message,
        fixture.workspaceId,
        ordinary.account,
      ),
    ).toBe(false);
    expect(
      (await repo('message').findOneByOrFail({ id: ordinary.message }))
        .syncCursor,
    ).toBe('old-cursor');
    expect(cache.mdel).not.toHaveBeenCalled();
  });
  it('old cleanup payload cannot delete either account namespace', async () => {
    const values = memory(),
      other = randomUUID();
    for (const name of [
      ...Object.values(keys()),
      ...Object.values(keys(other)),
      ...Object.values(legacy()),
    ])
      values.set(name, 1);
    const cleaner = makeService(MessagingCleanCacheJob.prototype, {
      cacheStorage: cache,
    });
    await cleaner.handle({
      workspaceId: fixture.workspaceId,
      messageChannelId: ordinary.message,
    });
    for (const name of [
      ...Object.values(keys()),
      ...Object.values(keys(other)),
    ])
      expect(values.has(name)).toBe(true);
    for (const name of Object.values(legacy()))
      expect(values.has(name)).toBe(false);
    await cleaner.handle({
      workspaceId: fixture.workspaceId,
      messageChannelId: ordinary.message,
      connectedAccountId: ordinary.account,
    });
    for (const name of Object.values(keys()))
      expect(values.has(name)).toBe(false);
    for (const name of Object.values(keys(other)))
      expect(values.has(name)).toBe(true);
  });
  it('actual importer refuses legacy backlog before pop/provider/completed', async () => {
    await scheduleImport('message');
    const values = memory();
    values.set(legacy().pending, new Set(['untrusted']));
    const setPop = jest.fn(),
      getMessages = jest.fn(),
      track = jest.fn();
    const importer = makeService(MessagingMessagesImportService.prototype, {
      cacheStorage: { ...cache, setPop },
      messageChannelSyncStatusService: messaging,
      workspaceOrmManager: {
        executeInWorkspaceContext: async (work: () => Promise<void>) => work(),
      },
      messagingGetMessagesService: { getMessages },
      messagingMonitoringService: { track },
    });
    const channel = await runtime
      .getRepository(MessageChannelEntity)
      .findOneByOrFail({ id: ordinary.message });
    channel.syncStage = MessageChannelSyncStage.MESSAGES_IMPORT_SCHEDULED;
    const account = await runtime
      .getRepository(ConnectedAccountEntity)
      .findOneByOrFail({ id: ordinary.account });
    await importer.processMessageBatchImport(
      channel,
      account,
      fixture.workspaceId,
      1,
    );
    expect(setPop).not.toHaveBeenCalled();
    expect(getMessages).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });
  it('actual importer requeues errors only to captured account with TTL', async () => {
    await scheduleImport('message');
    memory();
    const other = await seed();
    const channel = await runtime
      .getRepository(MessageChannelEntity)
      .findOneByOrFail({ id: ordinary.message });
    channel.syncStage = MessageChannelSyncStage.MESSAGES_IMPORT_SCHEDULED;
    const account = await runtime
      .getRepository(ConnectedAccountEntity)
      .findOneByOrFail({ id: ordinary.account });
    account.handleAliases = [];
    const setPop = jest.fn().mockResolvedValue(['from-A']),
      setAdd = jest.fn();
    const importer = makeService(MessagingMessagesImportService.prototype, {
      cacheStorage: { ...cache, setPop, setAdd },
      messageChannelSyncStatusService: messaging,
      workspaceOrmManager: {
        executeInWorkspaceContext: async (work: () => Promise<void>) => work(),
      },
      messagingGetMessagesService: {
        getMessages: async () => {
          channel.connectedAccountId = other.account;
          account.id = other.account;
          throw new Error('provider interrupted');
        },
      },
      messagingMonitoringService: { track: jest.fn() },
      logger: { error: jest.fn() },
      messageImportErrorHandlerService: { handleDriverException: jest.fn() },
    });
    await importer.processMessageBatchImport(
      channel,
      account,
      fixture.workspaceId,
      1,
    );
    expect(setPop).toHaveBeenCalledWith(keys().pending, 1);
    expect(setAdd).toHaveBeenCalledWith(
      keys().pending,
      ['from-A'],
      7 * 24 * 60 * 60 * 1000,
    );
  });
});

it('cache namespace canonicalizes UUIDs and separates tenant and account', () => {
  const scope = {
    workspaceId: fixture.workspaceId,
    messageChannelId: ordinary.message,
    connectedAccountId: ordinary.account,
  };
  const current = messageImportCacheKeys(scope);
  expect(
    messageImportCacheKeys({
      ...scope,
      connectedAccountId: ordinary.account.toUpperCase(),
    }),
  ).toEqual(current);
  expect(
    messageImportCacheKeys({ ...scope, connectedAccountId: randomUUID() })
      .pending,
  ).not.toBe(current.pending);
  expect(
    messageImportCacheKeys({ ...scope, workspaceId: randomUUID() }).pending,
  ).not.toBe(current.pending);
});
it('cache namespace rejects invalid IDs before any cache use', () => {
  const scope = {
    workspaceId: fixture.workspaceId,
    messageChannelId: ordinary.message,
    connectedAccountId: ordinary.account,
  };
  for (const field of Object.keys(scope))
    expect(() =>
      messageImportCacheKeys({ ...scope, [field]: '../bad:key' }),
    ).toThrow('INVALID_MESSAGE_IMPORT_CACHE_SCOPE');
});
for (const producer of ['list-fetch', 'onboarding'] as const) {
  it(
    producer + ' caches delayed provider IDs only under captured account',
    async () => {
      const other = await seed();
      const channel = await runtime
        .getRepository(MessageChannelEntity)
        .findOne({
          where: { id: ordinary.message },
          relations: { connectedAccount: true, messageFolders: true },
        });
      if (!channel) throw new Error('missing test channel');
      const oldKeys = messageImportCacheKeys({
        workspaceId: fixture.workspaceId,
        messageChannelId: ordinary.message,
        connectedAccountId: ordinary.account,
      });
      const targetKeys = messageImportCacheKeys({
        workspaceId: fixture.workspaceId,
        messageChannelId: ordinary.message,
        connectedAccountId: other.account,
      });
      const testCache = {
        ...cache,
        setAdd: jest.fn(),
        set: jest.fn(),
        getSetLength: jest.fn().mockResolvedValue(1),
      };
      const provider = async () => {
        await repo('message').update(ordinary.message, {
          connectedAccountId: other.account,
        });
        return ['from-original-account'];
      };
      const status = {
        markAsMessagesListFetchOngoing: jest.fn(),
        markAsMessagesImportScheduled: jest.fn(),
        markAsMessagesListFetchPending: jest.fn(),
      };
      const importBatch = jest.fn();
      const dependencies = {
        cacheStorage: testCache,
        messageChannelRepository: runtime.getRepository(MessageChannelEntity),
        workspaceOrmManager: {
          executeInWorkspaceContext: async (work: () => Promise<void>) =>
            work(),
          getRepository: () => ({ find: async () => [] }),
        },
        messageChannelSyncStatusService: status,
        messagingMessagesImportService: {
          processMessageBatchImport: importBatch,
        },
        logger: {
          log: jest.fn(),
          debug: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
        },
      };
      if (producer === 'list-fetch') {
        const service = makeService(
          MessagingMessageListFetchService.prototype,
          {
            ...dependencies,
            processPendingGroupEmailActions: async () => false,
            processPendingFolderActions: async () => null,
            syncMessageFoldersService: { syncMessageFolders: async () => [] },
            messagingGetMessageListService: {
              getMessageLists: async () => [
                {
                  messageExternalIds: await provider(),
                  messageExternalIdsToDelete: [],
                  previousSyncCursor: 'previous',
                  nextSyncCursor: 'next',
                },
              ],
            },
            messagingCursorService: { updateCursor: jest.fn() },
            messageImportErrorHandlerService: {
              handleDriverException: async (error: unknown) => {
                throw error;
              },
            },
          },
        );
        await service.processMessageListFetch(channel, fixture.workspaceId);
        expect(cache.mdel).toHaveBeenCalledWith(Object.values(oldKeys));
        expect(testCache.set).toHaveBeenCalledWith(
          oldKeys.total,
          1,
          7 * 24 * 60 * 60 * 1000,
        );
      } else {
        const service = makeService(
          OnboardingRecentMessagesImportService.prototype,
          {
            ...dependencies,
            recentMessagesService: { getExternalIds: provider },
          },
        );
        await service.importRecentMessages({
          workspaceId: fixture.workspaceId,
          messageChannelId: ordinary.message,
        });
      }
      expect(testCache.setAdd).toHaveBeenCalledWith(
        oldKeys.pending,
        ['from-original-account'],
        7 * 24 * 60 * 60 * 1000,
      );
      expect(
        testCache.setAdd.mock.calls.some(
          (call) => call[0] === targetKeys.pending,
        ),
      ).toBe(false);
    },
  );
}

describe('remaining scheduling owners', () => {
  const definitions = [
    {
      name: 'message list cron',
      kind: 'message',
      prototype: MessagingMessageListFetchCronJob.prototype,
      pending: MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
      scheduled: MessageChannelSyncStage.MESSAGE_LIST_FETCH_SCHEDULED,
      cli: false,
    },
    {
      name: 'message import cron',
      kind: 'message',
      prototype: MessagingMessagesImportCronJob.prototype,
      pending: MessageChannelSyncStage.MESSAGES_IMPORT_PENDING,
      scheduled: MessageChannelSyncStage.MESSAGES_IMPORT_SCHEDULED,
      cli: false,
    },
    {
      name: 'calendar list cron',
      kind: 'calendar',
      prototype: CalendarEventListFetchCronJob.prototype,
      pending: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
      scheduled: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_SCHEDULED,
      cli: false,
    },
    {
      name: 'calendar import cron',
      kind: 'calendar',
      prototype: CalendarEventsImportCronJob.prototype,
      pending: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_PENDING,
      scheduled: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_SCHEDULED,
      cli: false,
    },
    {
      name: 'calendar list CLI',
      kind: 'calendar',
      prototype: CalendarTriggerEventListFetchCommand.prototype,
      pending: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
      scheduled: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_SCHEDULED,
      cli: true,
    },
  ] as const;
  for (const definition of definitions) {
    const { kind, pending, scheduled } = definition;
    const prepare = async (mutation: string) => {
      await runtime.query(
        `UPDATE core."${kind}Channel" SET "syncStage"=$1,"syncStageStartedAt"=NULL`,
        [pending],
      );
      const repository = repo(kind) as Repository<
          MessageChannelEntity | CalendarChannelEntity
        >,
        find = repository.find.bind(repository);
      jest.spyOn(repository, 'find').mockImplementationOnce(async () => {
        const candidates = await find({
          where: { workspaceId: fixture.workspaceId },
        });
        if (mutation === 'disabled')
          await repository.update(ordinary[kind], { isSyncEnabled: false });
        if (mutation === 'stage')
          await runtime.query(
            `UPDATE core."${kind}Channel" SET "syncStage"='PENDING_CONFIGURATION' WHERE id=$1`,
            [ordinary[kind]],
          );
        if (mutation === 'owned') {
          await runtime
            .getRepository(ConnectedAccountEntity)
            .update(ordinary.account, {
              provider: ConnectedAccountProvider.APP,
            });
          await bootstrap(ordinary);
        }
        return candidates;
      });
      const add = jest.fn(),
        captureExceptions = jest.fn();
      if (mutation === 'queue-failure')
        add.mockRejectedValue(new Error('queue unavailable'));
      const dependencies = {
        messageChannelRepository: runtime.getRepository(MessageChannelEntity),
        calendarChannelRepository: runtime.getRepository(CalendarChannelEntity),
        messageQueueService: { add },
        messageChannelSyncStatusService: messaging,
        exceptionHandlerService: { captureExceptions },
        workspaceOrmManager: {
          executeInWorkspaceContext: async (work: () => Promise<void>) =>
            work(),
        },
        logger: { log: jest.fn(), warn: jest.fn() },
      };
      if (mutation === 'unknown') {
        const original = runtime.createQueryRunner.bind(runtime);
        jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
          const runner = original(),
            commit = runner.commitTransaction.bind(runner);
          runner.commitTransaction = async () => {
            await commit();
            throw new Error('schedule ACK lost');
          };
          return runner;
        });
      }
      const run = () =>
        definition.cli
          ? makeService(
              CalendarTriggerEventListFetchCommand.prototype,
              dependencies,
            ).run([], { workspaceId: fixture.workspaceId })
          : makeService(
              definition.prototype as MessagingMessagesImportCronJob,
              dependencies,
            ).handle();
      return { run, add, captureExceptions };
    };
    it.each([
      'ordinary',
      'disabled',
      'stage',
      'owned',
      'unknown',
      'queue-failure',
    ])(
      definition.name + ' handles %s after candidate scan',
      async (mutation) => {
        const { run, add, captureExceptions } = await prepare(mutation);
        if (definition.cli && ['unknown', 'queue-failure'].includes(mutation))
          await expect(run()).rejects.toThrow();
        else await run();
        if (mutation === 'ordinary') {
          expect(add).toHaveBeenCalledTimes(1);
          expect(add.mock.calls[0][1]).toMatchObject({
            workspaceId: fixture.workspaceId,
            expectedConnectedAccountId: ordinary.account,
            [kind + 'ChannelId']: ordinary[kind],
          });
          expect(
            (await repo(kind).findOneByOrFail({ id: ordinary[kind] }))
              .syncStage,
          ).toBe(scheduled);
        } else if (mutation === 'queue-failure') {
          expect(add).toHaveBeenCalledTimes(1);
          expect(
            (await repo(kind).findOneByOrFail({ id: ordinary[kind] }))
              .syncStage,
          ).toBe(scheduled);
        } else expect(add).not.toHaveBeenCalled();
        expect(
          (await repo(kind).findOneByOrFail({ id: protectedIds[kind] }))
            .syncStage,
        ).toBe(pending);
        if (!definition.cli && ['unknown', 'queue-failure'].includes(mutation))
          expect(captureExceptions).toHaveBeenCalledTimes(1);
      },
    );
  }
});

for (const kind of ['message', 'calendar'] as const) {
  const scheduled =
    kind === 'message'
      ? MessageChannelSyncStage.MESSAGES_IMPORT_SCHEDULED
      : CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_SCHEDULED;
  const pending =
    kind === 'message'
      ? MessageChannelSyncStage.MESSAGES_IMPORT_PENDING
      : CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_PENDING;
  it.each(['stale', 'new-time', 'new-stage', 'owned', 'unknown'])(
    kind + ' watchdog rechecks %s under owner',
    async (mutation) => {
      await runtime.query(
        `UPDATE core."${kind}Channel" SET "syncStage"=$1,"syncStageStartedAt"='2020-01-01'`,
        [scheduled],
      );
      const repository = repo(kind) as Repository<
          MessageChannelEntity | CalendarChannelEntity
        >,
        find = repository.find.bind(repository);
      jest.spyOn(repository, 'find').mockImplementationOnce(async () => {
        const before = await find({
          where: { workspaceId: fixture.workspaceId },
        });
        if (mutation === 'new-time')
          await repository.update(ordinary[kind], {
            syncStageStartedAt: new Date(),
          });
        if (mutation === 'new-stage')
          await runtime.query(
            `UPDATE core."${kind}Channel" SET "syncStage"='PENDING_CONFIGURATION' WHERE id=$1`,
            [ordinary[kind]],
          );
        if (mutation === 'owned') {
          await runtime
            .getRepository(ConnectedAccountEntity)
            .update(ordinary.account, {
              provider: ConnectedAccountProvider.APP,
            });
          await bootstrap(ordinary);
        }
        return before;
      });
      if (mutation === 'unknown') {
        const original = runtime.createQueryRunner.bind(runtime);
        jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
          const runner = original(),
            commit = runner.commitTransaction.bind(runner);
          runner.commitTransaction = async () => {
            await commit();
            throw new Error('stale reset ACK lost');
          };
          return runner;
        });
      }
      const dependencies = {
        messageChannelRepository: runtime.getRepository(MessageChannelEntity),
        calendarChannelRepository: runtime.getRepository(CalendarChannelEntity),
        messageChannelSyncStatusService: messaging,
        calendarChannelSyncStatusService: calendar,
        workspaceOrmManager: {
          executeInWorkspaceContext: async (work: () => Promise<void>) =>
            work(),
        },
        logger: { log: jest.fn() },
      };
      const work =
        kind === 'message'
          ? makeService(
              MessagingOngoingStaleJob.prototype,
              dependencies,
            ).handle({ workspaceId: fixture.workspaceId })
          : makeService(CalendarOngoingStaleJob.prototype, dependencies).handle(
              { workspaceId: fixture.workspaceId },
            );
      if (mutation === 'unknown') {
        await expect(work).rejects.toThrow(
          'OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN',
        );
        expect(broadcast.broadcast).not.toHaveBeenCalled();
      } else await work;
      const after = await repo(kind).findOneByOrFail({ id: ordinary[kind] });
      expect(after.syncStage).toBe(
        ['stale', 'unknown'].includes(mutation)
          ? pending
          : mutation === 'new-stage'
            ? 'PENDING_CONFIGURATION'
            : scheduled,
      );
      if (mutation === 'stale') expect(after.syncStageStartedAt).toBeNull();
      expect(
        (await repo(kind).findOneByOrFail({ id: protectedIds[kind] }))
          .syncStage,
      ).toBe(scheduled);
    },
  );
  it.each([
    'ordinary',
    'parent',
    'disabled',
    'owned',
    'legacy-payload',
    'unknown',
  ])(kind + ' import job admission handles %s', async (mutation) => {
    await runtime.query(
      `UPDATE core."${kind}Channel" SET "syncStage"=$1 WHERE id=$2`,
      [scheduled, ordinary[kind]],
    );
    if (mutation === 'parent')
      await repo(kind).update(ordinary[kind], {
        connectedAccountId: (await seed()).account,
      });
    if (mutation === 'disabled')
      await repo(kind).update(ordinary[kind], { isSyncEnabled: false });
    if (mutation === 'owned') {
      await runtime
        .getRepository(ConnectedAccountEntity)
        .update(ordinary.account, { provider: ConnectedAccountProvider.APP });
      await bootstrap(ordinary);
    }
    if (mutation === 'unknown') {
      const original = runtime.createQueryRunner.bind(runtime);
      jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
        const runner = original(),
          commit = runner.commitTransaction.bind(runner);
        runner.commitTransaction = async () => {
          await commit();
          throw new Error('import admission ACK lost');
        };
        return runner;
      });
    }
    const process = jest.fn();
    const dependencies = {
      messageChannelRepository: runtime.getRepository(MessageChannelEntity),
      calendarChannelRepository: runtime.getRepository(CalendarChannelEntity),
      workspaceOrmManager: {
        executeInWorkspaceContext: async (work: () => Promise<void>) => work(),
      },
      messagingMonitoringService: { track: jest.fn() },
      messagingMessagesImportService: { processMessageBatchImport: process },
      calendarEventsImportService: { processCalendarEventsImport: process },
    };
    const payload = {
      workspaceId: fixture.workspaceId,
      messageChannelId: ordinary.message,
      calendarChannelId: ordinary.calendar,
      ...(mutation === 'legacy-payload'
        ? {}
        : { expectedConnectedAccountId: ordinary.account }),
    };
    const work =
      kind === 'message'
        ? makeService(
            MessagingMessagesImportJob.prototype,
            dependencies,
          ).handle(payload)
        : makeService(CalendarEventsImportJob.prototype, dependencies).handle(
            payload,
          );
    if (mutation === 'unknown')
      await expect(work).rejects.toThrow(
        'OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN',
      );
    else await work;
    expect(process).toHaveBeenCalledTimes(
      ['ordinary', 'legacy-payload'].includes(mutation) ? 1 : 0,
    );
  });
}

for (const kind of ['message', 'calendar'] as const) {
  it.each([
    'ordinary',
    'parent',
    'custodian',
    'owned',
    'global-overlap',
    'global-transfer',
    'unknown',
    'missing-member',
  ])(
    kind + ' blocklist reimport preserves selected owner: %s',
    async (mutation) => {
      const ws = fixture.workspaceId;
      const other = await seed();
      const memberId = randomUUID();
      const pending =
        kind === 'message'
          ? MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING
          : CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING;
      await runtime.query(
        `UPDATE core."${kind}Channel" SET "syncStage"='PENDING_CONFIGURATION'`,
      );
      const repository = repo(kind) as Repository<
        MessageChannelEntity | CalendarChannelEntity
      >;
      const find = repository.find.bind(repository);
      const memberFind = jest
        .fn()
        .mockResolvedValue(
          mutation === 'missing-member' ? null : { userId: ordinary.user },
        );
      jest.spyOn(repository, 'find').mockImplementationOnce(async (options) => {
        const selected = await find(options);
        if (mutation === 'parent')
          await repository.update(ordinary[kind], {
            connectedAccountId: other.account,
          });
        if (['custodian', 'global-transfer'].includes(mutation))
          await runtime
            .getRepository(ConnectedAccountEntity)
            .update(ordinary.account, { userWorkspaceId: other.userWorkspace });
        if (mutation === 'owned') {
          await runtime
            .getRepository(ConnectedAccountEntity)
            .update(ordinary.account, {
              provider: ConnectedAccountProvider.APP,
            });
          await bootstrap(ordinary);
        }
        if (mutation === 'unknown') {
          const create = runtime.createQueryRunner.bind(runtime);
          jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
            const runner = create(),
              commit = runner.commitTransaction.bind(runner);
            runner.commitTransaction = async () => {
              await commit();
              throw new Error('member reset ACK lost');
            };
            return runner;
          });
        }
        return selected;
      });
      const dependencies = {
        workspaceOrmManager: {
          executeInWorkspaceContext: async (work: () => Promise<unknown>) =>
            work(),
          getRepository: () => ({ findOne: memberFind }),
        },
        messageChannelRepository: runtime.getRepository(MessageChannelEntity),
        calendarChannelRepository: runtime.getRepository(CalendarChannelEntity),
        connectedAccountRepository: runtime.getRepository(
          ConnectedAccountEntity,
        ),
        userWorkspaceRepository: runtime.getRepository(UserWorkspaceEntity),
        messagingChannelSyncStatusService: messaging,
        calendarChannelSyncStatusService: calendar,
      };
      const events = [
        {
          properties: {
            before: {
              handle: 'member@example.test',
              scope: BlocklistScope.WORKSPACE_MEMBER,
              workspaceMemberId: memberId,
            },
          },
        },
      ];
      if (mutation.startsWith('global-'))
        events.push({
          properties: {
            before: {
              handle: 'global@example.test',
              scope: BlocklistScope.WORKSPACE,
              workspaceMemberId: memberId,
            },
          },
        });
      const job =
        kind === 'message'
          ? makeService(BlocklistReimportMessagesJob.prototype, dependencies)
          : makeService(
              BlocklistReimportCalendarEventsJob.prototype,
              dependencies,
            );
      if (mutation === 'unknown')
        await expect(
          job.handle({ workspaceId: ws, events } as never),
        ).rejects.toThrow('OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN');
      else await job.handle({ workspaceId: ws, events } as never);
      const accepted =
        mutation === 'ordinary' || mutation.startsWith('global-');
      const row = await repository.findOneByOrFail({ id: ordinary[kind] });
      if (mutation !== 'unknown')
        expect(row.syncCursor).toBe(accepted ? '' : 'old-cursor');
      expect(
        (await repository.findOneByOrFail({ id: protectedIds[kind] }))
          .syncStage,
      ).toBe('PENDING_CONFIGURATION');
      if (accepted) {
        expect(row.syncStage).toBe(pending);
        expect(
          kind === 'message' ? cache.mdel : cache.del,
        ).toHaveBeenCalledTimes(mutation.startsWith('global-') ? 2 : 1);
      } else {
        expect(cache.mdel).not.toHaveBeenCalled();
        expect(cache.del).not.toHaveBeenCalled();
        expect(broadcast.broadcast).not.toHaveBeenCalled();
      }
      if (kind === 'message' && !accepted && mutation !== 'unknown')
        expect(
          (
            await runtime
              .getRepository(MessageFolderEntity)
              .findOneByOrFail({ id: ordinary.folder })
          ).syncCursor,
        ).toBe('folder-cursor');
      if (mutation.startsWith('global-'))
        expect(memberFind).not.toHaveBeenCalled();
    },
  );
}

it.each(['ordinary', 'parent', 'disabled', 'stage', 'owned', 'unknown'])(
  'webhook list-fetch rechecks accepted account before provider: %s',
  async (mutation) => {
    const schedule =
      messaging.markAsMessagesListFetchScheduledIfPending.bind(messaging);
    jest
      .spyOn(messaging, 'markAsMessagesListFetchScheduledIfPending')
      .mockImplementationOnce(async (...args) => {
        const accepted = await schedule(...args);
        if (mutation === 'parent') {
          const other = await seed();
          await repo('message').update(ordinary.message, {
            connectedAccountId: other.account,
          });
        }
        if (mutation === 'disabled')
          await repo('message').update(ordinary.message, {
            isSyncEnabled: false,
          });
        if (mutation === 'stage')
          await runtime
            .getRepository(MessageChannelEntity)
            .update(ordinary.message, {
              syncStage: MessageChannelSyncStage.PENDING_CONFIGURATION,
            });
        if (mutation === 'owned') {
          await runtime
            .getRepository(ConnectedAccountEntity)
            .update(ordinary.account, {
              provider: ConnectedAccountProvider.APP,
            });
          await bootstrap(ordinary);
        }
        if (mutation === 'unknown') {
          const create = runtime.createQueryRunner.bind(runtime);
          jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
            const runner = create(),
              commit = runner.commitTransaction.bind(runner);
            runner.commitTransaction = async () => {
              await commit();
              throw new Error('webhook admission ACK lost');
            };
            return runner;
          });
        }
        return accepted;
      });
    const processMessageListFetch = jest.fn().mockResolvedValue(undefined);
    const service = new MessagingMessageWebhookSyncService(
      runtime.getRepository(MessageChannelEntity),
      messaging,
      { processMessageListFetch } as never,
    );
    const action = service.processMessagingMessageWebhookSync({
      messageChannelId: ordinary.message,
      workspaceId: fixture.workspaceId,
    });
    if (mutation === 'unknown')
      await expect(action).rejects.toThrow(
        'OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN',
      );
    else await action;
    expect(processMessageListFetch).toHaveBeenCalledTimes(
      mutation === 'ordinary' ? 1 : 0,
    );
    if (mutation === 'ordinary')
      expect(processMessageListFetch.mock.calls[0][0].connectedAccountId).toBe(
        ordinary.account,
      );
  },
);

it.each([
  'ordinary',
  'legacy',
  'wrong-parent',
  'protected',
  'disabled',
  'busy',
  'parent-before-read',
  'parent-after-fetch',
  'disabled-after-fetch',
  'owned-after-fetch',
  'handled-error',
  'empty',
  'deferred',
  'unknown-schedule',
  'unknown-read',
  'unknown-inline',
])(
  'calendar webhook keeps scheduled account through inline import: %s',
  async (mutation) => {
    const ws = fixture.workspaceId;
    const channelId =
      mutation === 'protected' ? protectedIds.calendar : ordinary.calendar;
    const accountId =
      mutation === 'protected' ? protectedIds.account : ordinary.account;
    const other = await seed();
    const repository = runtime.getRepository(CalendarChannelEntity);
    if (mutation === 'wrong-parent')
      await repository.update(channelId, { connectedAccountId: other.account });
    if (mutation === 'disabled')
      await repository.update(channelId, { isSyncEnabled: false });
    if (mutation === 'busy')
      await repository.update(channelId, {
        syncStage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
      });
    const installCommitFault = (index: number, reparent = false) => {
      const create = runtime.createQueryRunner.bind(runtime);
      let commits = 0;
      jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
        const runner = create(),
          commit = runner.commitTransaction.bind(runner);
        runner.commitTransaction = async () => {
          await commit();
          commits++;
          if (commits === index) {
            if (reparent)
              await runtime.query(
                'UPDATE core."calendarChannel" SET "connectedAccountId"=$1 WHERE id=$2',
                [other.account, channelId],
              );
            else throw new Error('webhook calendar ACK lost');
          }
        };
        return runner;
      });
    };
    if (mutation === 'unknown-schedule') installCommitFault(1);
    if (mutation === 'unknown-read') installCommitFault(2);
    if (mutation === 'parent-before-read') installCommitFault(1, true);
    const fetchCalendarEvents = jest
      .fn()
      .mockImplementation(
        async (
          channel: CalendarChannelEntity,
          account: ConnectedAccountEntity,
        ) => {
          expect(channel.connectedAccountId).toBe(accountId);
          expect(account.id).toBe(accountId);
          expect(channel.syncStage).toBe(
            CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_SCHEDULED,
          );
          await repository.update(channelId, {
            syncStage:
              mutation === 'handled-error'
                ? CalendarChannelSyncStage.FAILED
                : CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_PENDING,
          });
          if (mutation === 'parent-after-fetch')
            await repository.update(channelId, {
              connectedAccountId: other.account,
            });
          if (mutation === 'disabled-after-fetch')
            await repository.update(channelId, { isSyncEnabled: false });
          if (mutation === 'owned-after-fetch') {
            await runtime
              .getRepository(ConnectedAccountEntity)
              .update(accountId, { provider: ConnectedAccountProvider.APP });
            await bootstrap(ordinary);
          }
          if (mutation === 'unknown-inline') installCommitFault(1);
        },
      );
    const processCalendarEventsImport = jest.fn().mockResolvedValue(undefined);
    const service = new CalendarEventWebhookSyncService(
      {
        getSetLength: jest
          .fn()
          .mockResolvedValue(
            mutation === 'empty' ? 0 : mutation === 'deferred' ? 100000 : 1,
          ),
      } as never,
      repository,
      { fetchCalendarEvents } as never,
      { processCalendarEventsImport } as never,
    );
    const action = service.processCalendarEventWebhookSync({
      calendarChannelId: channelId,
      workspaceId: ws,
      ...(mutation === 'legacy'
        ? {}
        : { expectedConnectedAccountId: accountId }),
    });
    if (mutation.startsWith('unknown-'))
      await expect(action).rejects.toThrow(
        'OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN',
      );
    else await action;
    const shouldFetch = ![
      'wrong-parent',
      'protected',
      'disabled',
      'busy',
      'parent-before-read',
      'unknown-schedule',
      'unknown-read',
    ].includes(mutation);
    expect(fetchCalendarEvents).toHaveBeenCalledTimes(shouldFetch ? 1 : 0);
    expect(processCalendarEventsImport).toHaveBeenCalledTimes(
      ['ordinary', 'legacy'].includes(mutation) ? 1 : 0,
    );
    const current = await repository.findOneByOrFail({ id: channelId });
    if (['ordinary', 'legacy'].includes(mutation)) {
      const [channel, account, workspace] =
        processCalendarEventsImport.mock.calls[0];
      expect(channel.connectedAccountId).toBe(accountId);
      expect(account.id).toBe(accountId);
      expect(workspace).toBe(ws);
      expect(channel.syncStage).toBe(
        CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_SCHEDULED,
      );
    }
    if (
      [
        'parent-after-fetch',
        'disabled-after-fetch',
        'owned-after-fetch',
        'empty',
        'deferred',
      ].includes(mutation)
    )
      expect(current.syncStage).toBe(
        CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_PENDING,
      );
    if (['wrong-parent', 'protected', 'disabled'].includes(mutation))
      expect(current.syncStage).toBe(
        CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
      );
    if (mutation === 'handled-error')
      expect(current.syncStage).toBe(CalendarChannelSyncStage.FAILED);
  },
);
it('old-account message notification cannot schedule a new parent', async () => {
  const other = await seed();
  await repo('message').update(ordinary.message, {
    connectedAccountId: other.account,
  });
  const processMessageListFetch = jest.fn();
  const service = new MessagingMessageWebhookSyncService(
    runtime.getRepository(MessageChannelEntity),
    messaging,
    { processMessageListFetch } as never,
  );
  await service.processMessagingMessageWebhookSync({
    messageChannelId: ordinary.message,
    workspaceId: fixture.workspaceId,
    expectedConnectedAccountId: ordinary.account,
  });
  expect(processMessageListFetch).not.toHaveBeenCalled();
  expect(
    (await repo('message').findOneByOrFail({ id: ordinary.message })).syncStage,
  ).toBe(MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING);
});
for (const kind of ['message', 'calendar'] as const) {
  it(
    kind +
      ' webhook dispatch isolates account dedup and retains legacy payload',
    async () => {
      const add = jest.fn().mockResolvedValue(undefined);
      const service = new WebhookSyncTriggerService(
        { add } as never,
        { isWorkspaceServiceableFromCache: async () => true } as never,
      );
      const trigger =
        kind === 'message'
          ? service.triggerMessagingSync.bind(service)
          : service.triggerCalendarSync.bind(service);
      const otherAccount = randomUUID();
      await trigger(ordinary[kind], fixture.workspaceId, ordinary.account);
      await trigger(ordinary[kind], fixture.workspaceId, otherAccount);
      await trigger(ordinary[kind], fixture.workspaceId);
      expect(add).toHaveBeenCalledTimes(3);
      expect(
        add.mock.calls.map((call) => call[1].expectedConnectedAccountId),
      ).toEqual([ordinary.account, otherAccount, undefined]);
      const ids = add.mock.calls.map((call) => call[2].deduplication.id);
      expect(new Set(ids).size).toBe(3);
      expect(ids[0]).toBe(ids[2] + ':' + ordinary.account);
      expect(ids[1]).toBe(ids[2] + ':' + otherAccount);
      expect(add.mock.calls[2][1]).toEqual({
        workspaceId: fixture.workspaceId,
        [kind + 'ChannelId']: ordinary[kind],
      });
      for (const call of add.mock.calls)
        expect(call[2].deduplication.keepLastIfActive).toBe(true);
    },
  );
  it(kind + ' webhook inactive workspace does not enqueue', async () => {
    const add = jest.fn();
    const service = new WebhookSyncTriggerService(
      { add } as never,
      { isWorkspaceServiceableFromCache: async () => false } as never,
    );
    const trigger =
      kind === 'message'
        ? service.triggerMessagingSync.bind(service)
        : service.triggerCalendarSync.bind(service);
    await trigger(ordinary[kind], fixture.workspaceId, ordinary.account);
    expect(add).not.toHaveBeenCalled();
  });
}

it('calendar cache scope validates UUIDs and separates account and legacy namespaces', () => {
  const key = calendarImportCacheKey({
    workspaceId: fixture.workspaceId,
    calendarChannelId: ordinary.calendar,
    connectedAccountId: ordinary.account,
  });
  expect(
    calendarImportCacheKey({
      workspaceId: fixture.workspaceId.toUpperCase(),
      calendarChannelId: ordinary.calendar.toUpperCase(),
      connectedAccountId: ordinary.account.toUpperCase(),
    }),
  ).toBe(key);
  expect(
    calendarImportCacheKey({
      workspaceId: fixture.workspaceId,
      calendarChannelId: ordinary.calendar,
      connectedAccountId: protectedIds.account,
    }),
  ).not.toBe(key);
  expect(
    legacyCalendarImportCacheKey(fixture.workspaceId, ordinary.calendar),
  ).not.toBe(key);
  expect(() =>
    calendarImportCacheKey({
      workspaceId: fixture.workspaceId,
      calendarChannelId: ordinary.calendar,
      connectedAccountId: 'not-a-uuid',
    }),
  ).toThrow('INVALID_CALENDAR_IMPORT_CACHE_SCOPE');
  expect(() => legacyCalendarImportCacheKey('', ordinary.calendar)).toThrow(
    'INVALID_CALENDAR_IMPORT_CACHE_SCOPE',
  );
});
it.each([
  'ordinary',
  'parent',
  'disabled',
  'setup',
  'protected',
  'unknown',
  'absent',
])(
  'calendar legacy backlog refetch preserves outcome boundaries: %s',
  async (mutation) => {
    const ids = mutation === 'protected' ? protectedIds : ordinary;
    const repository = runtime.getRepository(CalendarChannelEntity);
    cache.getSetLength.mockResolvedValue(mutation === 'absent' ? 0 : 3);
    if (mutation === 'parent')
      await repository.update(ids.calendar, {
        connectedAccountId: (await seed()).account,
      });
    if (mutation === 'disabled')
      await repository.update(ids.calendar, { isSyncEnabled: false });
    if (mutation === 'setup')
      await repository.update(ids.calendar, {
        syncStage: CalendarChannelSyncStage.PENDING_CONFIGURATION,
      });
    const before = await repository.findOneByOrFail({ id: ids.calendar });
    if (mutation === 'unknown') {
      const create = runtime.createQueryRunner.bind(runtime);
      jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
        const runner = create(),
          commit = runner.commitTransaction.bind(runner);
        runner.commitTransaction = async () => {
          await commit();
          throw new Error('legacy calendar ACK lost');
        };
        return runner;
      });
    }
    const action = calendar.recoverLegacyCalendarImport(
      ids.calendar,
      fixture.workspaceId,
      ids.account,
    );
    if (mutation === 'unknown')
      await expect(action).rejects.toThrow(
        'OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN',
      );
    else expect(await action).toBe(mutation !== 'absent');
    if (mutation === 'ordinary') {
      expect(
        await repository.findOneByOrFail({ id: ids.calendar }),
      ).toMatchObject({
        syncCursor: '',
        syncStage: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
      });
      expect(cache.del.mock.calls.map((call) => call[0])).toEqual([
        calendarImportCacheKey({
          workspaceId: fixture.workspaceId,
          calendarChannelId: ids.calendar,
          connectedAccountId: ids.account,
        }),
        legacyCalendarImportCacheKey(fixture.workspaceId, ids.calendar),
      ]);
    } else {
      expect(cache.del).not.toHaveBeenCalled();
      if (mutation !== 'unknown')
        expect(await repository.findOneByOrFail({ id: ids.calendar })).toEqual(
          before,
        );
    }
  },
);
for (const kind of ['fetch', 'import'] as const) {
  it(
    'actual calendar ' + kind + ' stops before provider/pop on legacy backlog',
    async () => {
      if (kind === 'import') await scheduleImport('calendar');
      cache.getSetLength.mockResolvedValue(1);
      const channel = await runtime
        .getRepository(CalendarChannelEntity)
        .findOneByOrFail({ id: ordinary.calendar });
      const account = await runtime
        .getRepository(ConnectedAccountEntity)
        .findOneByOrFail({ id: ordinary.account });
      const setPop = jest.fn(),
        getCalendarEvents = jest.fn();
      const deps = {
        cacheStorage: { ...cache, setPop },
        calendarChannelSyncStatusService: calendar,
        getCalendarEventsService: { getCalendarEvents },
        calendarImportEventsService: { getCalendarEvents },
      };
      if (kind === 'fetch') {
        const actual = jest.requireActual<
          typeof import('src/modules/calendar/calendar-event-import-manager/services/calendar-fetch-events.service')
        >(
          'src/modules/calendar/calendar-event-import-manager/services/calendar-fetch-events.service',
        );
        await makeService(
          actual.CalendarFetchEventsService.prototype,
          deps,
        ).fetchCalendarEvents(channel, account, fixture.workspaceId);
      } else
        await makeService(
          CalendarEventsImportService.prototype,
          deps,
        ).processCalendarEventsImport(channel, account, fixture.workspaceId);
      expect(setPop).not.toHaveBeenCalled();
      expect(getCalendarEvents).not.toHaveBeenCalled();
      expect(
        (
          await runtime
            .getRepository(CalendarChannelEntity)
            .findOneByOrFail({ id: ordinary.calendar })
        ).syncCursor,
      ).toBe('');
    },
  );
}
it('calendar delayed provider result uses captured account cache namespace', async () => {
  const actual = jest.requireActual<
    typeof import('src/modules/calendar/calendar-event-import-manager/services/calendar-fetch-events.service')
  >(
    'src/modules/calendar/calendar-event-import-manager/services/calendar-fetch-events.service',
  );
  const channel = await runtime
    .getRepository(CalendarChannelEntity)
    .findOneByOrFail({ id: ordinary.calendar });
  const account = await runtime
    .getRepository(ConnectedAccountEntity)
    .findOneByOrFail({ id: ordinary.account });
  const other = await seed(),
    setAdd = jest.fn();
  const fetch = makeService(actual.CalendarFetchEventsService.prototype, {
    logger: { log: jest.fn(), error: jest.fn() },
    cacheStorage: { setAdd },
    calendarChannelSyncStatusService: {
      recoverLegacyCalendarImport:
        calendar.recoverLegacyCalendarImport.bind(calendar),
      markAsCalendarEventListFetchOngoing: jest.fn(),
      markAsCalendarEventsImportPending: jest.fn(),
    },
    calendarChannelRepository: { update: jest.fn() },
    workspaceOrmManager: {
      executeInWorkspaceContext: async (work: () => Promise<void>) => work(),
    },
    getCalendarEventsService: {
      getCalendarEvents: async () => {
        await runtime
          .getRepository(CalendarChannelEntity)
          .update(ordinary.calendar, { connectedAccountId: other.account });
        channel.connectedAccountId = other.account;
        account.id = other.account;
        return {
          calendarEventIds: ['old-event'],
          calendarEventIdsToDelete: [],
          nextSyncCursor: 'next',
        };
      },
    },
  });
  await fetch.fetchCalendarEvents(channel, account, fixture.workspaceId);
  expect(setAdd).toHaveBeenCalledWith(
    calendarImportCacheKey({
      workspaceId: fixture.workspaceId,
      calendarChannelId: ordinary.calendar,
      connectedAccountId: ordinary.account,
    }),
    ['old-event'],
  );
});
it('calendar postcommit reset clears admitted account namespace after reparent', async () => {
  const other = await seed();
  const create = runtime.createQueryRunner.bind(runtime);
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
    const runner = create(),
      commit = runner.commitTransaction.bind(runner);
    runner.commitTransaction = async () => {
      await commit();
      await runtime.query(
        'UPDATE core."calendarChannel" SET "connectedAccountId"=$1 WHERE id=$2',
        [other.account, ordinary.calendar],
      );
    };
    return runner;
  });
  await calendar.resetAndMarkAsCalendarEventListFetchPending(
    [ordinary.calendar],
    fixture.workspaceId,
    ordinary.account,
  );
  expect(cache.del).toHaveBeenCalledTimes(1);
  expect(cache.del).toHaveBeenCalledWith(
    calendarImportCacheKey({
      workspaceId: fixture.workspaceId,
      calendarChannelId: ordinary.calendar,
      connectedAccountId: ordinary.account,
    }),
  );
});
it('calendar batch pop uses captured identity despite caller object mutation', async () => {
  await scheduleImport('calendar');
  const channel = await runtime
    .getRepository(CalendarChannelEntity)
    .findOneByOrFail({ id: ordinary.calendar });
  const account = await runtime
    .getRepository(ConnectedAccountEntity)
    .findOneByOrFail({ id: ordinary.account });
  const setPop = jest.fn().mockImplementation(async () => {
    channel.connectedAccountId = protectedIds.account;
    account.id = protectedIds.account;
    return [];
  });
  await makeService(CalendarEventsImportService.prototype, {
    cacheStorage: { setPop },
    calendarChannelSyncStatusService: calendar,
    workspaceOrmManager: {
      executeInWorkspaceContext: async (work: () => Promise<void>) => work(),
    },
  }).processCalendarEventsImport(channel, account, fixture.workspaceId);
  expect(setPop).toHaveBeenCalledWith(
    calendarImportCacheKey({
      workspaceId: fixture.workspaceId,
      calendarChannelId: ordinary.calendar,
      connectedAccountId: ordinary.account,
    }),
    100,
  );
});
for (const code of [
  CalendarEventImportDriverExceptionCode.SYNC_CURSOR_ERROR,
  CalendarEventImportDriverExceptionCode.NOT_FOUND,
  CalendarEventImportDriverExceptionCode.UNKNOWN,
]) {
  it.each(['ordinary', 'parent'])(
    'calendar error ' + code + ' flush/reset retains parent: %s',
    async (mutation) => {
      const repository = runtime.getRepository(CalendarChannelEntity);
      const snapshot = await repository.findOneByOrFail({
        id: ordinary.calendar,
      });
      if (mutation === 'parent')
        await repository.update(ordinary.calendar, {
          connectedAccountId: (await seed()).account,
        });
      const before = await repository.findOneByOrFail({
        id: ordinary.calendar,
      });
      const handler = makeService(
        CalendarEventImportErrorHandlerService.prototype,
        {
          calendarChannelSyncStatusService: calendar,
          exceptionHandlerService: { captureExceptions: jest.fn() },
          logger: { debug: jest.fn(), error: jest.fn() },
        },
      );
      const action = handler.handleDriverException(
        new CalendarEventImportDriverException('fixture', code),
        CalendarEventImportSyncStep.CALENDAR_EVENTS_IMPORT,
        snapshot,
        fixture.workspaceId,
      );
      if (code === CalendarEventImportDriverExceptionCode.UNKNOWN)
        await expect(action).rejects.toThrow();
      else await action;
      if (mutation === 'parent') {
        expect(
          await repository.findOneByOrFail({ id: ordinary.calendar }),
        ).toEqual(before);
        expect(cache.del).not.toHaveBeenCalled();
        expect(metrics.incrementCounterForEvents).not.toHaveBeenCalled();
      } else {
        expect(cache.del).toHaveBeenCalledTimes(1);
        expect(cache.del).toHaveBeenCalledWith(
          calendarImportCacheKey({
            workspaceId: fixture.workspaceId,
            calendarChannelId: ordinary.calendar,
            connectedAccountId: ordinary.account,
          }),
        );
      }
    },
  );
}

describe.each(['message', 'calendar'] as const)(
  'atomic import admission and run callbacks %s',
  (kind) => {
    const begin = () =>
      kind === 'message'
        ? messaging.beginMessagesImport(
            ordinary.message,
            fixture.workspaceId,
            ordinary.account,
          )
        : calendar.beginCalendarEventsImport(
            ordinary.calendar,
            fixture.workspaceId,
            ordinary.account,
          );
    const complete = (run: OrdinaryMetadataSyncRun) =>
      kind === 'message'
        ? messaging.markAsMessageSyncCompleted(
            [ordinary.message],
            fixture.workspaceId,
            ordinary.account,
            run,
          )
        : calendar.markAsCalendarEventSyncCompleted(
            [ordinary.calendar],
            fixture.workspaceId,
            run,
          );
    const runErrorHandler = () => {
      const dependencies = {
        messageChannelSyncStatusService: messaging,
        calendarChannelSyncStatusService: calendar,
        exceptionHandlerService: { captureExceptions: jest.fn() },
        messagingMonitoringService: { track: jest.fn() },
        logger: { debug: jest.fn(), error: jest.fn() },
      };
      return kind === 'message'
        ? makeService(
            MessageImportExceptionHandlerService.prototype,
            dependencies,
          )
        : makeService(
            CalendarEventImportErrorHandlerService.prototype,
            dependencies,
          );
    };
    const importer = (cacheOverrides: object = {}, provider: object = {}) => {
      const dependencies = {
        messageChannelSyncStatusService: messaging,
        calendarChannelSyncStatusService: calendar,
        cacheStorage: {
          ...cache,
          setPop: jest.fn().mockResolvedValue([]),
          setAdd: jest.fn(),
          ...cacheOverrides,
        },
        workspaceOrmManager: {
          executeInWorkspaceContext: async (work: () => Promise<void>) =>
            work(),
        },
        messagingMonitoringService: { track: jest.fn() },
        messageImportErrorHandlerService: runErrorHandler(),
        calendarEventImportErrorHandlerService: runErrorHandler(),
        emailAliasManagerService: { refreshHandleAliases: jest.fn() },
        messagingGetMessagesService: provider,
        calendarImportEventsService: provider,
        logger: { error: jest.fn() },
      };
      return kind === 'message'
        ? makeService(MessagingMessagesImportService.prototype, dependencies)
        : makeService(CalendarEventsImportService.prototype, dependencies);
    };
    const importNow = async (owner: ReturnType<typeof importer>) => {
      const channel = await repo(kind).findOneByOrFail({ id: ordinary[kind] });
      // A forged caller snapshot must not bypass the database stage gate.
      channel.syncStage = (
        kind === 'message'
          ? MessageChannelSyncStage.MESSAGES_IMPORT_SCHEDULED
          : CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_SCHEDULED
      ) as never;
      const account = await runtime
        .getRepository(ConnectedAccountEntity)
        .findOneByOrFail({ id: ordinary.account });
      return owner instanceof MessagingMessagesImportService
        ? owner.processMessageBatchImport(
            channel as MessageChannelEntity,
            account,
            fixture.workspaceId,
            1,
          )
        : owner.processCalendarEventsImport(
            channel as CalendarChannelEntity,
            account,
            fixture.workspaceId,
          );
    };
    const replaceRun = async () => {
      await fixture.owner.query(
        `UPDATE core."${kind === 'message' ? 'messageChannel' : 'calendarChannel'}" SET "syncStageStartedAt"="syncStageStartedAt"+interval '1 microsecond' WHERE id=$1`,
        [ordinary[kind]],
      );
    };
    it('only one concurrent scheduled job enters and token keeps six fractional digits', async () => {
      await scheduleImport(kind);
      const attempts = await Promise.all([begin(), begin()]);
      expect(attempts.filter(Boolean)).toHaveLength(1);
      const winner = attempts.find(Boolean)!;
      expect(winner.run.startedAt).toMatch(/\.\d{6}Z$/);
      expect(Object.isFrozen(winner.run)).toBe(true);
      expect(winner.channel.connectedAccount.id).toBe(ordinary.account);
      await complete(winner.run);
      expect(
        (await repo(kind).findOneByOrFail({ id: ordinary[kind] })).syncStatus,
      ).toBe('ACTIVE');
    });
    it.each(['disabled', 'ongoing', 'protected', 'parent'] as const)(
      'direct importer refuses %s before legacy recovery/cache/provider',
      async (change) => {
        await scheduleImport(kind);
        if (change === 'disabled')
          await repo(kind).update(ordinary[kind], { isSyncEnabled: false });
        if (change === 'ongoing') await begin();
        if (change === 'protected') {
          await runtime
            .getRepository(ConnectedAccountEntity)
            .update(ordinary.account, {
              provider: ConnectedAccountProvider.APP,
            });
          await bootstrap(ordinary);
        }
        const owner = importer(),
          setPop = jest.fn(),
          provider = { getMessages: jest.fn(), getCalendarEvents: jest.fn() };
        Object.assign(owner, {
          cacheStorage: { ...cache, setPop },
          messagingGetMessagesService: provider,
          calendarImportEventsService: provider,
        });
        if (change === 'parent') {
          const original =
            kind === 'message'
              ? messaging.beginMessagesImport.bind(messaging)
              : calendar.beginCalendarEventsImport.bind(calendar);
          const other = await seed();
          const hook = async (...args: [string, string, string]) => {
            await repo(kind).update(ordinary[kind], {
              connectedAccountId: other.account,
            });
            return original(...args);
          };
          if (kind === 'message')
            jest
              .spyOn(messaging, 'beginMessagesImport')
              .mockImplementationOnce(hook as never);
          else
            jest
              .spyOn(calendar, 'beginCalendarEventsImport')
              .mockImplementationOnce(hook as never);
        }
        cache.getSetLength.mockClear();
        await importNow(owner);
        expect(setPop).not.toHaveBeenCalled();
        expect(cache.getSetLength).not.toHaveBeenCalled();
        expect(provider.getMessages).not.toHaveBeenCalled();
        expect(provider.getCalendarEvents).not.toHaveBeenCalled();
      },
    );
    it.each(['empty', 'nextRun'] as const)(
      'actual empty batch completes only its admitted run: %s',
      async (race) => {
        await scheduleImport(kind);
        const pop = jest.fn(async () => {
          if (race === 'nextRun') await replaceRun();
          return [];
        });
        await importNow(importer({ setPop: pop }));
        const channel = await repo(kind).findOneByOrFail({
          id: ordinary[kind],
        });
        expect(pop).toHaveBeenCalledTimes(1);
        expect(channel.syncStatus).toBe(
          race === 'empty' ? 'ACTIVE' : 'ONGOING',
        );
        expect(metrics.incrementCounterForEvents).toHaveBeenCalledTimes(
          race === 'empty' ? 1 : 0,
        );
      },
    );
    it.each(['microsecond', 'parent', 'disabled'] as const)(
      'stale completion cannot affect %s replacement',
      async (change) => {
        await scheduleImport(kind);
        const admitted = (await begin())!;
        if (change === 'microsecond') await replaceRun();
        else if (change === 'parent') {
          const other = await seed();
          await repo(kind).update(ordinary[kind], {
            connectedAccountId: other.account,
          });
        } else
          await repo(kind).update(ordinary[kind], { isSyncEnabled: false });
        const before = await repo(kind).findOneByOrFail({ id: ordinary[kind] });
        cache.mdel.mockClear();
        cache.del.mockClear();
        broadcast.broadcast.mockClear();
        await complete(admitted.run);
        expect(
          await repo(kind).findOneByOrFail({ id: ordinary[kind] }),
        ).toEqual(before);
        expect(metrics.incrementCounterForEvents).not.toHaveBeenCalled();
        expect(cache.mdel).not.toHaveBeenCalled();
        expect(cache.del).not.toHaveBeenCalled();
        expect(broadcast.broadcast).not.toHaveBeenCalled();
      },
    );
    it('timestamps in one JS millisecond remain distinct callback tokens', async () => {
      await scheduleImport(kind);
      const admitted = (await begin())!;
      const old = '2029-01-01T00:00:00.123456Z',
        current = '2029-01-01T00:00:00.123457Z';
      expect(new Date(old).getTime()).toBe(new Date(current).getTime());
      await fixture.owner.query(
        `UPDATE core."${kind === 'message' ? 'messageChannel' : 'calendarChannel'}" SET "syncStageStartedAt"=$2::timestamptz WHERE id=$1`,
        [ordinary[kind], current],
      );
      await complete({ ...admitted.run, startedAt: old });
      expect(
        (await repo(kind).findOneByOrFail({ id: ordinary[kind] })).syncStatus,
      ).toBe('ONGOING');
      await complete({ ...admitted.run, startedAt: current });
      expect(
        (await repo(kind).findOneByOrFail({ id: ordinary[kind] })).syncStatus,
      ).toBe('ACTIVE');
    });
    describe.each(['current', 'replaced'] as const)(
      'failure callback for %s run',
      (race) => {
        it.each([
          'TEMPORARY_ERROR',
          'INSUFFICIENT_PERMISSIONS',
          'SYNC_CURSOR_ERROR',
          'NOT_FOUND',
          'UNKNOWN',
        ] as const)('%s', async (code) => {
          await scheduleImport(kind);
          const admitted = (await begin())!;
          if (race === 'replaced') await replaceRun();
          const before = await repo(kind).findOneByOrFail({
            id: ordinary[kind],
          });
          cache.mdel.mockClear();
          cache.del.mockClear();
          broadcast.broadcast.mockClear();
          const h = runErrorHandler();
          const error = { code, message: 'controlled failure' };
          // Errors must remain Error instances so real handler code preserves code.
          const exception = Object.assign(new Error(error.message), { code });
          const pending =
            h instanceof MessageImportExceptionHandlerService
              ? h.handleDriverException(
                  exception,
                  MessageImportSyncStep.MESSAGES_IMPORT_ONGOING,
                  admitted.channel,
                  fixture.workspaceId,
                  admitted.run,
                )
              : h.handleDriverException(
                  exception,
                  CalendarEventImportSyncStep.CALENDAR_EVENTS_IMPORT,
                  admitted.channel,
                  fixture.workspaceId,
                  admitted.run,
                );
          if (kind === 'calendar' && code === 'UNKNOWN')
            await expect(pending).rejects.toThrow('Unknown error');
          else await pending;
          const after = await repo(kind).findOneByOrFail({
            id: ordinary[kind],
          });
          if (race === 'replaced') {
            expect(after).toEqual(before);
            expect(cache.mdel).not.toHaveBeenCalled();
            expect(cache.del).not.toHaveBeenCalled();
            expect(metrics.incrementCounterForEvents).not.toHaveBeenCalled();
            expect(broadcast.broadcast).not.toHaveBeenCalled();
            expect(reconnect.addAccountToReconnectByKey).not.toHaveBeenCalled();
            expect(
              (
                await runtime
                  .getRepository(ConnectedAccountEntity)
                  .findOneByOrFail({ id: ordinary.account })
              ).authFailedAt,
            ).toBeNull();
          } else expect(after.syncStage).not.toBe(admitted.run.stage);
        });
      },
    );
    it('callback copies optional token before asynchronous workspace setup', async () => {
      await scheduleImport(kind);
      const admitted = (await begin())!;
      const input = { ...admitted.run };
      const owner = kind === 'message' ? messaging : calendar;
      Object.assign(owner, {
        workspaceOrmManager: {
          getWorkspaceId: () => fixture.workspaceId,
          executeInWorkspaceContext: async (work: () => Promise<unknown>) => {
            input.startedAt = '2035-01-01T00:00:00.123456Z';
            return work();
          },
        },
      });
      await complete(input);
      expect(
        (await repo(kind).findOneByOrFail({ id: ordinary[kind] })).syncStatus,
      ).toBe('ACTIVE');
    });
    it.each(['current', 'replaced'] as const)(
      'batch continuation checks the %s run',
      async (race) => {
        await scheduleImport(kind);
        const admitted = (await begin())!;
        if (race === 'replaced') await replaceRun();
        if (kind === 'message')
          await messaging.markAsMessageBatchImported(
            ordinary.message,
            ordinary.account,
            fixture.workspaceId,
            admitted.run,
          );
        else
          await calendar.markAsCalendarEventsImportPending(
            [ordinary.calendar],
            fixture.workspaceId,
            false,
            admitted.run,
          );
        const after = await repo(kind).findOneByOrFail({ id: ordinary[kind] });
        expect(after.syncStage).toBe(
          race === 'replaced'
            ? admitted.run.stage
            : kind === 'message'
              ? MessageChannelSyncStage.MESSAGES_IMPORT_PENDING
              : CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_PENDING,
        );
      },
    );
    it('actual late provider error cannot retry a replacement run', async () => {
      await scheduleImport(kind);
      const fail = async () => {
        await replaceRun();
        throw Object.assign(new Error('provider temporary'), {
          code: 'TEMPORARY_ERROR',
        });
      };
      await importNow(
        importer(
          { setPop: jest.fn().mockResolvedValue(['id']) },
          { getMessages: fail, getCalendarEvents: fail },
        ),
      );
      const after = await repo(kind).findOneByOrFail({ id: ordinary[kind] });
      expect(after.syncStatus).toBe('ONGOING');
      expect(after.throttleFailureCount).toBe(2);
      expect(after.syncStage).toBe(
        kind === 'message'
          ? MessageChannelSyncStage.MESSAGES_IMPORT_ONGOING
          : CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
      );
    });
    it('unknown admission commit stops before cache/provider', async () => {
      await scheduleImport(kind);
      const original = runtime.createQueryRunner.bind(runtime);
      jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
        const runner = original(),
          commit = runner.commitTransaction.bind(runner);
        runner.commitTransaction = async () => {
          await commit();
          throw new Error('admission-ack-lost');
        };
        return runner;
      });
      const setPop = jest.fn(),
        provider = { getMessages: jest.fn(), getCalendarEvents: jest.fn() };
      await expect(importNow(importer({ setPop }, provider))).rejects.toThrow(
        'OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN',
      );
      expect(setPop).not.toHaveBeenCalled();
      expect(cache.getSetLength).not.toHaveBeenCalled();
      expect(provider.getMessages).not.toHaveBeenCalled();
      expect(provider.getCalendarEvents).not.toHaveBeenCalled();
      expect(broadcast.broadcast).not.toHaveBeenCalled();
      expect(metrics.incrementCounterForEvents).not.toHaveBeenCalled();
    });
    it('legacy recovery never resets a newer run or deletes its legacy cache', async () => {
      await scheduleImport(kind);
      const admitted = (await begin())!;
      await replaceRun();
      const before = await repo(kind).findOneByOrFail({ id: ordinary[kind] });
      cache.getSetLength.mockResolvedValue(1);
      cache.mdel.mockClear();
      cache.del.mockClear();
      const recovered =
        kind === 'message'
          ? await messaging.recoverLegacyMessageImport(
              ordinary.message,
              fixture.workspaceId,
              ordinary.account,
              admitted.run,
            )
          : await calendar.recoverLegacyCalendarImport(
              ordinary.calendar,
              fixture.workspaceId,
              ordinary.account,
              admitted.run,
            );
      expect(recovered).toBe(true);
      expect(await repo(kind).findOneByOrFail({ id: ordinary[kind] })).toEqual(
        before,
      );
      expect(cache.mdel).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
    });
    it('legacy recovery captures mutable optional token before cache awaits', async () => {
      await scheduleImport(kind);
      const admitted = (await begin())!,
        input = { ...admitted.run };
      await replaceRun();
      const before = await repo(kind).findOneByOrFail({ id: ordinary[kind] });
      cache.getSetLength.mockImplementationOnce(async () => {
        const [row] = await fixture.owner.query(
          `SELECT to_char("syncStageStartedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS token FROM core."${kind === 'message' ? 'messageChannel' : 'calendarChannel'}" WHERE id=$1`,
          [ordinary[kind]],
        );
        input.startedAt = row.token;
        return 1;
      });
      cache.mdel.mockClear();
      cache.del.mockClear();
      if (kind === 'message')
        await messaging.recoverLegacyMessageImport(
          ordinary.message,
          fixture.workspaceId,
          ordinary.account,
          input,
        );
      else
        await calendar.recoverLegacyCalendarImport(
          ordinary.calendar,
          fixture.workspaceId,
          ordinary.account,
          input,
        );
      expect(await repo(kind).findOneByOrFail({ id: ordinary[kind] })).toEqual(
        before,
      );
      expect(cache.mdel).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
    });
    it('unknown native outcome exits actual importer without requeue or failure mutation', async () => {
      await scheduleImport(kind);
      const error = new NativeTransactionOutcomeUnknownError(
        'commit',
        new Error('lost-ack'),
      );
      const provider = {
          getMessages: jest.fn().mockRejectedValue(error),
          getCalendarEvents: jest.fn().mockRejectedValue(error),
        },
        setAdd = jest.fn();
      const owner = importer(
        { setPop: jest.fn().mockResolvedValue(['provider-id']), setAdd },
        provider,
      );
      await expect(importNow(owner)).rejects.toBe(error);
      expect(
        (await repo(kind).findOneByOrFail({ id: ordinary[kind] })).syncStatus,
      ).toBe('ONGOING');
      expect(setAdd).not.toHaveBeenCalled();
      expect(metrics.incrementCounterForEvents).not.toHaveBeenCalled();
    });
  },
);
