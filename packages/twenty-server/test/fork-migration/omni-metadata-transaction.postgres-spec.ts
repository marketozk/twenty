import { CalendarChannelMetadataService } from 'src/engine/metadata-modules/calendar-channel/calendar-channel-metadata.service';
jest.mock(
  'src/engine/metadata-modules/calendar-channel/dtos/calendar-channel.dto',
  () => ({ CalendarChannelDTO: class {} }),
);
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { DataSource, EntitySchema, type QueryRunner } from 'typeorm';
import {
  WebhookSubscriptionStatus,
  ConnectedAccountProvider,
  MessageChannelType,
  MessageChannelVisibility,
  MessageChannelSyncStage,
} from 'twenty-shared/types';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { ConnectedAccountMetadataService } from 'src/engine/metadata-modules/connected-account/connected-account-metadata.service';
import { ConnectedAccountOwnershipTransferService } from 'src/engine/metadata-modules/connected-account/services/connected-account-ownership-transfer.service';
jest.mock('src/engine/metadata-modules/user-role/user-role.service', () => ({
  UserRoleService: class {},
}));
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
    updatedAt: { type: 'timestamptz', updateDate: true },
    accessToken: { type: 'text', nullable: true },
    refreshToken: { type: 'text', nullable: true },
    connectionParameters: { type: 'jsonb', nullable: true },
    authFailedAt: { type: 'timestamptz', nullable: true },
    authFailedReason: { type: 'text', nullable: true },
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
    updatedAt: { type: 'timestamptz', updateDate: true },
    visibility: { type: 'text' },
    isSyncEnabled: { type: 'boolean', default: true },
    webhookSubscriptionStatus: { type: 'text', nullable: true },
    syncStage: { type: 'text', nullable: true },
    syncStatus: { type: 'text', nullable: true },
    isContactAutoCreationEnabled: { type: 'boolean', nullable: true },
    contactAutoCreationPolicy: { type: 'text', nullable: true },
    excludeGroupEmails: { type: 'boolean', nullable: true },
    excludeNonProfessionalEmails: { type: 'boolean', nullable: true },
    pendingGroupEmailsAction: { type: 'text', nullable: true },
  },
});
const calendarSchema = new EntitySchema<CalendarChannelEntity>({
  name: 'LifecycleCalendarFixture',
  target: CalendarChannelEntity,
  schema: 'core',
  tableName: 'calendarChannel',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    connectedAccountId: { type: 'uuid' },
    isSyncEnabled: { type: 'boolean' },
    updatedAt: { type: 'timestamptz', updateDate: true },
    webhookSubscriptionStatus: { type: 'text', nullable: true },
  },
});
const external = {
  revoke: jest.fn(),
  hooks: jest.fn(),
  message: jest.fn(),
  calendar: jest.fn(),
};
const accountPermission = jest.fn();
const runtime = new DataSource({
  type: 'postgres',
  url: fixture.runtimeDatabaseUrl,
  entities: [accountSchema, channelSchema, calendarSchema],
  synchronize: false,
  migrationsRun: false,
  extra: { max: 4, statement_timeout: 10000 },
});
const events = { emitCustomBatchEvent: jest.fn() };
let accounts: ConnectedAccountMetadataService;
let channels: MessageChannelMetadataService;
let app: ApplicationMessageChannelsService;
let accountId: string, channelId: string, memberId: string, appId: string;
const custodianId = randomUUID();
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
    'CREATE TABLE core."userWorkspace" (id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL REFERENCES core.workspace(id),"userId" uuid,"deletedAt" timestamptz)',
  );
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
  await fixture.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "accessToken" text,ADD "refreshToken" text,ADD "connectionParameters" jsonb,ADD "authFailedAt" timestamptz,ADD "authFailedReason" text',
  );
  await fixture.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "oidcTokenClaims" jsonb',
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageChannel" ADD "webhookSubscriptionStatus" text',
  );
  await fixture.owner.query(
    'CREATE TABLE core."calendarChannel" (id uuid PRIMARY KEY,"workspaceId" uuid,"connectedAccountId" uuid REFERENCES core."connectedAccount"(id) ON DELETE CASCADE,"isSyncEnabled" boolean,"webhookSubscriptionStatus" text)',
  );
  await fixture.owner.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON core."calendarChannel" TO "${fixture.roleName}"`,
  );
  for (const table of ['connectedAccount', 'messageChannel', 'calendarChannel'])
    await fixture.owner.query(
      'ALTER TABLE core."' +
        table +
        '" ADD "updatedAt" timestamptz NOT NULL DEFAULT now()',
    );
  await runtime.initialize();
  type AccountDependencies = ConstructorParameters<
    typeof ConnectedAccountMetadataService
  >;
  accounts = new ConnectedAccountMetadataService(
    runtime.getRepository(ConnectedAccountEntity),
    runtime.getRepository(CalendarChannelEntity),
    runtime.getRepository(MessageChannelEntity),
    { revokeIfApp: external.revoke } as unknown as AccountDependencies[3],
    { runOnDisconnect: external.hooks } as unknown as AccountDependencies[4],
    {
      userHasWorkspaceSettingPermission: accountPermission,
    } as unknown as AccountDependencies[5],
    events as unknown as AccountDependencies[6],
    {
      deleteSubscription: external.calendar,
    } as unknown as AccountDependencies[7],
    {
      deleteSubscription: external.message,
    } as unknown as AccountDependencies[8],
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
  await fixture.owner.query(
    'INSERT INTO core."userWorkspace" (id,"workspaceId") VALUES($1,$3),($2,$3)',
    [memberId, custodianId, fixture.workspaceId],
  );
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
  Object.values(external).forEach((fn) =>
    fn.mockReset().mockResolvedValue(undefined),
  );
  accountPermission.mockReset().mockResolvedValue(false);
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
  it.each(['scope', 'userWorkspaceId'])(
    'APP authorization reads fresh locked %s',
    async (field) => {
      await runtime.getRepository(ConnectedAccountEntity).update(accountId, {
        applicationId: appId,
        scope: field === 'userWorkspaceId' ? 'USER' : 'WORKSPACE',
      });
      const data =
        field === 'scope'
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

describe('account identity cannot be repurposed by generic metadata', () => {
  it.each([
    { provider: ConnectedAccountProvider.GOOGLE },
    { applicationId: randomUUID() },
    { connectionProviderId: randomUUID() },
  ])(
    'rejects identity conversion %j before and after bootstrap',
    async (data) => {
      await expect(
        accounts.update({
          id: accountId,
          workspaceId: fixture.workspaceId,
          data,
        }),
      ).rejects.toThrow('CONNECTED_ACCOUNT_IDENTITY_IMMUTABLE');
      await bootstrap();
      await expect(
        accounts.update({
          id: accountId,
          workspaceId: fixture.workspaceId,
          data,
        }),
      ).rejects.toThrow('OMNI_OWNED_ACCOUNT');
    },
  );
  it.each(['application', 'connectionProvider'])(
    'rejects relation-shaped identity %s',
    async (field) => {
      await expect(
        accounts.update({
          id: accountId,
          workspaceId: fixture.workspaceId,
          data: { [field]: null },
        }),
      ).rejects.toThrow('OMNI_METADATA_SCOPE_CHANGE');
      expect(
        (
          await runtime
            .getRepository(ConnectedAccountEntity)
            .findOneByOrFail({ id: accountId })
        ).provider,
      ).toBe(ConnectedAccountProvider.APP);
    },
  );
  it('allows an unchanged explicit identity', async () => {
    await expect(
      accounts.update({
        id: accountId,
        workspaceId: fixture.workspaceId,
        data: {
          provider: ConnectedAccountProvider.APP,
          applicationId: null,
          connectionProviderId: null,
        },
      }),
    ).resolves.toMatchObject({ id: accountId });
  });
  it.each([
    ConnectedAccountProvider.GOOGLE,
    ConnectedAccountProvider.MICROSOFT,
    ConnectedAccountProvider.IMAP_SMTP_CALDAV,
    ConnectedAccountProvider.EMAIL_GROUP,
  ])(
    'does not bootstrap ordinary %s accounts even with an APP channel',
    async (provider) => {
      await runtime
        .getRepository(ConnectedAccountEntity)
        .update(accountId, { provider });
      await expect(bootstrap()).rejects.toThrow(
        'Bootstrap native account/channel mismatch',
      );
      expect(
        await runtime.query('SELECT id FROM core."omniAccountBinding"'),
      ).toEqual([]);
    },
  );
});

const pauseLifecycleMutation = (matches: (sql: string) => boolean) => {
  const reached = barrier(),
    resume = barrier();
  let used = false;
  const original = runtime.createQueryRunner.bind(runtime);
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
    const runner = original(),
      query = runner.query.bind(runner);
    runner.query = async (...args: Parameters<QueryRunner['query']>) => {
      const result = await query(...args);
      if (!used && runner.isTransactionActive && matches(args[0])) {
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
describe('account lifecycle final core transaction', () => {
  const methods = ['disconnect', 'transfer', 'deleteMany'] as const;
  const invoke = (
    method: (typeof methods)[number],
    auditOperation?: CrmAuditOperation,
  ) =>
    method === 'disconnect'
      ? accounts.disconnect({
          id: accountId,
          workspaceId: fixture.workspaceId,
          caller: { userWorkspaceId: memberId },
          auditOperation,
        })
      : method === 'transfer'
        ? accounts.transferOwnership({
            fromUserWorkspaceId: memberId,
            toUserWorkspaceId: custodianId,
            workspaceId: fixture.workspaceId,
            auditOperation,
          })
        : accounts.deleteMany({
            ids: [accountId],
            workspaceId: fixture.workspaceId,
          });
  const setupCredentials = async () => {
    await runtime.getRepository(ConnectedAccountEntity).update(accountId, {
      accessToken: 'encrypted-fixture' as never,
      refreshToken: 'encrypted-fixture' as never,
      connectionParameters: {} as never,
    });
    await runtime.getRepository(MessageChannelEntity).update(channelId, {
      webhookSubscriptionStatus: WebhookSubscriptionStatus.PENDING,
    });
    await runtime.getRepository(CalendarChannelEntity).insert({
      id: randomUUID(),
      workspaceId: fixture.workspaceId,
      connectedAccountId: accountId,
      isSyncEnabled: true,
      webhookSubscriptionStatus: WebhookSubscriptionStatus.PENDING,
    });
  };
  const auditIdentity = (): CrmAuditOperation => ({
    workspaceId: fixture.workspaceId,
    operationId: randomUUID(),
    actor: { kind: 'coreUser', id: randomUUID() },
    correlationId: randomUUID(),
  });
  const readTransferAudit = () =>
    fixture.owner.query('SELECT * FROM crm_audit."crmAuditEntry"');
  it('disconnect returns committed account and audits credential and authentication failure cleanup', async () => {
    await setupCredentials();
    await runtime.getRepository(ConnectedAccountEntity).update(accountId, {
      authFailedAt: new Date(),
      authFailedReason: 'provider-secret-diagnostic',
    });
    const identity = auditIdentity();
    const result = await invoke('disconnect', identity);
    expect(result).toMatchObject({
      id: accountId,
      userWorkspaceId: memberId,
      accessToken: null,
      refreshToken: null,
      connectionParameters: null,
      authFailedAt: null,
      authFailedReason: null,
      archivedAt: expect.any(Date),
    });
    const rows = await readTransferAudit();
    expect(
      rows.map((row: { resourceKind: string }) => row.resourceKind).sort(),
    ).toEqual(['calendarChannel', 'connectedAccount', 'messageChannel']);
    expect(JSON.stringify(rows)).not.toMatch(
      /encrypted-fixture|provider-secret-diagnostic/,
    );
    expect(
      rows.every(
        (row: { correlationId: string }) =>
          row.correlationId === identity.correlationId,
      ),
    ).toBe(true);
    expect(rows[0].actor).toEqual(identity.actor);
    const account = rows.find(
      (row: { resourceKind: string }) =>
        row.resourceKind === 'connectedAccount',
    );
    expect(account.redactedDiff.changedFields).toContain('authFailedReason');
    expect(account.redactedDiff.values).not.toHaveProperty('authFailedReason');
    await invoke('disconnect', identity);
    expect(await readTransferAudit()).toHaveLength(3);
  });
  it.each(['custodian', 'scope', 'membership'] as const)(
    'disconnect rejects fresh %s changes during external work',
    async (change) => {
      await setupCredentials();
      await runtime.getRepository(ConnectedAccountEntity).update(accountId, {
        provider: ConnectedAccountProvider.GOOGLE,
        scope: change === 'scope' ? 'WORKSPACE' : 'USER',
        userWorkspaceId: change === 'scope' ? custodianId : memberId,
      });
      accountPermission.mockResolvedValue(true);
      const reached = barrier(),
        resume = barrier();
      external.message.mockImplementationOnce(async () => {
        reached.release();
        await resume.promise;
      });
      const pending = capture(invoke('disconnect', auditIdentity()));
      await reached.promise;
      try {
        if (change === 'membership')
          await fixture.owner.query(
            'UPDATE core."userWorkspace" SET "deletedAt"=now() WHERE id=$1',
            [memberId],
          );
        else
          await runtime
            .getRepository(ConnectedAccountEntity)
            .update(
              accountId,
              change === 'scope'
                ? { scope: 'USER' }
                : { userWorkspaceId: custodianId },
            );
      } finally {
        resume.release();
      }
      expect(await pending).toHaveProperty('error');
      expect(
        (
          await runtime
            .getRepository(ConnectedAccountEntity)
            .findOneByOrFail({ id: accountId })
        ).accessToken,
      ).toBe('encrypted-fixture');
      expect(await readTransferAudit()).toEqual([]);
      // Already completed provider revocation is outside the DB rollback boundary.
      expect(external.revoke).toHaveBeenCalledTimes(1);
    },
  );
  it('disconnect allows current workspace administrator and preserves captured caller and identity', async () => {
    await setupCredentials();
    await runtime.getRepository(ConnectedAccountEntity).update(accountId, {
      provider: ConnectedAccountProvider.GOOGLE,
      scope: 'WORKSPACE',
      userWorkspaceId: custodianId,
    });
    accountPermission.mockResolvedValue(true);
    const identity = auditIdentity(),
      actor = { ...identity.actor },
      caller = { userWorkspaceId: memberId, applicationId: randomUUID() },
      capturedCaller = { ...caller };
    const reached = barrier(),
      resume = barrier();
    external.message.mockImplementationOnce(async () => {
      reached.release();
      await resume.promise;
    });
    const pending = accounts.disconnect({
      id: accountId,
      workspaceId: fixture.workspaceId,
      caller,
      auditOperation: identity,
    });
    await reached.promise;
    caller.userWorkspaceId = randomUUID();
    caller.applicationId = randomUUID();
    identity.actor.id = randomUUID();
    resume.release();
    expect(await pending).toMatchObject({
      userWorkspaceId: custodianId,
      accessToken: null,
    });
    expect(accountPermission).toHaveBeenLastCalledWith(
      expect.objectContaining(capturedCaller),
    );
    expect((await readTransferAudit())[0].actor).toEqual(actor);
  });
  it('disconnect denies a non-owner before provider effects', async () => {
    await runtime.getRepository(ConnectedAccountEntity).update(accountId, {
      provider: ConnectedAccountProvider.GOOGLE,
      scope: 'USER',
      userWorkspaceId: custodianId,
    });
    await expect(invoke('disconnect', auditIdentity())).rejects.toThrow(
      'cannot be administered',
    );
    for (const fn of Object.values(external)) expect(fn).not.toHaveBeenCalled();
    expect(await readTransferAudit()).toEqual([]);
  });
  it('disconnect refuses a transaction-bound repository before external effects', async () => {
    await setupCredentials();
    const runner = runtime.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    const service = Object.create(accounts) as ConnectedAccountMetadataService;
    Object.defineProperty(service, 'repository', {
      value: runner.manager.getRepository(ConnectedAccountEntity),
    });
    try {
      await expect(
        service.disconnect({
          id: accountId,
          workspaceId: fixture.workspaceId,
          caller: { userWorkspaceId: memberId },
          auditOperation: auditIdentity(),
        }),
      ).rejects.toThrow('OMNI_METADATA_REQUIRES_FRESH_TRANSACTION');
      expect(runner.isTransactionActive).toBe(true);
      for (const fn of Object.values(external))
        expect(fn).not.toHaveBeenCalled();
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
    expect(
      (
        await runtime
          .getRepository(ConnectedAccountEntity)
          .findOneByOrFail({ id: accountId })
      ).accessToken,
    ).toBe('encrypted-fixture');
    expect(await readTransferAudit()).toEqual([]);
  });
  it('disconnect holds caller membership until the final commit', async () => {
    const pause = pauseLifecycleMutation(
      (sql) =>
        sql.startsWith('SELECT to_jsonb(member)') && sql.endsWith('FOR SHARE'),
    );
    const first = capture(invoke('disconnect', auditIdentity()));
    await pause.reached;
    const second = capture(
      fixture.owner.query(
        'UPDATE core."userWorkspace" SET "deletedAt"=now() WHERE id=$1',
        [memberId],
      ),
    );
    try {
      await blocked();
    } finally {
      pause.resume();
    }
    expect(await first).toHaveProperty('value');
    expect(await second).toHaveProperty('value');
    expect(await readTransferAudit()).toHaveLength(2);
  });
  it('disconnect preserves archive date and audits only remaining authentication failure', async () => {
    const archivedAt = new Date('2026-01-02T03:04:05Z');
    await runtime.getRepository(ConnectedAccountEntity).update(accountId, {
      archivedAt,
      authFailedAt: new Date(),
      authFailedReason: 'private',
    });
    await runtime.getRepository(MessageChannelEntity).update(channelId, {
      isSyncEnabled: false,
      webhookSubscriptionStatus: WebhookSubscriptionStatus.EXPIRED,
    });
    expect(await invoke('disconnect', auditIdentity())).toMatchObject({
      archivedAt,
      authFailedReason: null,
    });
    const rows = await readTransferAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0].resourceKind).toBe('connectedAccount');
    expect(JSON.stringify(rows)).not.toContain('private');
  });
  it('disconnect captures cross-workspace impersonation and delegated application attribution', async () => {
    const other = randomUUID(),
      impersonator = randomUUID(),
      initiator = randomUUID(),
      user = randomUUID(),
      application = randomUUID();
    await fixture.owner.query('INSERT INTO core.workspace(id) VALUES($1)', [
      other,
    ]);
    await fixture.owner.query(
      'INSERT INTO core."userWorkspace"(id,"workspaceId","userId") VALUES($1,$2,$3)',
      [impersonator, other, initiator],
    );
    const operation = await accounts.captureDisconnectionAuditOperation({
      workspaceId: fixture.workspaceId,
      user: { id: user },
      impersonatorUserWorkspaceId: impersonator,
    });
    expect(operation).toMatchObject({
      workspaceId: fixture.workspaceId,
      actor: { kind: 'coreUser', id: user },
      initiator: { kind: 'coreUser', id: initiator },
    });
    await invoke('disconnect', operation);
    expect((await readTransferAudit())[0]).toMatchObject({
      actor: operation.actor,
      initiator: operation.initiator,
    });
    const delegated = await accounts.captureDisconnectionAuditOperation({
      workspaceId: fixture.workspaceId,
      user: { id: user },
      application: { id: application },
    });
    expect(delegated).toMatchObject({
      actor: { kind: 'application', id: application },
      initiator: { kind: 'coreUser', id: user },
    });
  });
  it('transfer audits actual account and both channels without credential material', async () => {
    await setupCredentials();
    const identity = auditIdentity();
    await invoke('transfer', identity);
    const rows = await readTransferAudit();
    expect(
      rows.map((row: { resourceKind: string }) => row.resourceKind).sort(),
    ).toEqual(['calendarChannel', 'connectedAccount', 'messageChannel']);
    for (const row of rows)
      expect(row).toMatchObject({
        actor: identity.actor,
        correlationId: identity.correlationId,
        action: 'update',
      });
    expect(
      new Set(rows.map((row: { operationId: string }) => row.operationId)).size,
    ).toBe(1);
    expect(rows[0].operationId).not.toBe(identity.operationId);
    expect(JSON.stringify(rows)).not.toContain('encrypted-fixture');
    expect(JSON.stringify(rows)).not.toContain('connectionParameters');
    expect(
      await runtime
        .getRepository(ConnectedAccountEntity)
        .findOneByOrFail({ id: accountId }),
    ).toMatchObject({
      userWorkspaceId: custodianId,
      accessToken: null,
      refreshToken: null,
      connectionParameters: null,
    });
    await invoke('transfer', identity);
    expect(await readTransferAudit()).toHaveLength(3);
  });
  it.each(['deleted', 'foreign', 'missing'] as const)(
    'rejects %s destination membership before any DB transfer',
    async (kind) => {
      await setupCredentials();
      if (kind === 'deleted')
        await fixture.owner.query(
          'UPDATE core."userWorkspace" SET "deletedAt"=now() WHERE id=$1',
          [custodianId],
        );
      if (kind === 'missing')
        await fixture.owner.query(
          'DELETE FROM core."userWorkspace" WHERE id=$1',
          [custodianId],
        );
      if (kind === 'foreign') {
        const other = randomUUID();
        await fixture.owner.query('INSERT INTO core.workspace(id) VALUES($1)', [
          other,
        ]);
        await fixture.owner.query(
          'UPDATE core."userWorkspace" SET "workspaceId"=$1 WHERE id=$2',
          [other, custodianId],
        );
      }
      await expect(invoke('transfer', auditIdentity())).rejects.toThrow(
        'active workspace memberships',
      );
      expect(
        (
          await runtime
            .getRepository(ConnectedAccountEntity)
            .findOneByOrFail({ id: accountId })
        ).accessToken,
      ).toBe('encrypted-fixture');
      expect(await readTransferAudit()).toEqual([]);
    },
  );
  it.each(['transfer', 'disconnect'] as const)(
    '%s journal denial keeps credential revocation',
    async (method) => {
      await setupCredentials();
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => {});
      await fixture.owner.query(
        'REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "' +
          fixture.roleName +
          '"',
      );
      try {
        await invoke(method, auditIdentity());
        expect(await readTransferAudit()).toEqual([]);
        expect(
          (
            await runtime
              .getRepository(ConnectedAccountEntity)
              .findOneByOrFail({ id: accountId })
          ).accessToken,
        ).toBeNull();
        expect(error).toHaveBeenCalledWith(
          method === 'transfer'
            ? 'CONNECTED_ACCOUNT_TRANSFER_AUDIT_UNAVAILABLE'
            : 'CONNECTED_ACCOUNT_DISCONNECT_AUDIT_UNAVAILABLE',
        );
      } finally {
        await fixture.owner.query(
          'GRANT INSERT ON crm_audit."crmAuditEntry" TO "' +
            fixture.roleName +
            '"',
        );
        error.mockRestore();
      }
    },
  );
  it.each([
    ['transfer', 'mutation'],
    ['transfer', 'journal'],
    ['disconnect', 'mutation'],
    ['disconnect', 'journal'],
  ] as const)(
    'detects %s %s corruption with the correct rollback boundary',
    async (method, phase) => {
      await setupCredentials();
      const triggerTable =
        phase === 'mutation'
          ? 'core."connectedAccount"'
          : 'crm_audit."crmAuditEntry"';
      await fixture.owner.query(
        'CREATE FUNCTION core.corrupt_transfer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE core."messageChannel" SET "displayName"=\'Corrupt\' WHERE id=\'' +
          channelId +
          "'; RETURN NULL; END $$",
      );
      await fixture.owner.query(
        'CREATE TRIGGER corrupt_transfer AFTER ' +
          (phase === 'mutation' ? 'UPDATE' : 'INSERT') +
          ' ON ' +
          triggerTable +
          ' FOR EACH ROW EXECUTE FUNCTION core.corrupt_transfer()',
      );
      try {
        if (phase === 'mutation')
          await expect(invoke(method, auditIdentity())).rejects.toThrow(
            'effects mismatch',
          );
        else await invoke(method, auditIdentity());
        expect((await readChannel()).displayName).toBe('Before');
        expect(
          (
            await runtime
              .getRepository(ConnectedAccountEntity)
              .findOneByOrFail({ id: accountId })
          ).accessToken,
        ).toBe(phase === 'mutation' ? 'encrypted-fixture' : null);
        expect(await readTransferAudit()).toEqual([]);
      } finally {
        await fixture.owner.query(
          'DROP TRIGGER corrupt_transfer ON ' + triggerTable,
        );
        await fixture.owner.query('DROP FUNCTION core.corrupt_transfer()');
      }
    },
  );
  it('refuses mutation-triggered recipient deactivation even when audit is available', async () => {
    await fixture.owner.query(
      'CREATE FUNCTION core.corrupt_recipient() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE core."userWorkspace" SET "deletedAt"=now() WHERE id=\'' +
        custodianId +
        "'; RETURN NULL; END $$",
    );
    await fixture.owner.query(
      'CREATE TRIGGER corrupt_recipient AFTER UPDATE ON core."connectedAccount" FOR EACH ROW EXECUTE FUNCTION core.corrupt_recipient()',
    );
    try {
      await expect(invoke('transfer', auditIdentity())).rejects.toThrow(
        'membership changed',
      );
      expect(
        (
          await fixture.owner.query(
            'SELECT "deletedAt" FROM core."userWorkspace" WHERE id=$1',
            [custodianId],
          )
        )[0].deletedAt,
      ).toBeNull();
      expect(await readTransferAudit()).toEqual([]);
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER corrupt_recipient ON core."connectedAccount"',
      );
      await fixture.owner.query('DROP FUNCTION core.corrupt_recipient()');
    }
  });
  it('membership removal first prevents transfer after the actual lock wait', async () => {
    const writer = fixture.owner.createQueryRunner();
    await writer.connect();
    await writer.startTransaction();
    let pending: ReturnType<typeof capture> | undefined;
    try {
      await writer.query(
        'UPDATE core."userWorkspace" SET "deletedAt"=now() WHERE id=$1',
        [custodianId],
      );
      pending = capture(invoke('transfer', auditIdentity()));
      await blocked();
      await writer.commitTransaction();
      expect(await pending).toMatchObject({
        error: {
          message:
            'Connected account transfer requires active workspace memberships',
        },
      });
      expect(await readTransferAudit()).toEqual([]);
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await pending;
      await writer.release();
    }
  });
  it('transfer first holds the recipient fence until commit and copies caller identity', async () => {
    const pause = pauseLifecycleMutation(
      (sql) =>
        sql.startsWith('SELECT to_jsonb(member)') && sql.endsWith('FOR SHARE'),
    );
    const identity = auditIdentity(),
      actor = { ...identity.actor };
    const first = capture(invoke('transfer', identity));
    await pause.reached;
    identity.actor.id = randomUUID();
    const second = capture(
      fixture.owner.query(
        'UPDATE core."userWorkspace" SET "deletedAt"=now() WHERE id=$1',
        [custodianId],
      ),
    );
    try {
      await blocked();
    } finally {
      pause.resume();
    }
    expect(await first).toHaveProperty('value');
    expect(await second).toHaveProperty('value');
    expect((await readTransferAudit())[0].actor).toEqual(actor);
  });
  it('custodian service captures attribution and source identity before lookup', async () => {
    const pause = barrier(),
      reached = barrier(),
      transfer = jest.fn().mockResolvedValue(undefined);
    const service = new ConnectedAccountOwnershipTransferService(
      {
        resolveCustodianUserWorkspace: async () => {
          reached.release();
          await pause.promise;
          return { id: custodianId };
        },
      } as never,
      { transferOwnership: transfer } as never,
    );
    const identity = auditIdentity(),
      actor = { ...identity.actor },
      removed = { id: memberId, workspaceId: fixture.workspaceId };
    const pending = service.transferConnectedAccountsOwnershipToCustodian({
      removedUserWorkspace: removed as never,
      auditOperation: identity,
    });
    await reached.promise;
    removed.id = randomUUID();
    removed.workspaceId = randomUUID();
    identity.actor.id = randomUUID();
    pause.release();
    await pending;
    expect(transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        fromUserWorkspaceId: memberId,
        workspaceId: fixture.workspaceId,
        toUserWorkspaceId: custodianId,
        auditOperation: expect.objectContaining({ actor }),
      }),
    );
  });
  it('preserves an existing archive date and non-pending channel state', async () => {
    const date = new Date('2026-01-02T03:04:05.000Z');
    await runtime
      .getRepository(ConnectedAccountEntity)
      .update(accountId, { archivedAt: date });
    await runtime.getRepository(MessageChannelEntity).update(channelId, {
      isSyncEnabled: false,
      webhookSubscriptionStatus: WebhookSubscriptionStatus.EXPIRED,
    });
    await invoke('transfer', auditIdentity());
    expect(
      (
        await runtime
          .getRepository(ConnectedAccountEntity)
          .findOneByOrFail({ id: accountId })
      ).archivedAt,
    ).toEqual(date);
    const rows = await readTransferAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0].resourceKind).toBe('connectedAccount');
  });
  it.each([
    ['transfer', 'mutation'],
    ['transfer', 'journal'],
    ['disconnect', 'mutation'],
    ['disconnect', 'journal'],
  ] as const)(
    'preserves JSONB precision for %s when %s changes an unchanged claim',
    async (method, phase) => {
      await setupCredentials();
      await fixture.owner.query(
        'UPDATE core."connectedAccount" SET "oidcTokenClaims"=$1::jsonb WHERE id=$2',
        ['{"claim":9007199254740992}', accountId],
      );
      const table =
        phase === 'mutation'
          ? 'core."connectedAccount"'
          : 'crm_audit."crmAuditEntry"';
      const body =
        phase === 'mutation'
          ? 'NEW."oidcTokenClaims"=\'{"claim":9007199254740993}\'::jsonb; RETURN NEW;'
          : 'UPDATE core."connectedAccount" SET "oidcTokenClaims"=\'{"claim":9007199254740993}\'::jsonb WHERE id=\'' +
            accountId +
            "'; RETURN NULL;";
      await fixture.owner.query(
        'CREATE FUNCTION core.precision_transfer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ' +
          body +
          ' END $$',
      );
      await fixture.owner.query(
        'CREATE TRIGGER precision_transfer ' +
          (phase === 'mutation' ? 'BEFORE UPDATE' : 'AFTER INSERT') +
          ' ON ' +
          table +
          ' FOR EACH ROW EXECUTE FUNCTION core.precision_transfer()',
      );
      try {
        if (phase === 'mutation')
          await expect(invoke(method, auditIdentity())).rejects.toThrow(
            'effects mismatch',
          );
        else await invoke(method, auditIdentity());
        const [row] = await fixture.owner.query(
          'SELECT "oidcTokenClaims"::text AS claims,"userWorkspaceId" FROM core."connectedAccount" WHERE id=$1',
          [accountId],
        );
        expect(row.claims).toContain('9007199254740992');
        expect(row.userWorkspaceId).toBe(
          phase === 'mutation' || method === 'disconnect'
            ? memberId
            : custodianId,
        );
        expect(await readTransferAudit()).toEqual([]);
      } finally {
        await fixture.owner.query(
          'DROP TRIGGER precision_transfer ON ' + table,
        );
        await fixture.owner.query('DROP FUNCTION core.precision_transfer()');
      }
    },
  );
  it('refuses a foreign operation scope before DB mutation', async () => {
    await expect(
      invoke('transfer', { ...auditIdentity(), workspaceId: randomUUID() }),
    ).rejects.toThrow('audit workspace mismatch');
    expect(
      (
        await runtime
          .getRepository(ConnectedAccountEntity)
          .findOneByOrFail({ id: accountId })
      ).userWorkspaceId,
    ).toBe(memberId);
  });
  it.each(['transfer', 'disconnect'] as const)(
    'unknown COMMIT keeps actual %s and does not retry OAuth revocation',
    async (method) => {
      await setupCredentials();
      await runtime
        .getRepository(ConnectedAccountEntity)
        .update(accountId, { provider: ConnectedAccountProvider.GOOGLE });
      const create = runtime.createQueryRunner.bind(runtime);
      let commits = 0;
      jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
        const runner = create(mode),
          connect = runner.connect.bind(runner);
        if (mode !== 'master') return runner;
        let wrapped = false;
        jest.spyOn(runner, 'connect').mockImplementation(async () => {
          const client = await connect();
          if (!wrapped) {
            wrapped = true;
            const query = client.query.bind(client);
            client.query = async (sql: string, ...args: unknown[]) => {
              const result = await query(sql, ...args);
              if (sql === 'COMMIT') {
                commits++;
                throw new Error('lost acknowledgement');
              }
              return result;
            };
          }
          return client;
        });
        return runner;
      });
      await expect(invoke(method, auditIdentity())).rejects.toBeInstanceOf(
        NativeTransactionOutcomeUnknownError,
      );
      expect(commits).toBe(1);
      expect(external.revoke).toHaveBeenCalledTimes(
        method === 'disconnect' ? 1 : 0,
      );
      expect(
        (
          await fixture.owner.query(
            'SELECT "userWorkspaceId","accessToken" FROM core."connectedAccount" WHERE id=$1',
            [accountId],
          )
        )[0],
      ).toEqual({
        userWorkspaceId: method === 'disconnect' ? memberId : custodianId,
        accessToken: null,
      });
      expect(await readTransferAudit()).toHaveLength(3);
    },
  );
  it.each(methods)(
    'native unbound %s needs no ordinary provider effects',
    async (method) => {
      await setupCredentials();
      await invoke(method);
      for (const effect of Object.values(external))
        expect(effect).not.toHaveBeenCalled();
      if (method === 'deleteMany') {
        expect(
          await runtime
            .getRepository(ConnectedAccountEntity)
            .findOneBy({ id: accountId }),
        ).toBeNull();
        expect(
          await runtime
            .getRepository(MessageChannelEntity)
            .findOneBy({ id: channelId }),
        ).toBeNull();
        expect(events.emitCustomBatchEvent).toHaveBeenCalledTimes(3);
      } else {
        const account = await runtime
          .getRepository(ConnectedAccountEntity)
          .findOneByOrFail({ id: accountId });
        expect(account.archivedAt).not.toBeNull();
        expect(account.accessToken).toBeNull();
        expect(await readChannel()).toMatchObject({
          isSyncEnabled: false,
          webhookSubscriptionStatus: WebhookSubscriptionStatus.EXPIRED,
        });
        const [calendar] = await runtime
          .getRepository(CalendarChannelEntity)
          .findBy({ connectedAccountId: accountId });
        expect(calendar).toMatchObject({
          isSyncEnabled: false,
          webhookSubscriptionStatus: WebhookSubscriptionStatus.EXPIRED,
        });
      }
    },
  );
  it.each(methods)(
    'bootstrap first rejects %s after its initial unowned read',
    async (method) => {
      await setupCredentials();
      const reached = barrier(),
        resume = barrier();
      const first = capture(
        bootstrap(async () => {
          reached.release();
          await resume.promise;
        }),
      );
      await reached.promise;
      const second = capture(invoke(method));
      try {
        await blocked();
      } finally {
        resume.release();
      }
      expect(await first).toHaveProperty('value');
      expect(await second).toMatchObject({
        error: { message: expect.stringContaining('OMNI_OWNED_ACCOUNT') },
      });
      expect(
        (
          await runtime
            .getRepository(ConnectedAccountEntity)
            .findOneByOrFail({ id: accountId })
        ).accessToken,
      ).toBe('encrypted-fixture');
      expect((await readChannel()).isSyncEnabled).toBe(true);
      for (const effect of Object.values(external))
        expect(effect).not.toHaveBeenCalled();
      expect(events.emitCustomBatchEvent).not.toHaveBeenCalled();
    },
  );
  it.each(methods)(
    '%s first prevents a later bootstrap of archived/deleted account',
    async (method) => {
      await setupCredentials();
      const pause = pauseLifecycleMutation((sql) =>
        sql.startsWith('SELECT candidate.id FROM unnest'),
      );
      const first = capture(invoke(method));
      await pause.reached;
      const second = capture(bootstrap());
      try {
        await blocked();
      } finally {
        pause.resume();
      }
      expect(await first).toHaveProperty('value');
      expect(await second).toMatchObject({
        error: { message: 'Bootstrap native account/channel mismatch' },
      });
    },
  );
  it.each(methods)(
    'ordinary mailbox %s still stops subscriptions',
    async (method) => {
      await setupCredentials();
      await runtime
        .getRepository(ConnectedAccountEntity)
        .update(accountId, { provider: ConnectedAccountProvider.GOOGLE });
      await invoke(method);
      expect(external.message).toHaveBeenCalledWith(
        channelId,
        fixture.workspaceId,
      );
      expect(external.calendar).toHaveBeenCalledTimes(1);
      expect(external.revoke).toHaveBeenCalledTimes(1);
    },
  );
  it.each(methods)(
    'retained legacy provider binding refuses %s before network',
    async (method) => {
      await setupCredentials();
      await bootstrap();
      await fixture.owner.query(
        'UPDATE core."connectedAccount" SET provider=$2 WHERE id=$1',
        [accountId, ConnectedAccountProvider.GOOGLE],
      );
      await expect(invoke(method)).rejects.toThrow('OMNI_OWNED_ACCOUNT');
      for (const effect of Object.values(external))
        expect(effect).not.toHaveBeenCalled();
    },
  );
  it.each(['disconnect', 'transfer'] as const)(
    'rolls back account credentials when %s channel write fails',
    async (method) => {
      await setupCredentials();
      const original = runtime.createQueryRunner.bind(runtime);
      jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
        const runner = original(),
          query = runner.query.bind(runner);
        runner.query = async (...args: Parameters<QueryRunner['query']>) => {
          if (args[0].startsWith('UPDATE "core"."messageChannel"'))
            throw new Error('fixture-channel-write-failed');
          return query(...args);
        };
        return runner;
      });
      await expect(invoke(method)).rejects.toThrow(
        'fixture-channel-write-failed',
      );
      expect(
        await runtime
          .getRepository(ConnectedAccountEntity)
          .findOneByOrFail({ id: accountId }),
      ).toMatchObject({
        accessToken: 'encrypted-fixture',
        archivedAt: null,
        userWorkspaceId: memberId,
      });
      expect((await readChannel()).isSyncEnabled).toBe(true);
    },
  );
  it('transfer refuses a stale custodian and rolls back the entire batch', async () => {
    await setupCredentials();
    const repo = runtime.getRepository(ConnectedAccountEntity),
      find = repo.find.bind(repo),
      newCustodian = randomUUID();
    jest.spyOn(repo, 'find').mockImplementationOnce(async (options) => {
      const found = await find(options);
      await fixture.owner.query(
        'UPDATE core."connectedAccount" SET "userWorkspaceId"=$2 WHERE id=$1',
        [accountId, newCustodian],
      );
      return found;
    });
    await expect(invoke('transfer')).rejects.toThrow(
      'CONNECTED_ACCOUNT_CUSTODIAN_CHANGED_RETRY',
    );
    expect(await repo.findOneByOrFail({ id: accountId })).toMatchObject({
      userWorkspaceId: newCustodian,
      accessToken: 'encrypted-fixture',
      archivedAt: null,
    });
  });
  it('provider hook may reenter metadata without holding a core fence/row lock', async () => {
    await runtime.getRepository(ConnectedAccountEntity).update(accountId, {
      applicationId: appId,
      connectionProviderId: randomUUID(),
    });
    external.hooks.mockImplementationOnce(async () => {
      await accounts.update({
        id: accountId,
        workspaceId: fixture.workspaceId,
        data: { handle: 'hook-refreshed' },
      });
    });
    await invoke('disconnect');
    expect(external.hooks).toHaveBeenCalledTimes(1);
    expect(
      (
        await runtime
          .getRepository(ConnectedAccountEntity)
          .findOneByOrFail({ id: accountId })
      ).handle,
    ).toBe('hook-refreshed');
  });
  it('mixed bulk delete refuses owned native records before ordinary effects', async () => {
    await bootstrap();
    const other = randomUUID();
    await runtime.getRepository(ConnectedAccountEntity).insert({
      id: other,
      workspaceId: fixture.workspaceId,
      provider: ConnectedAccountProvider.GOOGLE,
      userWorkspaceId: memberId,
      scope: 'USER',
      handle: 'ordinary',
    });
    await expect(
      accounts.deleteMany({
        ids: [other, accountId],
        workspaceId: fixture.workspaceId,
      }),
    ).rejects.toThrow('OMNI_OWNED_ACCOUNT');
    expect(
      await runtime
        .getRepository(ConnectedAccountEntity)
        .countBy({ workspaceId: fixture.workspaceId }),
    ).toBe(2);
    for (const effect of Object.values(external))
      expect(effect).not.toHaveBeenCalled();
  });
  it('delete events use the locked child set after a hook reparents or creates channels', async () => {
    const destination = randomUUID();
    await runtime.getRepository(ConnectedAccountEntity).insert({
      id: destination,
      workspaceId: fixture.workspaceId,
      provider: ConnectedAccountProvider.APP,
      userWorkspaceId: memberId,
      scope: 'USER',
      handle: 'destination',
    });
    await runtime.getRepository(ConnectedAccountEntity).update(accountId, {
      applicationId: appId,
      connectionProviderId: randomUUID(),
    });
    let createdId: string | undefined;
    external.hooks.mockImplementationOnce(async () => {
      await channels.update({
        id: channelId,
        workspaceId: fixture.workspaceId,
        data: { connectedAccountId: destination },
      });
      await bootstrap(async () => undefined, destination, channelId);
      createdId = (await createChannel(accountId)).id;
    });
    await invoke('deleteMany');
    expect(createdId).toBeDefined();
    expect(events.emitCustomBatchEvent.mock.calls[0][1]).toEqual([
      { messageChannelId: createdId },
    ]);
    expect(await readChannel()).toMatchObject({
      id: channelId,
      connectedAccountId: destination,
    });
    expect(
      await runtime
        .getRepository(MessageChannelEntity)
        .findOneBy({ id: createdId }),
    ).toBeNull();
  });
  it.each(['delete-first', 'reparent-first'] as const)(
    'calendar concurrent reparent has truthful deletion event: %s',
    async (order) => {
      await setupCredentials();
      const destination = randomUUID();
      await runtime.getRepository(ConnectedAccountEntity).insert({
        id: destination,
        workspaceId: fixture.workspaceId,
        provider: ConnectedAccountProvider.GOOGLE,
        userWorkspaceId: memberId,
        scope: 'USER',
        handle: 'other',
      });
      const [calendar] = await runtime
        .getRepository(CalendarChannelEntity)
        .findBy({ connectedAccountId: accountId });
      const service = new CalendarChannelMetadataService(
        runtime.getRepository(CalendarChannelEntity),
        accounts,
        events as never,
      );
      const reparent = () =>
        service.update({
          id: calendar.id,
          workspaceId: fixture.workspaceId,
          data: { connectedAccountId: destination },
        });
      if (order === 'delete-first') {
        const pause = pauseLifecycleMutation((sql) =>
          sql.startsWith('SELECT id FROM core."calendarChannel"'),
        );
        const first = capture(invoke('deleteMany'));
        await pause.reached;
        const second = capture(reparent());
        try {
          await blocked();
        } finally {
          pause.resume();
        }
        expect(await first).toHaveProperty('value');
        expect(await second).toHaveProperty('error');
        expect(events.emitCustomBatchEvent.mock.calls[1][1]).toEqual([
          { calendarChannelId: calendar.id },
        ]);
        expect(
          await runtime
            .getRepository(CalendarChannelEntity)
            .findOneBy({ id: calendar.id }),
        ).toBeNull();
      } else {
        await reparent();
        await invoke('deleteMany');
        expect(events.emitCustomBatchEvent.mock.calls[1][1]).toEqual([]);
        expect(
          await runtime
            .getRepository(CalendarChannelEntity)
            .findOneByOrFail({ id: calendar.id }),
        ).toMatchObject({ connectedAccountId: destination });
      }
    },
  );
  it('delete events observe committed removal on a second connection', async () => {
    const observed: Promise<unknown>[] = [];
    events.emitCustomBatchEvent.mockImplementation(() => {
      observed.push(
        fixture.owner.query(
          'SELECT id FROM core."connectedAccount" WHERE id=$1',
          [accountId],
        ),
      );
    });
    await invoke('deleteMany');
    expect(observed).toHaveLength(3);
    expect(await Promise.all(observed)).toEqual([[], [], []]);
  });
  it('unknown delete commit emits no confirmed deletion events', async () => {
    const original = runtime.createQueryRunner.bind(runtime);
    jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
      const runner = original(),
        commit = runner.commitTransaction.bind(runner);
      runner.commitTransaction = async () => {
        await commit();
        throw new Error('lost-delete-ack');
      };
      return runner;
    });
    await expect(invoke('deleteMany')).rejects.toThrow('OUTCOME_UNKNOWN');
    expect(events.emitCustomBatchEvent).not.toHaveBeenCalled();
    expect(
      await fixture.owner.query(
        'SELECT id FROM core."connectedAccount" WHERE id=$1',
        [accountId],
      ),
    ).toEqual([]);
  });
});
