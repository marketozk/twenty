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
import { DataSource, EntitySchema, type QueryRunner } from 'typeorm';
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
  columns: common,
});
const folderSchema = new EntitySchema<MessageFolderEntity>({
  name: 'SyncFolderFixture',
  target: MessageFolderEntity,
  schema: 'core',
  tableName: 'messageFolder',
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
let cache: { mdel: jest.Mock; del: jest.Mock; mget: jest.Mock },
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
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid,ADD provider text,ADD "applicationId" uuid,ADD "connectionProviderId" uuid,ADD "userWorkspaceId" uuid,ADD "authFailedAt" timestamptz,ADD "authFailedReason" text,ADD "archivedAt" timestamptz',
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageChannel" ADD "connectedAccountId" uuid REFERENCES core."connectedAccount"(id),ADD "throttleRetryAfter" timestamptz,ADD "pendingGroupEmailsAction" text,ADD "updatedAt" timestamptz DEFAULT now()',
  );
  await fixture.owner.query(
    'CREATE TABLE core."calendarChannel" (id uuid PRIMARY KEY,"workspaceId" uuid,"connectedAccountId" uuid REFERENCES core."connectedAccount"(id))',
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
    mget: jest.fn().mockResolvedValue([0, 0]),
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
  ).toEqual([ordinary.message]);
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
  'src/modules/messaging/message-import-manager/jobs/messaging-message-list-fetch.job',
  () => ({
    MessagingMessageListFetchJob: class MessagingMessageListFetchJob {},
  }),
);
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
