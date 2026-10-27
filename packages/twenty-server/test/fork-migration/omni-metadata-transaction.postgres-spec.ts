import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema, type QueryRunner } from 'typeorm';
import {
  ConnectedAccountProvider,
  MessageChannelType,
  MessageChannelVisibility,
  MessageChannelSyncStage,
} from 'twenty-shared/types';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { ConnectedAccountMetadataService } from 'src/engine/metadata-modules/connected-account/connected-account-metadata.service';
import { MessageChannelMetadataService } from 'src/engine/metadata-modules/message-channel/message-channel-metadata.service';
import { ApplicationMessageChannelsService } from 'src/engine/metadata-modules/message-channel/services/application-message-channels.service';
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
jest.mock('src/engine/workspace-event-emitter/workspace-event-emitter', () => ({
  WorkspaceEventEmitter: class {},
}));
jest.mock(
  'src/modules/connected-account/webhook-subscription-manager/services/calendar-webhook-subscription.service',
  () => ({ CalendarWebhookSubscriptionService: class {} }),
);
jest.mock(
  'src/modules/connected-account/webhook-subscription-manager/services/messaging-webhook-subscription.service',
  () => ({ MessagingWebhookSubscriptionService: class {} }),
);
jest.mock(
  'src/engine/core-modules/emailing-domain/services/emailing-domain.service',
  () => ({ EmailingDomainService: class {} }),
);
jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({ TwentyConfigService: class {} }),
);
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
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
const fixture = createOmniNativeMessageFixture();
const accountSchema = new EntitySchema<ConnectedAccountEntity>({
  name: 'ConnectedAccountFixture',
  target: ConnectedAccountEntity,
  tableName: 'connectedAccount',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true, generated: 'uuid' },
    workspaceId: { type: 'uuid' },
    archivedAt: { type: 'timestamptz', nullable: true },
    applicationId: { type: 'uuid', nullable: true },
    connectionProviderId: { type: 'uuid', nullable: true },
    provider: { type: 'text' },
    scope: { type: 'text' },
    userWorkspaceId: { type: 'uuid' },
    handle: { type: 'text' },
  },
});
const channelSchema = new EntitySchema<MessageChannelEntity>({
  name: 'MessageChannelFixture',
  target: MessageChannelEntity,
  tableName: 'messageChannel',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true, generated: 'uuid' },
    workspaceId: { type: 'uuid' },
    connectedAccountId: { type: 'uuid' },
    type: { type: 'text' },
    handle: { type: 'text' },
    displayName: { type: 'text', nullable: true },
    visibility: { type: 'text' },
    isSyncEnabled: { type: 'boolean', default: true },
    syncStage: { type: 'text', nullable: true },
    syncStatus: { type: 'text', nullable: true },
    isContactAutoCreationEnabled: { type: 'boolean', nullable: true },
    contactAutoCreationPolicy: { type: 'text', nullable: true },
    excludeGroupEmails: { type: 'boolean', nullable: true },
    excludeNonProfessionalEmails: { type: 'boolean', nullable: true },
    pendingGroupEmailsAction: { type: 'text', nullable: true },
  },
});
const runtime = new DataSource({
  type: 'postgres',
  url: fixture.runtimeDatabaseUrl,
  entities: [accountSchema, channelSchema],
  synchronize: false,
  migrationsRun: false,
  extra: { max: 4, statement_timeout: 10000 },
});
const events = { emitCustomBatchEvent: jest.fn() };
let accounts: ConnectedAccountMetadataService;
let channels: MessageChannelMetadataService;
let app: ApplicationMessageChannelsService;
let accountId: string, channelId: string, memberId: string, appId: string;
const actor = { kind: 'system' as const, id: 'metadata-fixture' };
const bootstrap = (
  authorize: Parameters<typeof bootstrapOmniAccountBinding>[3] = async () =>
    undefined,
  bindingAccountId = accountId,
  bindingChannelId = channelId,
) =>
  bootstrapOmniAccountBinding(
    runtime,
    actor,
    {
      workspaceId: fixture.workspaceId,
      platform: 'telegram',
      connectorInstanceId: 'metadata-fixture',
      accountId: bindingAccountId,
      connectedAccountId: bindingAccountId,
      messageChannelId: bindingChannelId,
      idempotencyKey: randomUUID(),
      expectedRevision: '0',
    },
    authorize,
  );
const createChannel = (parent = accountId) =>
  channels.create({
    workspaceId: fixture.workspaceId,
    connectedAccountId: parent,
    handle: randomUUID(),
    visibility: MessageChannelVisibility.SHARE_EVERYTHING,
    type: MessageChannelType.APP,
    syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
  });
const scope = () => ({
  workspaceId: fixture.workspaceId,
  applicationId: appId,
  requestUserWorkspaceId: memberId,
  id: channelId,
});
const readChannel = () =>
  runtime
    .getRepository(MessageChannelEntity)
    .findOneByOrFail({ id: channelId });
const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, promise };
};
const blocked = async () => {
  for (let i = 0; i < 300; i++) {
    const [{ count }] = await fixture.owner.query(
      'SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname=current_database())',
    );
    if (count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected actual database lock wait');
};
const capture = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
const pauseNextRunner = (matches: (sql: string) => boolean) => {
  const reached = barrier(),
    resume = barrier();
  const original = runtime.createQueryRunner.bind(runtime);
  jest.spyOn(runtime, 'createQueryRunner').mockImplementationOnce(() => {
    const runner = original();
    const query = runner.query.bind(runner);
    let used = false;
    runner.query = async (...args: Parameters<QueryRunner['query']>) => {
      const result = await query(...args);
      if (!used && matches(args[0])) {
        used = true;
        reached.release();
        await resume.promise;
      }
      return result;
    };
    return runner;
  });
  return { reached: reached.promise, resume: resume.release };
};
beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid, ADD "archivedAt" timestamptz, ADD "applicationId" uuid, ADD "connectionProviderId" uuid, ADD provider text, ADD scope text, ADD "userWorkspaceId" uuid, ADD handle text',
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageChannel" ADD "connectedAccountId" uuid REFERENCES core."connectedAccount"(id) ON DELETE CASCADE, ADD handle text, ADD "displayName" text, ADD visibility text, ADD "isSyncEnabled" boolean DEFAULT true, ADD "syncStage" text, ADD "syncStatus" text, ADD "isContactAutoCreationEnabled" boolean, ADD "contactAutoCreationPolicy" text, ADD "excludeGroupEmails" boolean, ADD "excludeNonProfessionalEmails" boolean, ADD "pendingGroupEmailsAction" text',
  );
  await fixture.owner.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO "${fixture.roleName}"`,
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageChannel" ALTER COLUMN id SET DEFAULT gen_random_uuid()',
  );
  await runtime.initialize();
  type AccountDependencies = ConstructorParameters<
    typeof ConnectedAccountMetadataService
  >;
  accounts = new ConnectedAccountMetadataService(
    runtime.getRepository(ConnectedAccountEntity),
    {} as AccountDependencies[1],
    runtime.getRepository(MessageChannelEntity),
    {} as AccountDependencies[3],
    {} as AccountDependencies[4],
    {} as AccountDependencies[5],
    events as unknown as AccountDependencies[6],
    {} as AccountDependencies[7],
    {} as AccountDependencies[8],
  );
  type ChannelDependencies = ConstructorParameters<
    typeof MessageChannelMetadataService
  >;
  channels = new MessageChannelMetadataService(
    runtime.getRepository(MessageChannelEntity),
    accounts,
    {} as ChannelDependencies[2],
    {} as ChannelDependencies[3],
    events as unknown as ChannelDependencies[4],
    {} as ChannelDependencies[5],
  );
  type AppDependencies = ConstructorParameters<
    typeof ApplicationMessageChannelsService
  >;
  app = new ApplicationMessageChannelsService(
    runtime.getRepository(MessageChannelEntity),
    runtime.getRepository(ConnectedAccountEntity),
    events as unknown as AppDependencies[2],
  );
});
beforeEach(async () => {
  await fixture.reset();
  await fixture.owner.query(
    'TRUNCATE core.workspace, core."connectedAccount", core."messageChannel" CASCADE',
  );
  await fixture.owner.query('INSERT INTO core.workspace(id) VALUES ($1)', [
    fixture.workspaceId,
  ]);
  accountId = randomUUID();
  channelId = randomUUID();
  memberId = randomUUID();
  appId = randomUUID();
  await runtime.getRepository(ConnectedAccountEntity).insert({
    id: accountId,
    workspaceId: fixture.workspaceId,
    provider: ConnectedAccountProvider.APP,
    handle: 'account',
    scope: 'WORKSPACE',
    userWorkspaceId: memberId,
  });
  await runtime.getRepository(MessageChannelEntity).insert({
    id: channelId,
    workspaceId: fixture.workspaceId,
    connectedAccountId: accountId,
    type: MessageChannelType.APP,
    handle: 'chat',
    displayName: 'Before',
    visibility: MessageChannelVisibility.SHARE_EVERYTHING,
  });
  events.emitCustomBatchEvent.mockReset();
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (runtime.isInitialized) await runtime.destroy();
  await fixture.dispose();
});
const mutate = (kind: string) => {
  switch (kind) {
    case 'accountRename':
      return accounts.update({
        id: accountId,
        workspaceId: fixture.workspaceId,
        data: { handle: 'Renamed' },
      });
    case 'accountArchive':
      return accounts.update({
        id: accountId,
        workspaceId: fixture.workspaceId,
        data: { archivedAt: new Date() },
      });
    case 'channelRename':
      return channels.update({
        id: channelId,
        workspaceId: fixture.workspaceId,
        data: { displayName: 'Renamed' },
      });
    case 'channelDelete':
      return channels.delete({
        id: channelId,
        workspaceId: fixture.workspaceId,
      });
    case 'channelCreate':
      return createChannel();
    default:
      throw new Error('Unknown test mutation');
  }
};
describe('atomic metadata writers over actual core repositories', () => {
  it('discards a connection after unconfirmed rollback and releases account locks', async () => {
    const create = runtime.createQueryRunner.bind(runtime);
    let runner: QueryRunner | undefined;
    jest.spyOn(runtime, 'createQueryRunner').mockImplementationOnce(() => {
      runner = create();
      const query = runner.query.bind(runner);
      runner.query = async (...args: Parameters<QueryRunner['query']>) => {
        const result = await query(...args);
        if (args[0].startsWith('SELECT candidate.id FROM unnest'))
          throw new Error('ownership interrupted');
        return result;
      };
      jest
        .spyOn(runner, 'rollbackTransaction')
        .mockRejectedValue(new Error('rollback transport failure'));
      return runner;
    });
    await expect(mutate('accountRename')).rejects.toThrow(
      'OMNI_CORE_ROLLBACK_UNCONFIRMED',
    );
    expect(runner?.isReleased).toBe(true);
    await fixture.owner.transaction(async (manager) => {
      await manager.query("SET LOCAL lock_timeout = '1500ms'");
      await manager.query(
        'UPDATE core."connectedAccount" SET handle=$1 WHERE id=$2',
        ['recovered', accountId],
      );
    });
    expect(events.emitCustomBatchEvent).not.toHaveBeenCalled();
  });

  it('publishes deletion only after another connection can observe the commit', async () => {
    let observation: Promise<{ count: number }[]> | undefined;
    events.emitCustomBatchEvent.mockImplementation(() => {
      observation = fixture.owner.query(
        'SELECT count(*)::int AS count FROM core."messageChannel" WHERE id=$1',
        [channelId],
      );
    });
    await channels.delete({ id: channelId, workspaceId: fixture.workspaceId });
    expect(await observation).toEqual([{ count: 0 }]);
    expect(events.emitCustomBatchEvent).toHaveBeenCalledTimes(1);
  });
  it('does not publish a success event after a lost commit acknowledgement', async () => {
    const create = runtime.createQueryRunner.bind(runtime);
    jest.spyOn(runtime, 'createQueryRunner').mockImplementationOnce(() => {
      const runner = create();
      const commit = runner.commitTransaction.bind(runner);
      runner.commitTransaction = async () => {
        await commit();
        throw new Error('lost commit ACK');
      };
      return runner;
    });
    await expect(
      channels.delete({ id: channelId, workspaceId: fixture.workspaceId }),
    ).rejects.toThrow('OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN');
    expect(await runtime.getRepository(MessageChannelEntity).count()).toBe(0);
    expect(events.emitCustomBatchEvent).not.toHaveBeenCalled();
  });
  it('fails closed if ownership SQL becomes unreadable', async () => {
    await fixture.owner.query(
      `REVOKE SELECT ON core."omniAccountBinding" FROM "${fixture.roleName}"`,
    );
    try {
      await expect(mutate('channelRename')).rejects.toThrow(
        'permission denied',
      );
    } finally {
      await fixture.owner.query(
        `GRANT SELECT ON core."omniAccountBinding" TO "${fixture.roleName}"`,
      );
    }
    expect((await readChannel()).displayName).toBe('Before');
    expect(events.emitCustomBatchEvent).not.toHaveBeenCalled();
  });

  it('APP create makes missing, foreign-workspace and foreign-application parents indistinguishable', async () => {
    const parent = randomUUID();
    const args = {
      ...scope(),
      connectedAccountId: parent,
      handle: 'hidden',
      visibility: MessageChannelVisibility.SHARE_EVERYTHING,
    };
    const missing = await capture(app.create(args));
    await runtime.getRepository(ConnectedAccountEntity).insert({
      id: parent,
      workspaceId: fixture.workspaceId,
      provider: ConnectedAccountProvider.APP,
      applicationId: randomUUID(),
      scope: 'WORKSPACE',
      userWorkspaceId: memberId,
      handle: 'hidden',
    });
    const otherApp = await capture(app.create(args));
    await runtime
      .getRepository(ConnectedAccountEntity)
      .update(parent, { workspaceId: randomUUID(), applicationId: appId });
    const otherWorkspace = await capture(app.create(args));
    expect(missing).toMatchObject({
      error: { message: `Connection ${parent} not found` },
    });
    expect(otherApp).toEqual(missing);
    expect(otherWorkspace).toEqual(missing);
    expect(await runtime.getRepository(MessageChannelEntity).count()).toBe(1);
  });

  it.each([
    'accountRename',
    'accountArchive',
    'channelRename',
    'channelDelete',
    'channelCreate',
  ])('bootstrap first rejects %s without mutation or event', async (kind) => {
    const entered = barrier(),
      resume = barrier();
    const first = capture(
      bootstrap(async () => {
        entered.release();
        await resume.promise;
      }),
    );
    await entered.promise;
    const second = capture(mutate(kind));
    try {
      await blocked();
    } finally {
      resume.release();
    }
    expect(await first).toHaveProperty('value');
    expect(await second).toMatchObject({
      error: { message: expect.stringContaining('OMNI_OWNED_') },
    });
    expect((await readChannel()).displayName).toBe('Before');
    expect(events.emitCustomBatchEvent).not.toHaveBeenCalled();
  });
  it.each([
    'accountRename',
    'accountArchive',
    'channelRename',
    'channelDelete',
    'channelCreate',
  ])(
    'metadata first commits %s before bootstrap rechecks eligibility',
    async (kind) => {
      const pause = pauseNextRunner((sql) =>
        sql.startsWith('SELECT candidate.id FROM unnest'),
      );
      const first = capture(mutate(kind));
      await pause.reached;
      const second = capture(bootstrap());
      try {
        await blocked();
      } finally {
        pause.resume();
      }
      expect(await first).toHaveProperty('value');
      const result = await second;
      if (kind === 'accountArchive' || kind === 'channelDelete')
        expect(result).toMatchObject({
          error: { message: 'Bootstrap native account/channel mismatch' },
        });
      else expect(result).toHaveProperty('value');
      expect(events.emitCustomBatchEvent).toHaveBeenCalledTimes(
        kind === 'channelDelete' ? 1 : 0,
      );
    },
  );
  it.each(['workspace', 'connectedAccount', 'messageFolders'])(
    'rejects create relation injection via %s',
    async (field) => {
      const data = {
        workspaceId: fixture.workspaceId,
        connectedAccountId: accountId,
        handle: 'unsafe',
        visibility: MessageChannelVisibility.SHARE_EVERYTHING,
        type: MessageChannelType.APP,
        syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
        [field]:
          field === 'messageFolders'
            ? [{ id: randomUUID() }]
            : { id: randomUUID() },
      } as Parameters<typeof channels.create>[0];
      await expect(channels.create(data)).rejects.toThrow('SCOPE_CHANGE');
      expect(await runtime.getRepository(MessageChannelEntity).count()).toBe(1);
    },
  );
  it('rejects a foreign-workspace parent before saving a channel', async () => {
    const foreign = randomUUID();
    await runtime.getRepository(ConnectedAccountEntity).insert({
      id: foreign,
      workspaceId: randomUUID(),
      provider: ConnectedAccountProvider.APP,
      handle: 'foreign',
      scope: 'WORKSPACE',
      userWorkspaceId: memberId,
    });
    await expect(createChannel(foreign)).rejects.toThrow(
      'DESTINATION_ACCOUNT_NOT_FOUND',
    );
    expect(await runtime.getRepository(MessageChannelEntity).count()).toBe(1);
  });
  it('refuses a destination whose ownership committed while channel update waited', async () => {
    const destination = randomUUID(),
      destinationChannel = randomUUID();
    await runtime.getRepository(ConnectedAccountEntity).insert({
      id: destination,
      workspaceId: fixture.workspaceId,
      provider: ConnectedAccountProvider.APP,
      scope: 'WORKSPACE',
      userWorkspaceId: memberId,
      handle: 'destination',
    });
    await runtime.getRepository(MessageChannelEntity).insert({
      id: destinationChannel,
      workspaceId: fixture.workspaceId,
      connectedAccountId: destination,
      type: MessageChannelType.APP,
      handle: 'destination',
      visibility: MessageChannelVisibility.SHARE_EVERYTHING,
    });
    const entered = barrier(),
      resume = barrier();
    const first = capture(
      bootstrap(
        async () => {
          entered.release();
          await resume.promise;
        },
        destination,
        destinationChannel,
      ),
    );
    await entered.promise;
    const second = capture(
      channels.update({
        id: channelId,
        workspaceId: fixture.workspaceId,
        data: { connectedAccountId: destination },
      }),
    );
    try {
      await blocked();
    } finally {
      resume.release();
    }
    expect(await first).toHaveProperty('value');
    expect(await second).toMatchObject({
      error: { message: 'OMNI_OWNED_ACCOUNT_REQUIRES_DOMAIN_LIFECYCLE' },
    });
    expect((await readChannel()).connectedAccountId).toBe(accountId);
  });
  it('refuses a stale source parent after discovery instead of authorizing the new parent', async () => {
    const destination = randomUUID();
    await runtime.getRepository(ConnectedAccountEntity).insert({
      id: destination,
      workspaceId: fixture.workspaceId,
      provider: ConnectedAccountProvider.APP,
      scope: 'WORKSPACE',
      userWorkspaceId: memberId,
      handle: 'destination',
    });
    const pause = pauseNextRunner(
      (sql) =>
        sql.startsWith('SELECT "connectedAccountId" FROM') &&
        !sql.endsWith('FOR UPDATE'),
    );
    const first = capture(
      channels.update({
        id: channelId,
        workspaceId: fixture.workspaceId,
        data: { displayName: 'Stale' },
      }),
    );
    await pause.reached;
    try {
      await channels.update({
        id: channelId,
        workspaceId: fixture.workspaceId,
        data: { connectedAccountId: destination },
      });
    } finally {
      pause.resume();
    }
    expect(await first).toMatchObject({
      error: { message: 'OMNI_METADATA_PARENT_CHANGED_RETRY' },
    });
    expect((await readChannel()).displayName).toBe('Before');
  });
  it.each(['applicationId', 'scope', 'userWorkspaceId'])(
    'APP authorization reads fresh locked %s',
    async (field) => {
      await runtime.getRepository(ConnectedAccountEntity).update(accountId, {
        applicationId: appId,
        scope: field === 'userWorkspaceId' ? 'USER' : 'WORKSPACE',
      });
      const data =
        field === 'applicationId'
          ? { applicationId: randomUUID() }
          : field === 'scope'
            ? { scope: 'USER' as const, userWorkspaceId: randomUUID() }
            : { userWorkspaceId: randomUUID() };
      const pause = pauseNextRunner((sql) =>
        sql.startsWith('SELECT candidate.id FROM unnest'),
      );
      const first = capture(
        accounts.update({
          id: accountId,
          workspaceId: fixture.workspaceId,
          data,
        }),
      );
      await pause.reached;
      const second = capture(
        app.update({ ...scope(), displayName: 'Forbidden' }),
      );
      try {
        await blocked();
      } finally {
        pause.resume();
      }
      expect(await first).toHaveProperty('value');
      expect(await second).toMatchObject({
        error: { message: expect.stringContaining('not found') },
      });
      expect((await readChannel()).displayName).toBe('Before');
    },
  );
  it('commits concurrent opposite reparents without deadlock', async () => {
    const destination = randomUUID(),
      otherChannel = randomUUID();
    await runtime.getRepository(ConnectedAccountEntity).insert({
      id: destination,
      workspaceId: fixture.workspaceId,
      provider: ConnectedAccountProvider.APP,
      scope: 'WORKSPACE',
      userWorkspaceId: memberId,
      handle: 'other',
    });
    await runtime.getRepository(MessageChannelEntity).insert({
      id: otherChannel,
      workspaceId: fixture.workspaceId,
      connectedAccountId: destination,
      type: MessageChannelType.APP,
      handle: 'other',
      visibility: MessageChannelVisibility.SHARE_EVERYTHING,
    });
    await Promise.all([
      channels.update({
        id: channelId,
        workspaceId: fixture.workspaceId,
        data: { connectedAccountId: destination },
      }),
      channels.update({
        id: otherChannel,
        workspaceId: fixture.workspaceId,
        data: { connectedAccountId: accountId },
      }),
    ]);
    expect((await readChannel()).connectedAccountId).toBe(destination);
    expect(
      (
        await runtime
          .getRepository(MessageChannelEntity)
          .findOneByOrFail({ id: otherChannel })
      ).connectedAccountId,
    ).toBe(accountId);
  });
  it('rolls back SQL failure and publishes no deletion event', async () => {
    await fixture.owner.query(
      `REVOKE DELETE ON core."messageChannel" FROM "${fixture.roleName}"`,
    );
    try {
      await expect(
        channels.delete({ id: channelId, workspaceId: fixture.workspaceId }),
      ).rejects.toThrow('permission denied');
    } finally {
      await fixture.owner.query(
        `GRANT DELETE ON core."messageChannel" TO "${fixture.roleName}"`,
      );
    }
    expect(await readChannel()).toBeDefined();
    expect(events.emitCustomBatchEvent).not.toHaveBeenCalled();
  });
  it.each([MessageChannelType.EMAIL, MessageChannelType.EMAIL_GROUP])(
    'preserves ordinary %s update/create/delete',
    async (type) => {
      await runtime
        .getRepository(MessageChannelEntity)
        .update(channelId, { type });
      await channels.update({
        id: channelId,
        workspaceId: fixture.workspaceId,
        data: { displayName: 'Ordinary' },
      });
      expect((await readChannel()).displayName).toBe('Ordinary');
      const created = await channels.create({
        workspaceId: fixture.workspaceId,
        connectedAccountId: accountId,
        handle: 'new-email',
        type,
        visibility: MessageChannelVisibility.SHARE_EVERYTHING,
        syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
      });
      expect(created.type).toBe(type);

      await channels.delete({
        id: channelId,
        workspaceId: fixture.workspaceId,
      });
      expect(events.emitCustomBatchEvent).toHaveBeenCalledTimes(1);
    },
  );
  it('preserves APP create/update/delete and read-only no-op', async () => {
    await runtime
      .getRepository(ConnectedAccountEntity)
      .update(accountId, { applicationId: appId });
    const before = await app.update(scope());
    expect(before.displayName).toBe('Before');
    const created = await app.create({
      ...scope(),
      connectedAccountId: accountId,
      handle: 'new',
      visibility: MessageChannelVisibility.SHARE_EVERYTHING,
    });
    await app.update({ ...scope(), id: created.id, displayName: ' App ' });
    expect(
      (
        await runtime
          .getRepository(MessageChannelEntity)
          .findOneByOrFail({ id: created.id })
      ).displayName,
    ).toBe('App');
    await app.delete({ ...scope(), id: created.id });
    expect(events.emitCustomBatchEvent).toHaveBeenCalledTimes(1);
  });
});
