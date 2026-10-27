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
import { MessageFolderMetadataService } from 'src/engine/metadata-modules/message-folder/message-folder-metadata.service';

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
    isSynced: { type: 'boolean' },
    name: { type: 'text', nullable: true },
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
let folders: MessageFolderMetadataService;
const read = (id = ordinary.folder) =>
  runtime.getRepository(MessageFolderEntity).findOneByOrFail({ id });
const toggle = (
  ids = [ordinary.folder],
  isSynced = true,
  userWorkspaceId?: string,
) =>
  folders.setSyncStatus({
    ids,
    workspaceId: fixture.workspaceId,
    data: { isSynced },
    userWorkspaceId,
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
    isSynced: false,
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
    'ALTER TABLE core."messageFolder" ADD "syncCursor" text,ADD "pendingSyncAction" text,ADD "isSynced" boolean NOT NULL DEFAULT false,ADD name text',
  );
  await fixture.owner.query(
    'CREATE TABLE core."userWorkspace"(id uuid PRIMARY KEY,"workspaceId" uuid,"userId" uuid)',
  );
  await fixture.owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "${fixture.roleName}"`,
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageFolder" ALTER COLUMN id SET DEFAULT gen_random_uuid()',
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
  folders = new MessageFolderMetadataService(
    runtime.getRepository(MessageFolderEntity),
    new WorkspaceScopedRepository(runtime.getRepository(MessageFolderEntity)),
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

jest.mock(
  'src/engine/metadata-modules/message-folder/dtos/message-folder.dto',
  () => ({ MessageFolderDTO: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/message-channel/message-channel-metadata.service',
  () => ({ MessageChannelMetadataService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/connected-account/connected-account-metadata.service',
  () => ({ ConnectedAccountMetadataService: class {} }),
);

it('ordinary create/update/delete returns the committed folder data', async () => {
  const created = await folders.create({
    workspaceId: fixture.workspaceId,
    messageChannelId: ordinary.message,
    pendingSyncAction: MessageFolderPendingSyncAction.NONE,
    isSynced: false,
    name: 'new',
  });
  expect(created).toMatchObject({
    name: 'new',
    messageChannelId: ordinary.message,
  });
  expect(
    await folders.update({
      id: created.id,
      workspaceId: fixture.workspaceId,
      data: { name: 'updated' },
    }),
  ).toMatchObject({ name: 'updated' });
  expect(
    await folders.delete({ id: created.id, workspaceId: fixture.workspaceId }),
  ).toMatchObject({ name: 'updated' });
  expect(
    await runtime
      .getRepository(MessageFolderEntity)
      .findOneBy({ id: created.id }),
  ).toBeNull();
});
for (const mode of ['bound', 'unbound'] as const) {
  it.each(['create', 'update', 'sync', 'delete'])(
    'protects ' + mode + ' native folder from %s',
    async (operation) => {
      const ids = mode === 'bound' ? protectedIds : ordinary;
      if (mode === 'unbound')
        await runtime
          .getRepository(ConnectedAccountEntity)
          .update(ids.account, { provider: ConnectedAccountProvider.APP });
      const before = await read(ids.folder);
      const work =
        operation === 'create'
          ? folders.create({
              workspaceId: fixture.workspaceId,
              messageChannelId: ids.message,
              pendingSyncAction: MessageFolderPendingSyncAction.NONE,
              isSynced: false,
            })
          : operation === 'update'
            ? folders.update({
                id: ids.folder,
                workspaceId: fixture.workspaceId,
                data: { name: 'forbidden' },
              })
            : operation === 'sync'
              ? toggle([ids.folder])
              : folders.delete({
                  id: ids.folder,
                  workspaceId: fixture.workspaceId,
                });
      await expect(work).rejects.toThrow('OMNI_OWNED_FOLDER');
      expect(await read(ids.folder)).toEqual(before);
    },
  );
}
it.each([true, false])(
  'mixed ordinary/native batch is all-or-nothing (%s)',
  async (enabled) => {
    const before = await read();
    await expect(
      toggle([ordinary.folder, protectedIds.folder], enabled),
    ).rejects.toThrow('OMNI_OWNED_FOLDER');
    expect(await read()).toEqual(before);
  },
);
it.each([ConnectedAccountProvider.GOOGLE, ConnectedAccountProvider.MICROSOFT])(
  'backfill follows current provider %s',
  async (provider) => {
    await runtime
      .getRepository(ConnectedAccountEntity)
      .update(ordinary.account, { provider });
    await toggle();
    expect(await read()).toMatchObject({
      isSynced: true,
      pendingSyncAction:
        provider === ConnectedAccountProvider.GOOGLE ? 'FOLDER_IMPORT' : 'NONE',
    });
  },
);
it('already enabled Google folder does not request a new backfill', async () => {
  await runtime
    .getRepository(MessageFolderEntity)
    .update(ordinary.folder, { isSynced: true });
  await toggle();
  expect((await read()).pendingSyncAction).toBe('NONE');
});
it.each([
  MessageFolderPendingSyncAction.FOLDER_IMPORT,
  MessageFolderPendingSyncAction.FOLDER_DELETION,
])('disabling preserves existing %s semantics', async (action) => {
  await runtime
    .getRepository(MessageFolderEntity)
    .update(ordinary.folder, { isSynced: true, pendingSyncAction: action });
  await toggle([ordinary.folder], false);
  expect(await read()).toMatchObject({
    isSynced: false,
    pendingSyncAction:
      action === MessageFolderPendingSyncAction.FOLDER_IMPORT ? 'NONE' : action,
  });
});
it('missing folder in a batch does not modify the ordinary row', async () => {
  const before = await read();
  await expect(toggle([ordinary.folder, randomUUID()])).rejects.toThrow(
    'OMNI_METADATA_FOLDER_NOT_FOUND',
  );
  expect(await read()).toEqual(before);
});
it('protects a folder connected to native messages through a retained junction', async () => {
  const messageId = randomUUID(),
    associationId = randomUUID();
  await fixture.owner.query(
    `INSERT INTO "${fixture.schemaName}"."message"(id) VALUES ($1)`,
    [messageId],
  );
  await fixture.owner.query(
    `INSERT INTO "${fixture.schemaName}"."messageChannelMessageAssociation"(id,"messageId","messageChannelId") VALUES ($1,$2,$3)`,
    [associationId, messageId, protectedIds.message],
  );
  await fixture.owner.query(
    `INSERT INTO "${fixture.schemaName}"."messageChannelMessageAssociationMessageFolder"(id,"messageChannelMessageAssociationId","messageFolderId","deletedAt") VALUES ($1,$2,$3,now())`,
    [randomUUID(), associationId, ordinary.folder],
  );
  const before = await read();
  await expect(toggle()).rejects.toThrow('OMNI_OWNED_FOLDER');
  await expect(
    folders.delete({ id: ordinary.folder, workspaceId: fixture.workspaceId }),
  ).rejects.toThrow('OMNI_OWNED_FOLDER');
  expect(await read()).toEqual(before);
});
it('rejects bootstrap completed after initial folder discovery', async () => {
  const query = runtime.manager.query.bind(runtime.manager);
  jest
    .spyOn(runtime.manager, 'query')
    .mockImplementationOnce(
      async (...args: Parameters<typeof runtime.manager.query>) => {
        const result = await query(...args);
        await runtime
          .getRepository(ConnectedAccountEntity)
          .update(ordinary.account, { provider: ConnectedAccountProvider.APP });
        await runtime
          .getRepository(MessageChannelEntity)
          .update(ordinary.message, { type: MessageChannelType.APP });
        await bootstrap(ordinary);
        return result;
      },
    );
  await expect(toggle()).rejects.toThrow('OMNI_OWNED_FOLDER');
  expect((await read()).isSynced).toBe(false);
});
it('allows ordinary reparent but rejects a native destination', async () => {
  const other = await seed();
  await folders.update({
    id: ordinary.folder,
    workspaceId: fixture.workspaceId,
    data: { messageChannelId: other.message },
  });
  expect((await read()).messageChannelId).toBe(other.message);
  await expect(
    folders.update({
      id: ordinary.folder,
      workspaceId: fixture.workspaceId,
      data: { messageChannelId: protectedIds.message },
    }),
  ).rejects.toThrow('OMNI_OWNED_FOLDER');
  expect((await read()).messageChannelId).toBe(other.message);
});
it('rejects a parent change after discovery instead of locking a new parent late', async () => {
  const other = await seed(),
    query = runtime.manager.query.bind(runtime.manager);
  jest
    .spyOn(runtime.manager, 'query')
    .mockImplementationOnce(
      async (...args: Parameters<typeof runtime.manager.query>) => {
        const result = await query(...args);
        await fixture.owner.query(
          'UPDATE core."messageFolder" SET "messageChannelId"=$2 WHERE id=$1',
          [ordinary.folder, other.message],
        );
        return result;
      },
    );
  await expect(toggle()).rejects.toThrow('OMNI_METADATA_FOLDER_PARENT_CHANGED');
  expect((await read()).isSynced).toBe(false);
});
it.each(['update', 'sync'])(
  'rechecks current custodian for resolver %s',
  async (operation) => {
    await runtime
      .getRepository(ConnectedAccountEntity)
      .update(ordinary.account, { userWorkspaceId: randomUUID() });
    const before = await read();
    await expect(
      operation === 'update'
        ? folders.update({
            id: ordinary.folder,
            workspaceId: fixture.workspaceId,
            data: { isSynced: true },
            userWorkspaceId: ordinary.userWorkspace,
          })
        : toggle([ordinary.folder], true, ordinary.userWorkspace),
    ).rejects.toThrow('no longer belongs');
    expect(await read()).toEqual(before);
  },
);
it('parallel reversed batches acquire locks in a stable order', async () => {
  const other = await seed();
  await Promise.all([
    toggle([ordinary.folder, other.folder], true),
    toggle([other.folder, ordinary.folder], false),
  ]);
  const a = await read(),
    b = await read(other.folder);
  expect(a.isSynced).toBe(b.isSynced);
  expect(a.pendingSyncAction).toBe(b.pendingSyncAction);
});
it('rolls back first sync write if the pending-action update fails', async () => {
  await runtime.getRepository(MessageFolderEntity).update(ordinary.folder, {
    isSynced: true,
    pendingSyncAction: MessageFolderPendingSyncAction.FOLDER_IMPORT,
  });
  const before = await read(),
    original = runtime.createQueryRunner.bind(runtime);
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
    const runner = original(),
      query = runner.query.bind(runner);
    let updates = 0;
    runner.query = async (...args: Parameters<QueryRunner['query']>) => {
      if (
        args[0].startsWith('UPDATE "core"."messageFolder"') &&
        ++updates === 2
      )
        await query('SELECT 1/0');
      return query(...args);
    };
    return runner;
  });
  await expect(toggle([ordinary.folder], false)).rejects.toThrow();
  expect(await read()).toEqual(before);
});
it('surfaces unknown commit instead of returning a false success', async () => {
  const original = runtime.createQueryRunner.bind(runtime);
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
    const runner = original(),
      commit = runner.commitTransaction.bind(runner);
    runner.commitTransaction = async () => {
      await commit();
      throw new Error('folder ACK lost');
    };
    return runner;
  });
  await expect(toggle()).rejects.toThrow(
    'OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN',
  );
  expect((await read()).isSynced).toBe(true);
});
it('fails closed when ownership cannot be read', async () => {
  await fixture.owner.query(
    `REVOKE SELECT ON core."omniAccountBinding" FROM "${fixture.roleName}"`,
  );
  try {
    await expect(toggle()).rejects.toThrow();
    expect((await read()).isSynced).toBe(false);
  } finally {
    await fixture.owner.query(
      `GRANT SELECT ON core."omniAccountBinding" TO "${fixture.roleName}"`,
    );
  }
});
it.each(['id', 'workspaceId', 'messageChannel'])(
  'rejects scope/relation mutation through %s',
  async (field) => {
    await expect(
      folders.update({
        id: ordinary.folder,
        workspaceId: fixture.workspaceId,
        data: {
          [field]:
            field === 'messageChannel'
              ? { id: protectedIds.message }
              : randomUUID(),
        },
      }),
    ).rejects.toThrow('OMNI_METADATA_SCOPE_CHANGE');
  },
);
