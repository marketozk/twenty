import { ConnectedAccountMetadataService } from 'src/engine/metadata-modules/connected-account/connected-account-metadata.service';
import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema, type QueryRunner } from 'typeorm';
import {
  ConnectedAccountProvider,
  MessageChannelSyncStage,
  MessageChannelSyncStatus,
  CalendarChannelSyncStage,
  CalendarChannelSyncStatus,
  MessageFolderPendingSyncAction,
  MessageChannelType,
  MessageChannelPendingGroupEmailsAction,
} from 'twenty-shared/types';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { MessageFolderEntity } from 'src/engine/metadata-modules/message-folder/entities/message-folder.entity';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { MessagingCursorService } from 'src/modules/messaging/message-import-manager/services/messaging-cursor.service';
import { MessageChannelMetadataService } from 'src/engine/metadata-modules/message-channel/message-channel-metadata.service';

import { bootstrapOmniAccountBinding } from 'src/modules/omnichannel/services/omni-binding-bootstrap';

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
    scope: { type: 'text' },
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
    excludeGroupEmails: { type: 'boolean' },
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
let cursor: MessagingCursorService;
let metadata: MessageChannelMetadataService;
const read = (id = ordinary.message) =>
  runtime.getRepository(MessageChannelEntity).findOneByOrFail({ id });
const folder = (id = ordinary.folder) =>
  runtime.getRepository(MessageFolderEntity).findOneByOrFail({ id });
const settings = (
  excludeGroupEmails: boolean,
  id = ordinary.message,
  accountId = ordinary.account,
) =>
  metadata.update({
    id,
    workspaceId: fixture.workspaceId,
    data: { excludeGroupEmails },
    settingsCaller: {
      connectedAccountId: accountId,
      userWorkspaceId: ordinary.userWorkspace,
    },
  });
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
    scope: 'USER',
    provider: native
      ? ConnectedAccountProvider.APP
      : ConnectedAccountProvider.GOOGLE,
  });
  const commonData = {
    workspaceId: fixture.workspaceId,
    connectedAccountId: ids.account,
    syncCursor: '100',
    syncStageStartedAt: new Date('2029-01-01'),
    throttleFailureCount: 2,
    isSyncEnabled: true,
  };
  await runtime.getRepository(MessageChannelEntity).insert({
    ...commonData,
    id: ids.message,
    type: native ? MessageChannelType.APP : MessageChannelType.EMAIL,
    excludeGroupEmails: false,
    pendingGroupEmailsAction: MessageChannelPendingGroupEmailsAction.NONE,
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
    pendingSyncAction: MessageFolderPendingSyncAction.NONE,
  });
  if (native) await bootstrap(ids);
  return ids;
};
beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid,ADD provider text,ADD scope text,ADD "applicationId" uuid,ADD "connectionProviderId" uuid,ADD "userWorkspaceId" uuid,ADD "authFailedAt" timestamptz,ADD "authFailedReason" text,ADD "archivedAt" timestamptz',
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageChannel" ADD "connectedAccountId" uuid REFERENCES core."connectedAccount"(id),ADD "throttleRetryAfter" timestamptz,ADD "pendingGroupEmailsAction" text,ADD "excludeGroupEmails" boolean',
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
  cursor = new MessagingCursorService(
    {
      executeInWorkspaceContext: async (work: () => Promise<unknown>) => work(),
    } as never,
    runtime.getRepository(MessageChannelEntity),
    new WorkspaceScopedRepository(runtime.getRepository(MessageFolderEntity)),
  );
  const accountService = Object.assign(
    Object.create(ConnectedAccountMetadataService.prototype),
    {
      permissionsService: {
        userHasWorkspaceSettingPermission: jest.fn().mockResolvedValue(false),
      },
    },
  );
  metadata = new MessageChannelMetadataService(
    runtime.getRepository(MessageChannelEntity),
    accountService,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (runtime.isInitialized) await runtime.destroy();
  await fixture.dispose();
});

jest.mock(
  'src/engine/core-modules/emailing-domain/services/emailing-domain.service',
  () => ({ EmailingDomainService: class {} }),
);
jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({ TwentyConfigService: class {} }),
);
jest.mock('src/engine/workspace-event-emitter/workspace-event-emitter', () => ({
  WorkspaceEventEmitter: class {},
}));
jest.mock(
  'src/modules/messaging/common/services/message-channel-sync-status.service',
  () => ({ MessageChannelSyncStatusService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/message-channel/dtos/message-channel.dto',
  () => ({ MessageChannelDTO: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/message-channel/dtos/create-email-group-channel.output',
  () => ({ CreateEmailGroupChannelOutput: class {} }),
);

describe('cursor final ownership and atomic folder write', () => {
  it('compares with the current database cursor, not the stale input snapshot', async () => {
    const old = await read();
    await runtime
      .getRepository(MessageChannelEntity)
      .update(ordinary.message, { syncCursor: '300' });
    await cursor.updateCursor(old, '200', fixture.workspaceId);
    expect(await read()).toMatchObject({
      syncCursor: '300',
      throttleFailureCount: 0,
      syncStageStartedAt: null,
    });
    await cursor.updateCursor(old, '400', fixture.workspaceId);
    expect((await read()).syncCursor).toBe('400');
  });
  it('updates the ordinary folder and channel in one transaction', async () => {
    await cursor.updateCursor(
      await read(),
      'new-folder-cursor',
      fixture.workspaceId,
      ordinary.folder,
    );
    expect((await folder()).syncCursor).toBe('new-folder-cursor');
    expect(await read()).toMatchObject({
      syncCursor: '100',
      throttleFailureCount: 0,
      syncStageStartedAt: null,
    });
  });
  it.each([false, true])(
    'ignores bound native cursor work (folder=%s)',
    async (useFolder) => {
      const before = await read(protectedIds.message),
        beforeFolder = await folder(protectedIds.folder);
      await cursor.updateCursor(
        before,
        '900',
        fixture.workspaceId,
        useFolder ? protectedIds.folder : undefined,
      );
      expect(await read(protectedIds.message)).toEqual(before);
      expect(await folder(protectedIds.folder)).toEqual(beforeFolder);
    },
  );
  it('excludes an unbound native account', async () => {
    await runtime
      .getRepository(ConnectedAccountEntity)
      .update(ordinary.account, { provider: ConnectedAccountProvider.APP });
    const before = await read();
    await cursor.updateCursor(before, '900', fixture.workspaceId);
    expect(await read()).toEqual(before);
  });
  it('declines stale work after ordinary reparenting', async () => {
    const before = await read();
    const other = await seed();
    await runtime
      .getRepository(MessageChannelEntity)
      .update(ordinary.message, { connectedAccountId: other.account });
    await cursor.updateCursor(
      before,
      '900',
      fixture.workspaceId,
      ordinary.folder,
    );
    expect(await read()).toMatchObject({
      syncCursor: '100',
      throttleFailureCount: 2,
    });
    expect((await folder()).syncCursor).toBe('folder-cursor');
  });
  it.each(['foreign', 'missing'])(
    'declines %s folder without resetting the channel',
    async (kind) => {
      const before = await read();
      await cursor.updateCursor(
        before,
        '900',
        fixture.workspaceId,
        kind === 'foreign' ? protectedIds.folder : randomUUID(),
      );
      expect(await read()).toEqual(before);
    },
  );
  it('rolls back folder update when the following channel write fails', async () => {
    const before = await read();
    const original = runtime.createQueryRunner.bind(runtime);
    jest.spyOn(runtime, 'createQueryRunner').mockImplementationOnce(() => {
      const runner = original(),
        query = runner.query.bind(runner);
      runner.query = async (...args: Parameters<QueryRunner['query']>) => {
        if (args[0].startsWith('UPDATE "core"."messageChannel"'))
          await query('SELECT 1/0');
        return query(...args);
      };
      return runner;
    });
    await expect(
      cursor.updateCursor(before, '900', fixture.workspaceId, ordinary.folder),
    ).rejects.toThrow();
    expect((await folder()).syncCursor).toBe('folder-cursor');
    expect((await read()).throttleFailureCount).toBe(2);
  });
});
describe('settings and group action share the metadata transaction', () => {
  it.each([true, false])(
    'writes the setting and derived action together (%s)',
    async (exclude) => {
      await runtime
        .getRepository(MessageChannelEntity)
        .update(ordinary.message, { excludeGroupEmails: !exclude });
      await settings(exclude);
      expect(await read()).toMatchObject({
        excludeGroupEmails: exclude,
        pendingGroupEmailsAction: exclude
          ? MessageChannelPendingGroupEmailsAction.GROUP_EMAILS_DELETION
          : MessageChannelPendingGroupEmailsAction.GROUP_EMAILS_IMPORT,
      });
    },
  );
  it.each(['unchanged', 'configuration', 'group'])(
    'preserves no pending action for %s',
    async (kind) => {
      if (kind === 'configuration')
        await runtime
          .getRepository(MessageChannelEntity)
          .update(ordinary.message, {
            syncStage: MessageChannelSyncStage.PENDING_CONFIGURATION,
          });
      if (kind === 'group')
        await runtime
          .getRepository(MessageChannelEntity)
          .update(ordinary.message, { type: MessageChannelType.EMAIL_GROUP });
      await settings(kind !== 'unchanged');
      expect((await read()).pendingGroupEmailsAction).toBe(
        MessageChannelPendingGroupEmailsAction.NONE,
      );
    },
  );
  it.each(['folder', 'group'])(
    'rejects ongoing sync with pending %s action without mutation',
    async (kind) => {
      await runtime
        .getRepository(MessageChannelEntity)
        .update(ordinary.message, {
          syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_ONGOING,
          ...(kind === 'group'
            ? {
                pendingGroupEmailsAction:
                  MessageChannelPendingGroupEmailsAction.GROUP_EMAILS_IMPORT,
              }
            : {}),
        });
      if (kind === 'folder')
        await runtime.query(
          'UPDATE core."messageFolder" SET "pendingSyncAction"=$1 WHERE id=$2',
          ['IMPORT', ordinary.folder],
        );
      const before = await read();
      await expect(settings(true)).rejects.toThrow('Cannot update');
      expect(await read()).toEqual(before);
    },
  );
  it('allows ongoing sync when there are no pending actions', async () => {
    await runtime.getRepository(MessageChannelEntity).update(ordinary.message, {
      syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_ONGOING,
    });
    await settings(true);
    expect((await read()).excludeGroupEmails).toBe(true);
  });
  it('rejects ownership changed since resolver authorization', async () => {
    const other = await seed();
    await runtime
      .getRepository(MessageChannelEntity)
      .update(ordinary.message, { connectedAccountId: other.account });
    const before = await read();
    await expect(settings(true)).rejects.toThrow('ownership changed');
    expect(await read()).toEqual(before);
  });
  it('rejects a bound channel before any setting or action write', async () => {
    const before = await read(protectedIds.message);
    await expect(
      settings(true, protectedIds.message, protectedIds.account),
    ).rejects.toThrow('OMNI_OWNED_CHANNEL');
    expect(await read(protectedIds.message)).toEqual(before);
  });
  it('rolls back both setting and pending action on an error after UPDATE', async () => {
    const before = await read(),
      original = runtime.createQueryRunner.bind(runtime);
    jest.spyOn(runtime, 'createQueryRunner').mockImplementationOnce(() => {
      const runner = original(),
        query = runner.query.bind(runner);
      runner.query = async (...args: Parameters<QueryRunner['query']>) => {
        const result = await query(...args);
        if (args[0].startsWith('UPDATE "core"."messageChannel"'))
          await query('SELECT 1/0');
        return result;
      };
      return runner;
    });
    await expect(settings(true)).rejects.toThrow();
    expect(await read()).toEqual(before);
  });
});

jest.mock(
  'src/engine/core-modules/application/connection-provider/connection-provider-lifecycle-hook.service',
  () => ({ ConnectionProviderLifecycleHookService: class {} }),
);

jest.mock(
  'src/engine/core-modules/application/connection-provider/refresh/services/app-oauth-revoke.service',
  () => ({ AppOAuthRevokeService: class {} }),
);

jest.mock(
  'src/engine/metadata-modules/permissions/permissions.service',
  () => ({ PermissionsService: class {} }),
);

jest.mock(
  'src/modules/connected-account/webhook-subscription-manager/services/calendar-webhook-subscription.service',
  () => ({ CalendarWebhookSubscriptionService: class {} }),
);

jest.mock(
  'src/modules/connected-account/webhook-subscription-manager/services/messaging-webhook-subscription.service',
  () => ({ MessagingWebhookSubscriptionService: class {} }),
);

it.each(['custodian', 'scope'])(
  'rechecks administration after same-account %s change',
  async (kind) => {
    const staleParent = ordinary.account;
    await runtime.getRepository(ConnectedAccountEntity).update(staleParent, {
      userWorkspaceId: randomUUID(),
      scope: kind === 'scope' ? 'USER' : 'WORKSPACE',
    });
    const before = await read();
    await expect(settings(true, ordinary.message, staleParent)).rejects.toThrow(
      'cannot be administered',
    );
    expect(await read()).toEqual(before);
  },
);
