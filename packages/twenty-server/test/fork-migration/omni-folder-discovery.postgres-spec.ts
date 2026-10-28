import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema } from 'typeorm';
import { MessageFolderEntity } from 'src/engine/metadata-modules/message-folder/entities/message-folder.entity';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { SyncMessageFoldersService } from 'src/modules/messaging/message-folder-manager/services/sync-message-folders.service';
import { createOmniNativeCleanupFixture } from 'test/fork-migration/omni-native-cleanup.fixture';
import { type DiscoveredMessageFolder } from 'src/modules/messaging/message-folder-manager/interfaces/message-folder-driver.interface';

jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock(
  'src/engine/metadata-modules/message-folder/entities/message-folder.entity',
  () => ({ MessageFolderEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/message-channel/entities/message-channel.entity',
  () => ({ MessageChannelEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/connected-account/entities/connected-account.entity',
  () => ({ ConnectedAccountEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.entity',
  () => ({ UserWorkspaceEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
jest.mock(
  'src/modules/messaging/message-folder-manager/drivers/gmail/services/gmail-get-all-folders.service',
  () => ({ GmailGetAllFoldersService: class {} }),
);
jest.mock(
  'src/modules/messaging/message-folder-manager/drivers/microsoft/services/microsoft-get-all-folders.service',
  () => ({ MicrosoftGetAllFoldersService: class {} }),
);
jest.mock(
  'src/modules/messaging/message-folder-manager/drivers/imap/services/imap-get-all-folders.service',
  () => ({ ImapGetAllFoldersService: class {} }),
);

const fixture = createOmniNativeCleanupFixture();
const schema = new EntitySchema<MessageFolderEntity>({
  name: 'DiscoveryFolder',
  target: MessageFolderEntity,
  schema: 'core',
  tableName: 'messageFolder',
  columns: {
    id: { type: 'uuid', primary: true, generated: 'uuid' },
    workspaceId: { type: 'uuid' },
    messageChannelId: { type: 'uuid' },
    name: { type: 'text', nullable: true },
    externalId: { type: 'text', nullable: true },
    parentFolderId: { type: 'text', nullable: true },
    syncCursor: { type: 'text', nullable: true },
    isSynced: { type: 'boolean' },
    isSentFolder: { type: 'boolean' },
    pendingSyncAction: { type: 'text', default: 'NONE' },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
});
const runtime = new DataSource({
  type: 'postgres',
  url: fixture.runtimeDatabaseUrl,
  entities: [schema],
  synchronize: false,
  migrationsRun: false,
  extra: { max: 6, statement_timeout: 10000 },
});
let accountId: string, channelId: string, folderId: string;
let service: SyncMessageFoldersService;
let provider: { getAllMessageFolders: jest.Mock };
let seed: Awaited<ReturnType<typeof fixture.seed>>;
const folders = () =>
  runtime.query(
    'SELECT * FROM core."messageFolder" WHERE "messageChannelId"=$1 ORDER BY id',
    [channelId],
  );
const input = async () => ({
  workspaceId: fixture.workspaceId,
  messageChannel: {
    ...(
      await runtime.query('SELECT * FROM core."messageChannel" WHERE id=$1', [
        channelId,
      ])
    )[0],
    connectedAccount: (
      await runtime.query('SELECT * FROM core."connectedAccount" WHERE id=$1', [
        accountId,
      ])
    )[0],
    messageFolders: await folders(),
  },
});
const run = async () => service.syncMessageFolders(await input());
const discovered = (
  externalId = 'existing',
  name = 'Provider name',
): DiscoveredMessageFolder => ({
  externalId,
  name,
  parentFolderId: null,
  isSynced: true,
  isSentFolder: false,
});
const addFolder = (externalId: string) =>
  fixture.coreInsert('messageFolder', {
    workspaceId: fixture.workspaceId,
    messageChannelId: channelId,
    externalId,
    name: externalId,
    isSynced: true,
    isSentFolder: false,
    pendingSyncAction: 'NONE',
    updatedAt: '2026-10-28T00:00:00.123456Z',
  });
const during = (change: () => Promise<unknown>, result = [discovered()]) =>
  provider.getAllMessageFolders.mockImplementationOnce(async () => {
    await change();
    return result;
  });
beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid,ADD provider text,ADD "applicationId" uuid,ADD "connectionProviderId" uuid,ADD "userWorkspaceId" uuid,ADD handle text,ADD "archivedAt" timestamptz,ADD "accessToken" text,ADD "connectionParameters" jsonb,ADD "externalAccountId" text',
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageChannel" ADD "messageFolderImportPolicy" text,ADD "updatedAt" timestamptz NOT NULL DEFAULT now()',
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageFolder" ADD "pendingSyncAction" text DEFAULT \'NONE\',ADD "isSynced" boolean,ADD "isSentFolder" boolean,ADD "externalId" text,ADD name text,ADD "parentFolderId" text,ADD "syncCursor" text,ADD "updatedAt" timestamptz NOT NULL DEFAULT now()',
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageFolder" ALTER COLUMN id SET DEFAULT gen_random_uuid()',
  );
  await fixture.owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON core."connectedAccount",core."messageChannel",core."messageFolder" TO "${fixture.roleName}"`,
  );
  await runtime.initialize();
});
beforeEach(async () => {
  await fixture.reset();
  seed = await fixture.seed('binding');
  accountId = await fixture.coreInsert('connectedAccount', {
    workspaceId: fixture.workspaceId,
    provider: 'google',
    userWorkspaceId: randomUUID(),
    handle: 'ordinary@example.test',
  });
  channelId = await fixture.coreInsert('messageChannel', {
    workspaceId: fixture.workspaceId,
    connectedAccountId: accountId,
    type: 'EMAIL',
    messageFolderImportPolicy: 'ALL_FOLDERS',
    updatedAt: '2026-10-28T00:00:00.123456Z',
  });
  folderId = await addFolder('existing');
  provider = {
    getAllMessageFolders: jest.fn().mockResolvedValue([discovered()]),
  };
  service = new SyncMessageFoldersService(
    fixture.manager,
    new WorkspaceScopedRepository(runtime.getRepository(MessageFolderEntity)),
    provider as never,
    provider as never,
    provider as never,
    runtime,
  );
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (runtime.isInitialized) await runtime.destroy();
  await fixture.dispose();
});

it('reconciles create/update/deletion intent and returns committed rows', async () => {
  const removedId = await addFolder('removed');
  provider.getAllMessageFolders.mockResolvedValue([
    discovered(),
    discovered('new'),
  ]);
  const result = await run();
  expect(result).toHaveLength(3);
  expect(result).toEqual(
    await runtime
      .getRepository(MessageFolderEntity)
      .find({ where: { messageChannelId: channelId }, order: { id: 'ASC' } }),
  );
  expect(result!.find((x) => x.id === removedId)!.pendingSyncAction).toBe(
    'FOLDER_DELETION',
  );
  expect(result!.find((x) => x.id === folderId)!.name).toBe('Provider name');
  expect(result!.find((x) => x.externalId === 'new')!.pendingSyncAction).toBe(
    'NONE',
  );
});
it.each(['FOLDER_IMPORT', 'FOLDER_DELETION'])(
  'preserves actual pending %s in result',
  async (action) => {
    await runtime.query(
      'UPDATE core."messageFolder" SET "pendingSyncAction"=$2 WHERE id=$1',
      [folderId, action],
    );
    expect((await run())![0].pendingSyncAction).toBe(action);
  },
);
it.each(['google', 'microsoft', 'imap_smtp_caldav'])(
  'uses fresh policy/folders with %s driver',
  async (kind) => {
    await runtime.query(
      'UPDATE core."connectedAccount" SET provider=$2 WHERE id=$1',
      [accountId, kind],
    );
    const request = await input();
    request.messageChannel.messageFolders = [];
    request.messageChannel.messageFolderImportPolicy = 'stale';
    await service.syncMessageFolders(request);
    expect(
      provider.getAllMessageFolders.mock.calls[0][1].messageFolderImportPolicy,
    ).toBe('ALL_FOLDERS');
    if (kind === 'imap_smtp_caldav')
      expect(provider.getAllMessageFolders.mock.calls[0][2]).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: folderId })]),
      );
  },
);
it.each([
  'name',
  'isSynced',
  'pendingSyncAction',
  'externalId',
  'parentFolderId',
  'updatedAt',
])('rejects folder %s changes during provider discovery', async (field) => {
  const value =
    field === 'isSynced'
      ? false
      : field === 'updatedAt'
        ? '2026-10-28T00:00:00.123457Z'
        : 'changed';
  during(() =>
    runtime.query(`UPDATE core."messageFolder" SET "${field}"=$2 WHERE id=$1`, [
      folderId,
      value,
    ]),
  );
  expect(await run()).toBeNull();
  expect((await folders())[0][field]).toEqual(
    field === 'updatedAt' ? new Date(value as string) : value,
  );
});
it.each(['messageFolderImportPolicy', 'connectedAccountId', 'updatedAt'])(
  'rejects channel %s changes during provider discovery',
  async (field) => {
    const value =
      field === 'connectedAccountId'
        ? randomUUID()
        : field === 'updatedAt'
          ? '2026-10-28T00:00:00.123457Z'
          : 'SELECTED_FOLDERS';
    during(() =>
      runtime.query(
        `UPDATE core."messageChannel" SET "${field}"=$2 WHERE id=$1`,
        [channelId, value],
      ),
    );
    expect(await run()).toBeNull();
    expect((await folders())[0].name).toBe('existing');
  },
);
it.each([
  'userWorkspaceId',
  'provider',
  'applicationId',
  'externalAccountId',
  'handle',
  'archivedAt',
])('rejects account identity change %s', async (field) => {
  const value =
    field === 'userWorkspaceId' || field === 'applicationId'
      ? randomUUID()
      : field === 'archivedAt'
        ? new Date()
        : 'changed';
  during(() =>
    runtime.query(
      `UPDATE core."connectedAccount" SET "${field}"=$2 WHERE id=$1`,
      [accountId, value],
    ),
  );
  expect(await run()).toBeNull();
  expect((await folders())[0].name).toBe('existing');
});
it('rejects an old IMAP response after connection endpoint changes', async () => {
  await runtime.query(
    'UPDATE core."connectedAccount" SET provider=\'imap_smtp_caldav\',"connectionParameters"=$2 WHERE id=$1',
    [
      accountId,
      {
        IMAP: {
          host: 'old.example.test',
          username: 'old',
          password: 'enc:v2:fixture',
        },
      },
    ],
  );
  during(() =>
    runtime.query(
      'UPDATE core."connectedAccount" SET "connectionParameters"=$2 WHERE id=$1',
      [
        accountId,
        {
          IMAP: {
            host: 'new.example.test',
            username: 'new',
            password: 'enc:v2:fixture',
          },
        },
      ],
    ),
  );
  expect(await run()).toBeNull();
  expect((await folders())[0].name).toBe('existing');
});
it('allows a credential refresh during discovery without weakening identity checks', async () => {
  during(() =>
    runtime.query(
      'UPDATE core."connectedAccount" SET "accessToken"=$2 WHERE id=$1',
      [accountId, 'isolated-test-token'],
    ),
  );
  expect((await run())![0].name).toBe('Provider name');
});
it.each(['add', 'remove', 'reparent'])(
  'rejects changed folder set: %s',
  async (kind) => {
    during(async () => {
      if (kind === 'add') await addFolder('concurrent');
      if (kind === 'remove')
        await runtime.query('DELETE FROM core."messageFolder" WHERE id=$1', [
          folderId,
        ]);
      if (kind === 'reparent')
        await runtime.query(
          'UPDATE core."messageFolder" SET "messageChannelId"=$2 WHERE id=$1',
          [folderId, seed.channelId],
        );
    });
    expect(await run()).toBeNull();
  },
);
it('does not call provider for native APP ownership', async () => {
  await runtime.query(
    'UPDATE core."connectedAccount" SET provider=\'app\' WHERE id=$1',
    [accountId],
  );
  expect(await run()).toBeNull();
  expect(provider.getAllMessageFolders).not.toHaveBeenCalled();
});
it('rejects ownership introduced while provider was running', async () => {
  during(() =>
    fixture.owner.query(
      'UPDATE core."omniAccountBinding" SET "connectedAccountId"=$2 WHERE id=$1',
      [seed.bindingId, accountId],
    ),
  );
  expect(await run()).toBeNull();
  expect((await folders())[0].name).toBe('existing');
});
it('rejects protected folder junction even on otherwise ordinary channel', async () => {
  await fixture.owner.query(
    `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociationMessageFolder" SET "messageFolderId"=$2 WHERE id=$1`,
    [seed.omni.junctionId, folderId],
  );
  expect(await run()).toBeNull();
  expect(provider.getAllMessageFolders).not.toHaveBeenCalled();
});
it('rejects mismatched workspace before provider calls', async () => {
  const request = await input();
  request.workspaceId = randomUUID();
  await expect(service.syncMessageFolders(request)).rejects.toThrow(
    'WORKSPACE_MISMATCH',
  );
  expect(provider.getAllMessageFolders).not.toHaveBeenCalled();
});
it('propagates provider errors without changing folder state', async () => {
  const before = await folders();
  provider.getAllMessageFolders.mockRejectedValue(
    new Error('provider unavailable'),
  );
  await expect(run()).rejects.toThrow('provider unavailable');
  expect(await folders()).toEqual(before);
});
it('unreadable ownership fails closed before provider', async () => {
  await fixture.owner.query(
    `REVOKE SELECT ON core."omniAccountBinding" FROM "${fixture.roleName}"`,
  );
  try {
    await expect(run()).rejects.toThrow();
    expect(provider.getAllMessageFolders).not.toHaveBeenCalled();
  } finally {
    await fixture.owner.query(
      `GRANT SELECT ON core."omniAccountBinding" TO "${fixture.roleName}"`,
    );
  }
});
it('rolls back earlier folder changes if a later insert fails', async () => {
  const before = await folders();
  provider.getAllMessageFolders.mockResolvedValue([
    discovered(),
    discovered('new'),
  ]);
  await fixture.owner.query(
    `CREATE FUNCTION core.log062_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture insert failed'; END $$`,
  );
  await fixture.owner.query(
    'CREATE TRIGGER log062_fail_insert BEFORE INSERT ON core."messageFolder" FOR EACH ROW EXECUTE FUNCTION core.log062_fail_insert()',
  );
  try {
    await expect(run()).rejects.toThrow('fixture insert failed');
    expect(await folders()).toEqual(before);
  } finally {
    await fixture.owner.query(
      'DROP TRIGGER log062_fail_insert ON core."messageFolder"',
    );
    await fixture.owner.query('DROP FUNCTION core.log062_fail_insert()');
  }
});
it('lost commit acknowledgement cannot return a success snapshot', async () => {
  const original = runtime.createQueryRunner.bind(runtime);
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
    const runner = original(),
      query = runner.query.bind(runner),
      commit = runner.commitTransaction.bind(runner);
    let written = false;
    runner.query = async (...args: Parameters<typeof runner.query>) => {
      if (args[0].startsWith('UPDATE')) written = true;
      return query(...args);
    };
    runner.commitTransaction = async () => {
      await commit();
      if (written) throw new Error('discovery commit ACK lost');
    };
    return runner;
  });
  await expect(run()).rejects.toThrow('OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN');
  expect((await folders())[0].name).toBe('Provider name');
});
it('concurrent discoveries reject the second stale snapshot without duplicate creates', async () => {
  let release!: () => void, entered!: () => void;
  const both = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  provider.getAllMessageFolders.mockImplementation(async () => {
    if (++count === 2) entered();
    await gate;
    return [discovered(), discovered('new')];
  });
  const pending = [run(), run()];
  await both;
  release();
  const results = await Promise.all(pending);
  expect(results.filter((x) => x === null)).toHaveLength(1);
  expect(
    (await folders()).filter(
      (x: { externalId: string }) => x.externalId === 'new',
    ),
  ).toHaveLength(1);
});
