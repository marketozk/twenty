import { GoogleAPIsService } from 'src/engine/core-modules/auth/services/google-apis.service';
import { MicrosoftAPIsService } from 'src/engine/core-modules/auth/services/microsoft-apis.service';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
jest.mock('src/engine/core-modules/auth/services/google-apis-scopes', () => ({
  GoogleApiScopesService: class {},
}));
jest.mock(
  'src/engine/core-modules/auth/services/google-apis-service-availability.service',
  () => ({ GoogleApisServiceAvailabilityService: class {} }),
);
jest.mock(
  'src/modules/connected-account/webhook-subscription-manager/jobs/create-webhook-subscription.job',
  () => ({ CreateWebhookSubscriptionJob: class {} }),
);
jest.mock(
  'src/modules/onboarding-recent-messages-import/services/onboarding-recent-messages-import.service',
  () => ({ OnboardingRecentMessagesImportService: class {} }),
);
import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema } from 'typeorm';
import {
  ConnectedAccountProvider,
  MessageChannelType,
  MessageChannelSyncStage,
  CalendarChannelSyncStage,
} from 'twenty-shared/types';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { bootstrapOmniAccountBinding } from 'src/modules/omnichannel/services/omni-binding-bootstrap';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';
import { ordinaryConnectedAccountWriteWhere } from 'src/engine/metadata-modules/connected-account/utils/ordinary-connected-account-write.util';
import { ApplicationConnectionsListService } from 'src/engine/core-modules/application/connection-provider/connections/services/application-connections-list.service';
jest.mock(
  'src/engine/workspace-cache/services/workspace-cache.service',
  () => ({ WorkspaceCacheService: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/connection-provider/connection-provider.entity',
  () => ({ ConnectionProviderEntity: class {} }),
);
import { OmniCoreTransactionOutcomeUnknownError } from 'src/modules/omnichannel/services/omni-core-transaction';
import { withOmniMetadataMutation } from 'src/modules/omnichannel/services/omni-metadata-transaction';
import { CreateConnectedAccountService } from 'src/engine/core-modules/auth/services/create-connected-account.service';
import { UpdateConnectedAccountOnReconnectService } from 'src/engine/core-modules/auth/services/update-connected-account-on-reconnect.service';
import { CreateSsoConnectedAccountService } from 'src/engine/core-modules/auth/services/create-sso-connected-account.service';
import { ImapSmtpCalDavApiService } from 'src/modules/connected-account/services/imap-smtp-caldav-apis.service';
import { ConnectionProviderOAuthFlowService } from 'src/engine/core-modules/application/connection-provider/connection-provider-oauth-flow.service';
import { ConnectedAccountRefreshTokensService } from 'src/modules/connected-account/refresh-tokens-manager/services/connected-account-refresh-tokens.service';
import { EmailAliasManagerService } from 'src/modules/connected-account/email-alias-manager/services/email-alias-manager.service';
jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.entity',
  () => ({ UserWorkspaceEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/connected-account/entities/connected-account.entity',
  () => ({ ConnectedAccountEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/connected-account/services/connected-account-token-encryption.service',
  () => ({ ConnectedAccountTokenEncryptionService: class {} }),
);
jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock(
  'src/engine/core-modules/auth/services/create-calendar-channel.service',
  () => ({ CreateCalendarChannelService: class {} }),
);
jest.mock(
  'src/engine/core-modules/auth/services/create-message-channel.service',
  () => ({ CreateMessageChannelService: class {} }),
);
jest.mock(
  'src/engine/core-modules/message-queue/services/message-queue.service',
  () => ({ MessageQueueService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity',
  () => ({ CalendarChannelEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/message-channel/entities/message-channel.entity',
  () => ({ MessageChannelEntity: class {} }),
);
jest.mock(
  'src/modules/calendar/calendar-event-import-manager/jobs/calendar-event-list-fetch.job',
  () => ({ CalendarEventListFetchJob: class {} }),
);
jest.mock(
  'src/modules/calendar/common/services/calendar-channel-sync-status.service',
  () => ({ CalendarChannelSyncStatusService: class {} }),
);
jest.mock(
  'src/modules/connected-account/services/accounts-to-reconnect.service',
  () => ({ AccountsToReconnectService: class {} }),
);
jest.mock(
  'src/modules/messaging/common/services/message-channel-sync-status.service',
  () => ({ MessageChannelSyncStatusService: class {} }),
);
jest.mock(
  'src/modules/messaging/message-folder-manager/services/sync-message-folders.service',
  () => ({ SyncMessageFoldersService: class {} }),
);
jest.mock(
  'src/modules/messaging/message-import-manager/jobs/messaging-message-list-fetch.job',
  () => ({ MessagingMessageListFetchJob: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/connection-provider/app-connection-access.service',
  () => ({ AppConnectionAccessService: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/connection-provider/connection-provider-lifecycle-hook.service',
  () => ({ ConnectionProviderLifecycleHookService: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/connection-provider/connection-provider.service',
  () => ({ ConnectionProviderService: class {} }),
);
jest.mock('src/engine/core-modules/jwt/services/jwt-wrapper.service', () => ({
  JwtWrapperService: class {},
}));
jest.mock(
  'src/engine/core-modules/secure-http-client/secure-http-client.service',
  () => ({ SecureHttpClientService: class {} }),
);
jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({ TwentyConfigService: class {} }),
);
jest.mock('src/engine/core-modules/user/user.entity', () => ({
  UserEntity: class {},
}));
jest.mock(
  'src/engine/core-modules/application/connection-provider/refresh/services/app-oauth-refresh-tokens.service',
  () => ({ AppOAuthRefreshAccessTokenService: class {} }),
);
jest.mock(
  'src/modules/connected-account/refresh-tokens-manager/drivers/google/services/google-api-refresh-tokens.service',
  () => ({ GoogleApiRefreshAccessTokenService: class {} }),
);
jest.mock(
  'src/modules/connected-account/refresh-tokens-manager/drivers/microsoft/services/microsoft-api-refresh-tokens.service',
  () => ({ MicrosoftApiRefreshAccessTokenService: class {} }),
);
jest.mock(
  'src/modules/connected-account/email-alias-manager/drivers/google/services/google-email-alias-manager.service',
  () => ({ GoogleEmailAliasManagerService: class {} }),
);
jest.mock(
  'src/modules/connected-account/email-alias-manager/drivers/microsoft/services/microsoft-email-alias-manager.service',
  () => ({ MicrosoftEmailAliasManagerService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
jest.mock(
  'src/engine/twenty-orm/storage/orm-workspace-context.storage',
  () => ({
    getWorkspaceContext: () => ({
      userWorkspaceRoleMap: {},
      apiKeyRoleMap: {},
      flatRoleTargetByAgentIdMaps: {},
    }),
  }),
);
jest.mock(
  'src/engine/twenty-orm/utils/resolve-role-permission-config.util',
  () => ({ resolveRolePermissionConfig: () => undefined }),
);

const fixture = createOmniNativeMessageFixture();
const scalarColumns = {
  workspaceId: 'uuid',
  archivedAt: 'timestamptz',
  applicationId: 'uuid',
  connectionProviderId: 'uuid',
  provider: 'text',
  scope: 'text',
  userWorkspaceId: 'uuid',
  handle: 'text',
  accessToken: 'text',
  refreshToken: 'text',
  authFailedAt: 'timestamptz',
  authFailedReason: 'text',
  lastCredentialsRefreshedAt: 'timestamptz',
  lastSignedInAt: 'timestamptz',
  externalAccountId: 'text',
  name: 'text',
  connectionParameters: 'jsonb',
  oidcTokenClaims: 'jsonb',
} as const;
const accountSchema = new EntitySchema<ConnectedAccountEntity>({
  name: 'ProviderAccountFixture',
  target: ConnectedAccountEntity,
  schema: 'core',
  tableName: 'connectedAccount',
  columns: {
    id: { type: 'uuid', primary: true, generated: 'uuid' },
    ...Object.fromEntries(
      Object.entries(scalarColumns).map(([key, type]) => [
        key,
        { type, nullable: true },
      ]),
    ),
    scopes: { type: 'text', array: true, nullable: true },
    handleAliases: { type: 'text', array: true, nullable: true },
  },
});
const messageSchema = new EntitySchema<MessageChannelEntity>({
  name: 'ProviderMessageChannel',
  target: MessageChannelEntity,
  schema: 'core',
  tableName: 'messageChannel',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    connectedAccountId: { type: 'uuid' },
    type: { type: 'text' },
    isSyncEnabled: { type: 'boolean' },
    syncStage: { type: 'text', nullable: true },
  },
});
const calendarSchema = new EntitySchema<CalendarChannelEntity>({
  name: 'ProviderCalendarChannel',
  target: CalendarChannelEntity,
  schema: 'core',
  tableName: 'calendarChannel',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    connectedAccountId: { type: 'uuid' },
    isSyncEnabled: { type: 'boolean' },
    syncStage: { type: 'text', nullable: true },
  },
});
const runtime = new DataSource({
  type: 'postgres',
  url: fixture.runtimeDatabaseUrl,
  entities: [accountSchema, messageSchema, calendarSchema],
  synchronize: false,
  migrationsRun: false,
  extra: { max: 4, statement_timeout: 10000 },
});
let accountId: string, memberId: string, userId: string, channelId: string;
const repository = () => runtime.getRepository(ConnectedAccountEntity);
const read = () => repository().findOneByOrFail({ id: accountId });
const encryption = {
  encryptTokenPair: () => ({
    encryptedAccessToken: 'encrypted-new-access',
    encryptedRefreshToken: 'encrypted-new-refresh',
  }),
  encryptConnectionParameters: () => ({ IMAP: { host: 'encrypted-fixture' } }),
  decrypt: () => 'plaintext-fixture-refresh',
};
const workspaceOrm = {
  executeInWorkspaceContext: async (work: () => Promise<unknown>) => work(),
  getRepository: () => ({ findOne: async () => ({ userId }) }),
};
const userWorkspaceRepository = {
  findOne: async () => ({ id: memberId, userId }),
  findOneBy: async () => ({ id: memberId, userId }),
};
const makeService = <T extends object>(prototype: T, dependencies: object): T =>
  Object.assign(Object.create(prototype), dependencies);
const createService = () =>
  makeService(CreateConnectedAccountService.prototype, {
    workspaceOrmManager: workspaceOrm,
    connectedAccountTokenEncryptionService: encryption,
    userWorkspaceRepository,
  });
const reconnectService = () =>
  makeService(UpdateConnectedAccountOnReconnectService.prototype, {
    workspaceOrmManager: workspaceOrm,
    connectedAccountTokenEncryptionService: encryption,
  });
const tokens = {
  accessToken: 'new-plaintext' as never,
  refreshToken: 'new-plaintext-refresh' as never,
};
const create = (
  isReconnect: boolean,
  provider = ConnectedAccountProvider.GOOGLE,
) =>
  withOmniMetadataMutation(
    runtime.manager,
    fixture.workspaceId,
    (transactionManager) =>
      createService().createConnectedAccount({
        workspaceId: fixture.workspaceId,
        connectedAccountId: accountId,
        provider,
        handle: 'ordinary',
        ...tokens,
        accountOwnerId: randomUUID(),
        scopes: ['mail'],
        transactionManager,
        isReconnect,
      }),
  );
const reconnect = (provider = ConnectedAccountProvider.GOOGLE) =>
  withOmniMetadataMutation(
    runtime.manager,
    fixture.workspaceId,
    (transactionManager) =>
      reconnectService().updateConnectedAccountOnReconnect({
        workspaceId: fixture.workspaceId,
        connectedAccountId: accountId,
        userWorkspaceId: memberId,
        provider,
        ...tokens,
        scopes: ['mail'],
        transactionManager,
      }),
  );
const bootstrap = () =>
  bootstrapOmniAccountBinding(
    runtime,
    { kind: 'system', id: 'provider-test' },
    {
      workspaceId: fixture.workspaceId,
      platform: 'telegram',
      connectorInstanceId: 'provider-test',
      accountId,
      connectedAccountId: accountId,
      messageChannelId: channelId,
      idempotencyKey: randomUUID(),
      expectedRevision: '0',
    },
    async () => undefined,
  );
const convertToNative = async () => {
  await fixture.owner.query(
    'UPDATE core."connectedAccount" SET provider=$2,"applicationId"=NULL,"connectionProviderId"=NULL,"archivedAt"=NULL WHERE id=$1',
    [accountId, ConnectedAccountProvider.APP],
  );
  await bootstrap();
};
beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    'ALTER TABLE core."connectedAccount" ' +
      Object.entries(scalarColumns)
        .map(([name, type]) => `ADD "${name}" ${type}`)
        .join(', ') +
      ', ADD scopes text[], ADD "handleAliases" text[]',
  );
  await fixture.owner.query(
    'ALTER TABLE core."connectedAccount" ALTER COLUMN id SET DEFAULT gen_random_uuid()',
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageChannel" ADD "connectedAccountId" uuid REFERENCES core."connectedAccount"(id)',
  );
  await fixture.owner.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO "${fixture.roleName}"`,
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageChannel" ADD "isSyncEnabled" boolean DEFAULT false, ADD "syncStage" text',
  );
  await fixture.owner.query(
    'CREATE TABLE core."calendarChannel" (id uuid PRIMARY KEY,"workspaceId" uuid,"connectedAccountId" uuid REFERENCES core."connectedAccount"(id) ON DELETE CASCADE,"isSyncEnabled" boolean DEFAULT false,"syncStage" text)',
  );
  await fixture.owner.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON core."calendarChannel" TO "${fixture.roleName}"`,
  );
  await runtime.initialize();
});
beforeEach(async () => {
  await fixture.reset();
  await fixture.owner.query(
    'TRUNCATE core.workspace,core."connectedAccount",core."messageChannel" CASCADE',
  );
  await fixture.owner.query('INSERT INTO core.workspace(id) VALUES ($1)', [
    fixture.workspaceId,
  ]);
  accountId = randomUUID();
  memberId = randomUUID();
  userId = randomUUID();
  channelId = randomUUID();
  await repository().insert({
    id: accountId,
    workspaceId: fixture.workspaceId,
    provider: ConnectedAccountProvider.GOOGLE,
    userWorkspaceId: memberId,
    scope: 'USER',
    handle: 'ordinary',
    accessToken: 'encrypted-old' as never,
    refreshToken: 'encrypted-old-refresh' as never,
    scopes: ['old'],
    handleAliases: ['old-alias'],
  });
  await fixture.owner.query(
    'INSERT INTO core."messageChannel" (id,"workspaceId","connectedAccountId",type) VALUES ($1,$2,$3,$4)',
    [channelId, fixture.workspaceId, accountId, 'APP'],
  );
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (runtime.isInitialized) await runtime.destroy();
  await fixture.dispose();
});

describe('ordinary provider writes compare current identity', () => {
  it.each([
    ConnectedAccountProvider.GOOGLE,
    ConnectedAccountProvider.MICROSOFT,
  ])('creates and reconnects ordinary %s without upsert', async (provider) => {
    await fixture.owner.query('DELETE FROM core."messageChannel" WHERE id=$1', [
      channelId,
    ]);
    await repository().delete(accountId);
    await create(false, provider);
    await repository().update(accountId, {
      archivedAt: new Date(),
      authFailedReason: 'old',
    });
    await create(true, provider);
    await reconnect(provider);
    expect(await read()).toMatchObject({
      provider,
      accessToken: 'encrypted-new-access',
      archivedAt: null,
      authFailedReason: null,
    });
  });
  it.each(['create-existing', 'reconnect', 'insert-collision'])(
    '%s cannot overwrite a bootstrap-owned native APP',
    async (method) => {
      await convertToNative();
      await expect(
        method === 'reconnect'
          ? reconnect()
          : create(method === 'create-existing'),
      ).rejects.toThrow();
      expect(await read()).toMatchObject({
        provider: ConnectedAccountProvider.APP,
        accessToken: 'encrypted-old',
        scopes: ['old'],
      });
      expect(
        await runtime.query('SELECT id FROM core."omniAccountBinding"'),
      ).toHaveLength(1);
    },
  );
  it.each([
    'provider',
    'userWorkspaceId',
    'applicationId',
    'connectionProviderId',
    'workspaceId',
    'deleted',
  ])('stale reconnect refuses changed %s', async (field) => {
    if (field === 'deleted') {
      await fixture.owner.query(
        'DELETE FROM core."messageChannel" WHERE id=$1',
        [channelId],
      );
      await repository().delete(accountId);
    } else
      await repository().update(accountId, {
        [field]:
          field === 'provider'
            ? ConnectedAccountProvider.MICROSOFT
            : randomUUID(),
      });
    await expect(create(true)).rejects.toThrow('CONNECTED_ACCOUNT_CHANGED');
    await expect(reconnect()).rejects.toThrow('CONNECTED_ACCOUNT_CHANGED');
  });
  it('rejects incomplete identity rather than silently dropping SQL predicates', async () => {
    const identity = await read();
    for (const field of [
      'id',
      'workspaceId',
      'userWorkspaceId',
      'provider',
      'applicationId',
      'connectionProviderId',
    ]) {
      expect(() =>
        ordinaryConnectedAccountWriteWhere({ ...identity, [field]: undefined }),
      ).toThrow('IDENTITY_REQUIRED');
    }
  });
});

describe('actual provider response owners', () => {
  it.each([false, true])(
    'SSO update with concurrent native conversion=%s',
    async (stale) => {
      await repository().update(accountId, {
        provider: ConnectedAccountProvider.OIDC,
      });
      const repo = repository(),
        find = repo.findOneBy.bind(repo);
      jest.spyOn(repo, 'findOneBy').mockImplementationOnce(async (where) => {
        const found = await find(where);
        if (stale) await convertToNative();
        return found;
      });
      const service = makeService(CreateSsoConnectedAccountService.prototype, {
        connectedAccountRepository: repo,
        userWorkspaceRepository,
      });
      const work = service.createOrUpdateSsoConnectedAccount({
        workspaceId: fixture.workspaceId,
        userId,
        handle: 'ordinary',
        provider: ConnectedAccountProvider.OIDC,
        scopes: ['new-sso'],
      });
      if (stale) {
        await expect(work).rejects.toThrow('CONNECTED_ACCOUNT_CHANGED');
        expect((await read()).provider).toBe(ConnectedAccountProvider.APP);
      } else {
        await work;
        expect((await read()).scopes).toEqual(['old', 'new-sso']);
      }
    },
  );
  it.each([false, true])('IMAP stale provided snapshot=%s', async (stale) => {
    await repository().update(accountId, {
      provider: ConnectedAccountProvider.IMAP_SMTP_CALDAV,
    });
    const snapshot = await read();
    if (stale) await convertToNative();
    const sideEffect = jest.fn();
    const service = makeService(ImapSmtpCalDavApiService.prototype, {
      connectedAccountRepository: repository(),
      userWorkspaceRepository,
      messageChannelRepository: { findOne: async () => ({ id: channelId }) },
      calendarChannelRepository: { findOne: async () => null },
      connectedAccountTokenEncryptionService: encryption,
      accountsToReconnectService: { removeAccountToReconnect: sideEffect },
      createMessageChannelService: { createMessageChannel: sideEffect },
      createCalendarChannelService: { createCalendarChannel: sideEffect },
    });
    const work = service.upsertConnectedAccount({
      workspaceId: fixture.workspaceId,
      userWorkspaceId: memberId,
      handle: 'ordinary',
      existingAccount: snapshot,
      connectionParameters: {} as never,
    });
    if (stale) {
      await expect(work).rejects.toThrow('CONNECTED_ACCOUNT_CHANGED');
      expect(sideEffect).not.toHaveBeenCalled();
      expect((await read()).connectionParameters).toBeNull();
    } else {
      await expect(work).resolves.toBe(accountId);
      expect(sideEffect).toHaveBeenCalledTimes(1);
      expect((await read()).connectionParameters).not.toBeNull();
    }
  });
  it.each([
    ConnectedAccountProvider.GOOGLE,
    ConnectedAccountProvider.MICROSOFT,
  ])('refresh %s refuses response after bootstrap wins', async (provider) => {
    await repository().update(accountId, { provider });
    const snapshot = await read();
    const driver = {
      refreshTokens: async () => {
        await convertToNative();
        return tokens;
      },
    };
    const service = makeService(
      ConnectedAccountRefreshTokensService.prototype,
      {
        connectedAccountRepository: repository(),
        connectedAccountTokenEncryptionService: encryption,
        googleApiRefreshAccessTokenService: driver,
        microsoftApiRefreshAccessTokenService: driver,
        logger: { debug: () => undefined, log: () => undefined },
      },
    );
    await expect(
      service.resolveTokens(snapshot, fixture.workspaceId),
    ).rejects.toThrow('CONNECTED_ACCOUNT_CHANGED');
    expect((await read()).accessToken).toBe('encrypted-old');
  });
  it('refresh ordinary account succeeds and returns persisted encrypted tokens', async () => {
    const service = makeService(
      ConnectedAccountRefreshTokensService.prototype,
      {
        connectedAccountRepository: repository(),
        connectedAccountTokenEncryptionService: encryption,
        googleApiRefreshAccessTokenService: {
          refreshTokens: async () => tokens,
        },
        logger: { debug: () => undefined },
      },
    );
    expect(
      await service.resolveTokens(await read(), fixture.workspaceId),
    ).toMatchObject({ accessToken: 'encrypted-new-access' });
    expect((await read()).accessToken).toBe('encrypted-new-access');
  });
  it('native APP never enters refresh or alias external drivers', async () => {
    await convertToNative();
    const snapshot = await read();
    const driver = jest.fn();
    const refresh = makeService(
      ConnectedAccountRefreshTokensService.prototype,
      { appOAuthRefreshAccessTokenService: { refreshTokens: driver } },
    );
    await expect(
      refresh.resolveTokens(snapshot, fixture.workspaceId),
    ).rejects.toThrow('IDENTITY_REQUIRED');
    const aliases = makeService(EmailAliasManagerService.prototype, {
      messageChannelRepository: { exists: driver },
      connectedAccountRepository: { update: driver },
    });
    await expect(
      aliases.refreshHandleAliases(snapshot, fixture.workspaceId),
    ).resolves.toEqual(['old-alias']);
    expect(driver).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'alias refresh with concurrent native conversion=%s',
    async (stale) => {
      const snapshot = await read();
      const service = makeService(EmailAliasManagerService.prototype, {
        connectedAccountRepository: repository(),
        workspaceOrmManager: workspaceOrm,
        messageChannelRepository: { exists: async () => true },
        googleEmailAliasManagerService: {
          getHandleAliases: async () => {
            if (stale) await convertToNative();
            return ['new-alias'];
          },
        },
      });
      const work = service.refreshHandleAliases(snapshot, fixture.workspaceId);
      if (stale) {
        await expect(work).rejects.toThrow('CONNECTED_ACCOUNT_CHANGED');
        expect((await read()).handleAliases).toEqual(['old-alias']);
      } else {
        await expect(work).resolves.toEqual(['new-alias']);
        expect((await read()).handleAliases).toEqual(['new-alias']);
      }
    },
  );
});

describe('app OAuth reconnect persistence', () => {
  const persist = async (
    options: {
      shared?: boolean;
      mutate?: string;
      identified?: boolean;
      mismatch?: boolean;
    } = {},
  ) => {
    const applicationId = randomUUID(),
      connectionProviderId = randomUUID();
    await repository().update(accountId, {
      provider: ConnectedAccountProvider.APP,
      applicationId,
      connectionProviderId,
      scope: options.shared ? 'WORKSPACE' : 'USER',
      externalAccountId: options.mismatch ? 'different-external' : null,
    });
    const originalMember = memberId;
    if (options.shared) memberId = randomUUID();
    if (options.mutate === 'native') await convertToNative();
    if (options.mutate === 'provider')
      await repository().update(accountId, {
        provider: ConnectedAccountProvider.GOOGLE,
      });
    if (options.mutate === 'applicationId')
      await repository().update(accountId, { applicationId: randomUUID() });
    if (options.mutate === 'connectionProviderId')
      await repository().update(accountId, {
        connectionProviderId: randomUUID(),
      });
    if (options.mutate === 'custodian')
      await repository().update(accountId, { userWorkspaceId: randomUUID() });
    if (options.mutate === 'shared-to-private')
      await repository().update(accountId, {
        scope: 'USER',
        userWorkspaceId: originalMember,
      });
    const service = makeService(ConnectionProviderOAuthFlowService.prototype, {
      connectedAccountRepository: repository(),
      connectedAccountTokenEncryptionService: encryption,
      userRepository: { findOneBy: async () => ({ email: 'ordinary' }) },
    });
    return service['persistConnectedAccount']({
      provider: {
        id: connectionProviderId,
        applicationId,
        oauthConfig: { scopes: ['app'] },
      } as never,
      tokenResponse: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      } as never,
      identifiedAccount: options.identified
        ? { externalAccountId: 'external', handle: 'app-account' }
        : null,
      workspaceId: fixture.workspaceId,
      userId,
      userWorkspaceId: memberId,
      scope: options.shared ? 'WORKSPACE' : 'USER',
      reconnectingConnectedAccountId: accountId,
    });
  };
  it.each([false, true])(
    'preserves ordinary app reconnect identified=%s',
    async (identified) => {
      await expect(persist({ identified })).resolves.toMatchObject({
        accessToken: 'encrypted-new-access',
      });
    },
  );
  it('allows authorized shared-account reconnect by another custodian', async () => {
    await expect(persist({ shared: true })).resolves.toMatchObject({
      scope: 'WORKSPACE',
      accessToken: 'encrypted-new-access',
    });
    expect((await read()).userWorkspaceId).toBe(memberId);
  });
  it.each([
    'native',
    'provider',
    'applicationId',
    'connectionProviderId',
    'custodian',
    'shared-to-private',
  ])('refuses changed %s even without identify hook', async (mutate) => {
    await expect(
      persist({ mutate, shared: mutate === 'shared-to-private' }),
    ).rejects.toThrow();
    expect((await read()).accessToken).toBe('encrypted-old');
  });
  it('retains external account pinning', async () => {
    await expect(persist({ identified: true, mismatch: true })).rejects.toThrow(
      'Reconnect with',
    );
    expect((await read()).accessToken).toBe('encrypted-old');
  });
});

describe('full Google/Microsoft reconnect callers', () => {
  it.each([
    [ConnectedAccountProvider.GOOGLE, false, 'none'],
    [ConnectedAccountProvider.MICROSOFT, false, 'none'],
    [ConnectedAccountProvider.GOOGLE, true, 'none'],
    [ConnectedAccountProvider.MICROSOFT, true, 'none'],
    [ConnectedAccountProvider.GOOGLE, false, 'unknown'],
    [ConnectedAccountProvider.MICROSOFT, false, 'unknown'],
    [ConnectedAccountProvider.GOOGLE, false, 'rollback'],
    [ConnectedAccountProvider.MICROSOFT, false, 'rollback'],
  ] as const)(
    'reconnect %s existing mailbox/calendar stale=%s failure=%s',
    async (provider, stale, failure) => {
      await repository().update(accountId, {
        provider,
        archivedAt: new Date(),
      });
      await runtime.getRepository(MessageChannelEntity).update(channelId, {
        syncStage: MessageChannelSyncStage.PENDING_CONFIGURATION,
      });
      const calendarId = randomUUID();
      await runtime.getRepository(CalendarChannelEntity).insert({
        id: calendarId,
        workspaceId: fixture.workspaceId,
        connectedAccountId: accountId,
        isSyncEnabled: false,
        syncStage: CalendarChannelSyncStage.PENDING_CONFIGURATION,
      });
      const repo = repository(),
        find = repo.findOne.bind(repo);
      jest.spyOn(repo, 'findOne').mockImplementationOnce(async (where) => {
        const found = await find(where);
        if (stale) await convertToNative();
        return found;
      });
      const sideEffect = jest.fn().mockResolvedValue(undefined);
      const resetMessages = jest.fn(async () => {
        expect((await read()).archivedAt).toBeNull();
        expect(
          (
            await runtime
              .getRepository(MessageChannelEntity)
              .findOneByOrFail({ id: channelId })
          ).isSyncEnabled,
        ).toBe(true);
      });
      const resetCalendar = jest.fn(async () => {
        expect((await read()).archivedAt).toBeNull();
        expect(
          (
            await runtime
              .getRepository(CalendarChannelEntity)
              .findOneByOrFail({ id: calendarId })
          ).isSyncEnabled,
        ).toBe(true);
      });
      const dependencies = {
        workspaceOrmManager: workspaceOrm,
        userWorkspaceRepository,
        connectedAccountRepository: repo,
        messageChannelRepository: runtime.getRepository(MessageChannelEntity),
        calendarChannelRepository: runtime.getRepository(CalendarChannelEntity),
        createConnectedAccountService: createService(),
        updateConnectedAccountOnReconnectService: reconnectService(),
        twentyConfigService: { get: () => true },
        googleApiScopesService: {
          getScopesFromGoogleAccessTokenAndCheckIfExpectedScopesArePresent:
            async () => ({ scopes: ['mail'], isValid: true }),
        },
        googleApisServiceAvailabilityService: {
          checkServicesAvailability: async () => ({
            isMessagingAvailable: true,
            isCalendarAvailable: true,
          }),
        },
        accountsToReconnectService: { removeAccountToReconnect: sideEffect },
        messagingChannelSyncStatusService: {
          resetAndMarkAsMessagesListFetchPending: resetMessages,
        },
        calendarChannelSyncStatusService: {
          resetAndMarkAsCalendarEventListFetchPending: resetCalendar,
        },
        emailAliasManagerService: { refreshHandleAliases: sideEffect },
        messageQueueService: { add: sideEffect },
        calendarQueueService: { add: sideEffect },
        webhookQueueService: { add: sideEffect },
        onboardingRecentMessagesImportService: {
          importRecentMessages: sideEffect,
        },
      };
      const input = {
        handle: 'ordinary',
        userId,
        workspaceMemberId: randomUUID(),
        workspaceId: fixture.workspaceId,
        ...tokens,
        calendarVisibility: undefined,
        messageVisibility: undefined,
      };
      if (failure !== 'none') {
        const original = runtime.createQueryRunner.bind(runtime);
        jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
          const runner = original(),
            query = runner.query.bind(runner),
            commit = runner.commitTransaction.bind(runner);
          let written = false;
          runner.query = async (...args: Parameters<typeof runner.query>) => {
            if (args[0].startsWith('UPDATE')) {
              written = true;
              if (
                failure === 'rollback' &&
                args[0].includes('"calendarChannel"')
              )
                throw new Error('fixture calendar restore failed');
            }
            return query(...args);
          };
          runner.commitTransaction = async () => {
            await commit();
            if (written && failure === 'unknown')
              throw new Error('outer provider ACK lost');
          };
          return runner;
        });
      }
      const work =
        provider === ConnectedAccountProvider.GOOGLE
          ? makeService(
              GoogleAPIsService.prototype,
              dependencies,
            ).refreshGoogleRefreshToken(input)
          : makeService(
              MicrosoftAPIsService.prototype,
              dependencies,
            ).refreshMicrosoftRefreshToken(input);
      if (failure !== 'none') {
        if (failure === 'unknown')
          await expect(work).rejects.toBeInstanceOf(
            OmniCoreTransactionOutcomeUnknownError,
          );
        else {
          await expect(work).rejects.toThrow('fixture calendar restore failed');
          expect((await read()).accessToken).toBe('encrypted-old');
        }
        expect(sideEffect).not.toHaveBeenCalled();
        expect(resetMessages).not.toHaveBeenCalled();
        expect(resetCalendar).not.toHaveBeenCalled();
      } else if (stale) {
        await expect(work).rejects.toThrow('CONNECTED_ACCOUNT_CHANGED');
        expect(sideEffect).not.toHaveBeenCalled();
        expect(resetMessages).not.toHaveBeenCalled();
        expect(resetCalendar).not.toHaveBeenCalled();
      } else {
        await expect(work).resolves.toBe(accountId);
        if (provider === ConnectedAccountProvider.MICROSOFT) {
          expect(resetMessages).toHaveBeenCalledWith(
            [channelId],
            fixture.workspaceId,
          );
          expect(resetCalendar).toHaveBeenCalledWith(
            [calendarId],
            fixture.workspaceId,
          );
        }
        expect((await read()).archivedAt).toBeNull();
      }
      expect(
        (
          await runtime
            .getRepository(MessageChannelEntity)
            .findOneByOrFail({ id: channelId })
        ).isSyncEnabled,
      ).toBe(!stale && failure !== 'rollback');
      expect(
        (
          await runtime
            .getRepository(CalendarChannelEntity)
            .findOneByOrFail({ id: calendarId })
        ).isSyncEnabled,
      ).toBe(!stale && failure !== 'rollback');
    },
  );
});

it.each([false, true])(
  'IMAP initial folder sync preserves unknown commit=%s',
  async (unknown) => {
    await repository().update(accountId, {
      provider: ConnectedAccountProvider.IMAP_SMTP_CALDAV,
    });
    const failure = unknown
      ? new OmniCoreTransactionOutcomeUnknownError(new Error('ACK lost'))
      : new Error('ordinary discovery failure');
    const warn = jest.fn();
    const service = makeService(ImapSmtpCalDavApiService.prototype, {
      connectedAccountRepository: repository(),
      userWorkspaceRepository,
      messageChannelRepository: {
        findOne: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue({ id: channelId }),
      },
      calendarChannelRepository: { findOne: async () => null },
      connectedAccountTokenEncryptionService: encryption,
      accountsToReconnectService: { removeAccountToReconnect: jest.fn() },
      createMessageChannelService: { createMessageChannel: jest.fn() },
      syncMessageFoldersService: {
        syncMessageFolders: async () => {
          throw failure;
        },
      },
      logger: { warn },
    });
    const work = service.upsertConnectedAccount({
      workspaceId: fixture.workspaceId,
      userWorkspaceId: memberId,
      handle: 'ordinary',
      existingAccount: await read(),
      connectionParameters: { IMAP: {} } as never,
    });
    if (unknown) {
      await expect(work).rejects.toBe(failure);
      expect(warn).not.toHaveBeenCalled();
    } else {
      await expect(work).resolves.toBe(accountId);
      expect(warn).toHaveBeenCalledTimes(1);
    }
  },
);
const prepareProviderWriter = async (kind: string) => {
  if (kind === 'create') return () => create(true);
  if (kind === 'reconnect') return () => reconnect();
  if (kind === 'sso') {
    await repository().update(accountId, {
      provider: ConnectedAccountProvider.OIDC,
    });
    const service = makeService(CreateSsoConnectedAccountService.prototype, {
      connectedAccountRepository: repository(),
      userWorkspaceRepository,
    });
    return () =>
      service.createOrUpdateSsoConnectedAccount({
        workspaceId: fixture.workspaceId,
        userId,
        handle: 'ordinary',
        provider: ConnectedAccountProvider.OIDC,
        scopes: ['new'],
      });
  }
  if (kind === 'imap') {
    await repository().update(accountId, {
      provider: ConnectedAccountProvider.IMAP_SMTP_CALDAV,
    });
    const snapshot = await read();
    const service = makeService(ImapSmtpCalDavApiService.prototype, {
      connectedAccountRepository: repository(),
      userWorkspaceRepository,
      messageChannelRepository: { findOne: async () => ({ id: channelId }) },
      calendarChannelRepository: { findOne: async () => null },
      connectedAccountTokenEncryptionService: encryption,
      accountsToReconnectService: { removeAccountToReconnect: jest.fn() },
    });
    return () =>
      service.upsertConnectedAccount({
        workspaceId: fixture.workspaceId,
        userWorkspaceId: memberId,
        handle: 'ordinary',
        existingAccount: snapshot,
        connectionParameters: {} as never,
      });
  }
  if (kind === 'refresh') {
    const snapshot = await read();
    const service = makeService(
      ConnectedAccountRefreshTokensService.prototype,
      {
        connectedAccountRepository: repository(),
        connectedAccountTokenEncryptionService: encryption,
        googleApiRefreshAccessTokenService: {
          refreshTokens: async () => tokens,
        },
        logger: { debug: jest.fn() },
      },
    );
    return () => service.resolveTokens(snapshot, fixture.workspaceId);
  }
  if (kind === 'alias') {
    const snapshot = await read();
    const service = makeService(EmailAliasManagerService.prototype, {
      connectedAccountRepository: repository(),
      workspaceOrmManager: workspaceOrm,
      messageChannelRepository: { exists: async () => true },
      googleEmailAliasManagerService: {
        getHandleAliases: async () => ['new-alias'],
      },
    });
    return () => service.refreshHandleAliases(snapshot, fixture.workspaceId);
  }
  if (kind === 'app') {
    const applicationId = randomUUID(),
      providerId = randomUUID();
    await repository().update(accountId, {
      provider: ConnectedAccountProvider.APP,
      applicationId,
      connectionProviderId: providerId,
    });
    const service = makeService(ConnectionProviderOAuthFlowService.prototype, {
      connectedAccountRepository: repository(),
      connectedAccountTokenEncryptionService: encryption,
      userRepository: { findOneBy: async () => ({ email: 'ordinary' }) },
    });
    return () =>
      service['persistConnectedAccount']({
        provider: {
          id: providerId,
          applicationId,
          oauthConfig: { scopes: ['app'] },
        } as never,
        tokenResponse: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        } as never,
        identifiedAccount: null,
        workspaceId: fixture.workspaceId,
        userId,
        userWorkspaceId: memberId,
        scope: 'USER',
        reconnectingConnectedAccountId: accountId,
      });
  }
  throw new Error('Unknown fixture writer');
};
const introduceDerivedOwnership = async (kind: string) => {
  const boundAccount = randomUUID(),
    boundChannel = randomUUID();
  await repository().insert({
    id: boundAccount,
    workspaceId: fixture.workspaceId,
    provider: ConnectedAccountProvider.APP,
    userWorkspaceId: memberId,
    scope: 'USER',
    handle: 'native',
  });
  await runtime.getRepository(MessageChannelEntity).insert({
    id: boundChannel,
    workspaceId: fixture.workspaceId,
    connectedAccountId: boundAccount,
    type: MessageChannelType.APP,
    isSyncEnabled: false,
  });
  const binding = await bootstrapOmniAccountBinding(
    runtime,
    { kind: 'system', id: 'derived-test' },
    {
      workspaceId: fixture.workspaceId,
      platform: 'telegram',
      connectorInstanceId: 'derived-test',
      accountId: randomUUID(),
      connectedAccountId: boundAccount,
      messageChannelId: boundChannel,
      idempotencyKey: randomUUID(),
      expectedRevision: '0',
    },
    async () => undefined,
  );
  const thread = randomUUID(),
    message = randomUUID(),
    association = randomUUID();
  await fixture.owner.query(
    `INSERT INTO "${fixture.schemaName}"."messageThread"(id) VALUES ($1)`,
    [thread],
  );
  await fixture.owner.query(
    `INSERT INTO "${fixture.schemaName}"."message"(id,"messageThreadId") VALUES ($1,$2)`,
    [message, thread],
  );
  await fixture.owner.query(
    `INSERT INTO "${fixture.schemaName}"."messageChannelMessageAssociation"(id,"messageId","messageChannelId","messageExternalId","deletedAt") VALUES ($1,$2,$3,'derived',$4)`,
    [
      association,
      message,
      channelId,
      kind === 'soft-deleted' ? new Date() : null,
    ],
  );
  if (kind === 'bound') {
    await fixture.owner.query(
      `INSERT INTO "${fixture.schemaName}"."messageChannelMessageAssociation"(id,"messageId","messageChannelId","messageExternalId","deletedAt") VALUES ($1,$2,$3,'bound',$4)`,
      [randomUUID(), message, boundChannel, new Date()],
    );
    return;
  }
  const conversation = randomUUID(),
    conversationThread = kind === 'conversation' ? thread : randomUUID();
  if (conversationThread !== thread)
    await fixture.owner.query(
      `INSERT INTO "${fixture.schemaName}"."messageThread"(id) VALUES ($1)`,
      [conversationThread],
    );
  await fixture.owner.query(
    'INSERT INTO core."omniConversation"(id,"workspaceId","bindingId","providerChatId","messageThreadId","policyId","policyVersion") VALUES ($1,$2,$3,$4,$5,$6,\'0\')',
    [
      conversation,
      fixture.workspaceId,
      binding.bindingId,
      randomUUID(),
      conversationThread,
      binding.policyId,
    ],
  );
  if (kind !== 'conversation')
    await fixture.owner.query(
      'INSERT INTO core."omniMessageLink"(id,"workspaceId","bindingId","conversationId","messageId","rawNativeMessageId","nativeMessageKey","nativeMessageKeyVersion","displayOccurredAt","displayTimeSource","immutableAuthorSnapshot","senderProvenance","correlationState") VALUES ($1,$2,$3,$4,$5,$6,$7,1,now(),\'source\',\'{}\',\'fixture\',\'unresolved\')',
      [
        randomUUID(),
        fixture.workspaceId,
        binding.bindingId,
        conversation,
        message,
        randomUUID(),
        randomUUID(),
      ],
    );
};
describe('full derived ownership at actual provider writes', () => {
  it.each(
    ['create', 'reconnect', 'sso', 'imap', 'refresh', 'alias', 'app'].flatMap(
      (writer) =>
        ['link', 'conversation', 'bound', 'soft-deleted'].map((marker) => [
          writer,
          marker,
        ]),
    ),
  )('%s refuses %s ownership', async (writer, marker) => {
    const write = await prepareProviderWriter(writer);
    await introduceDerivedOwnership(marker);
    const before = await read();
    await expect(write()).rejects.toThrow();
    expect(await read()).toEqual(before);
  });
  it.each(['create', 'reconnect', 'sso', 'imap', 'refresh', 'alias', 'app'])(
    '%s propagates lost commit acknowledgement',
    async (kind) => {
      const write = await prepareProviderWriter(kind),
        original = runtime.createQueryRunner.bind(runtime);
      jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
        const runner = original(),
          commit = runner.commitTransaction.bind(runner),
          query = runner.query.bind(runner);
        let written = false;
        runner.query = async (...args: Parameters<typeof runner.query>) => {
          if (args[0].startsWith('UPDATE')) written = true;
          return query(...args);
        };
        runner.commitTransaction = async () => {
          await commit();
          if (written) throw new Error('provider commit ACK lost');
        };
        return runner;
      });
      await expect(write()).rejects.toBeInstanceOf(
        OmniCoreTransactionOutcomeUnknownError,
      );
    },
  );
  it('captures refresh identity before provider can mutate the caller object', async () => {
    const snapshot = await read(),
      service = makeService(ConnectedAccountRefreshTokensService.prototype, {
        connectedAccountRepository: repository(),
        connectedAccountTokenEncryptionService: encryption,
        googleApiRefreshAccessTokenService: {
          refreshTokens: async () => {
            snapshot.id = randomUUID();
            snapshot.userWorkspaceId = randomUUID();
            return tokens;
          },
        },
        logger: { debug: jest.fn() },
      });
    await expect(
      service.resolveTokens(snapshot, fixture.workspaceId),
    ).resolves.toMatchObject({ accessToken: 'encrypted-new-access' });
    expect((await read()).accessToken).toBe('encrypted-new-access');
  });
  it('waits for exclusive enrollment before deciding a refresh write', async () => {
    const write = await prepareProviderWriter('refresh'),
      runner = fixture.owner.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let pending: Promise<unknown> | undefined;
    try {
      await runner.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        ['twenty:omni-native:' + fixture.workspaceId],
      );
      pending = write();
      let waiting = false;
      for (let n = 0; n < 100; n++) {
        const rows = await fixture.owner.query(
          "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event='advisory'",
          [fixture.roleName],
        );
        if (rows.length) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await runner.query(
        'UPDATE core."connectedAccount" SET provider=\'app\' WHERE id=$1',
        [accountId],
      );
      await runner.commitTransaction();
      await expect(pending).rejects.toThrow('CONNECTED_ACCOUNT_CHANGED');
      expect((await read()).accessToken).toBe('encrypted-old');
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
      if (pending) await pending.catch(() => undefined);
    }
  });
});
describe('retained bindings from pre-invariant snapshots', () => {
  it('archived IMAP reconnect cannot re-enable reparented message/calendar channels', async () => {
    await repository().update(accountId, {
      provider: ConnectedAccountProvider.IMAP_SMTP_CALDAV,
      archivedAt: new Date(),
    });
    await runtime.getRepository(MessageChannelEntity).update(channelId, {
      syncStage: MessageChannelSyncStage.PENDING_CONFIGURATION,
    });
    const calendarId = randomUUID(),
      otherAccount = randomUUID();
    await repository().insert({
      id: otherAccount,
      workspaceId: fixture.workspaceId,
      provider: ConnectedAccountProvider.APP,
      userWorkspaceId: memberId,
      handle: 'native',
    });
    await runtime.getRepository(CalendarChannelEntity).insert({
      id: calendarId,
      workspaceId: fixture.workspaceId,
      connectedAccountId: accountId,
      isSyncEnabled: false,
      syncStage: CalendarChannelSyncStage.PENDING_CONFIGURATION,
    });
    const calendarRepository = runtime.getRepository(CalendarChannelEntity),
      find = calendarRepository.findOne.bind(calendarRepository);
    jest
      .spyOn(calendarRepository, 'findOne')
      .mockImplementationOnce(async (options) => {
        const old = await find(options);
        await runtime
          .getRepository(MessageChannelEntity)
          .update(channelId, { connectedAccountId: otherAccount });
        await calendarRepository.update(calendarId, {
          connectedAccountId: otherAccount,
        });
        return old;
      });
    const service = makeService(ImapSmtpCalDavApiService.prototype, {
      connectedAccountRepository: repository(),
      userWorkspaceRepository,
      messageChannelRepository: runtime.getRepository(MessageChannelEntity),
      calendarChannelRepository: calendarRepository,
      connectedAccountTokenEncryptionService: encryption,
      accountsToReconnectService: { removeAccountToReconnect: jest.fn() },
    });
    await service.upsertConnectedAccount({
      workspaceId: fixture.workspaceId,
      userWorkspaceId: memberId,
      handle: 'ordinary',
      existingAccount: await read(),
      connectionParameters: { IMAP: {}, CALDAV: {} } as never,
    });
    expect(
      await runtime
        .getRepository(MessageChannelEntity)
        .findOneByOrFail({ id: channelId }),
    ).toMatchObject({ connectedAccountId: otherAccount, isSyncEnabled: false });
    expect(
      await calendarRepository.findOneByOrFail({ id: calendarId }),
    ).toMatchObject({ connectedAccountId: otherAccount, isSyncEnabled: false });
  });
  it('SSO scope merge includes changes committed after initial discovery', async () => {
    await repository().update(accountId, {
      provider: ConnectedAccountProvider.OIDC,
    });
    const repo = repository(),
      find = repo.findOneBy.bind(repo);
    jest.spyOn(repo, 'findOneBy').mockImplementationOnce(async (where) => {
      const before = await find(where);
      await repo.update(accountId, { scopes: ['old', 'concurrent'] });
      return before;
    });
    const service = makeService(CreateSsoConnectedAccountService.prototype, {
      connectedAccountRepository: repo,
      userWorkspaceRepository,
    });
    await service.createOrUpdateSsoConnectedAccount({
      workspaceId: fixture.workspaceId,
      userId,
      handle: 'ordinary',
      provider: ConnectedAccountProvider.OIDC,
      scopes: ['added'],
    });
    expect((await read()).scopes).toEqual(['old', 'concurrent', 'added']);
  });
  it('application connection mapping propagates unknown refresh commit', async () => {
    const error = new OmniCoreTransactionOutcomeUnknownError(
        new Error('ACK lost'),
      ),
      providerId = randomUUID(),
      warn = jest.fn();
    const service = makeService(ApplicationConnectionsListService.prototype, {
      refreshTokensService: {
        resolveTokens: async () => {
          throw error;
        },
      },
      logger: { warn },
    });
    await expect(
      service['refreshAndMap'](
        { ...(await read()), connectionProviderId: providerId },
        fixture.workspaceId,
        new Map([[providerId, { id: providerId } as never]]),
        null,
      ),
    ).rejects.toBe(error);
    expect(warn).not.toHaveBeenCalled();
  });
  it('shared provider owner holds off exclusive enrollment until commit', async () => {
    const write = await prepareProviderWriter('refresh'),
      original = runtime.createQueryRunner.bind(runtime);
    let entered!: () => void, release!: () => void;
    const atWrite = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
      const runner = original(),
        query = runner.query.bind(runner);
      runner.query = async (...args: Parameters<typeof runner.query>) => {
        const result = await query(...args);
        if (args[0].startsWith('UPDATE')) {
          entered();
          await gate;
        }
        return result;
      };
      return runner;
    });
    const pending = write();
    await atWrite;
    const exclusiveRunner = fixture.owner.createQueryRunner();
    await exclusiveRunner.connect();
    await exclusiveRunner.startTransaction();
    let exclusive: Promise<unknown> | undefined;
    try {
      const [{ pid }] = await exclusiveRunner.query(
        'SELECT pg_backend_pid() AS pid',
      );
      exclusive = exclusiveRunner.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        ['twenty:omni-native:' + fixture.workspaceId],
      );
      let waiting = false;
      for (let n = 0; n < 100; n++) {
        const rows = await fixture.owner.query(
          "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='advisory'",
          [pid],
        );
        if (rows.length) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      release();
      await pending;
      await exclusive;
      await exclusiveRunner.commitTransaction();
      expect((await read()).accessToken).toBe('encrypted-new-access');
    } finally {
      release();
      await pending.catch(() => undefined);
      if (exclusive) await exclusive.catch(() => undefined);
      if (exclusiveRunner.isTransactionActive)
        await exclusiveRunner.rollbackTransaction();
      await exclusiveRunner.release();
    }
  });
  it.each([
    ConnectedAccountProvider.GOOGLE,
    ConnectedAccountProvider.MICROSOFT,
  ])('protects an older %s binding without rewriting it', async (provider) => {
    await convertToNative();
    // Restore the previously permitted provider identity, retaining the binding.
    await fixture.owner.query(
      'UPDATE core."connectedAccount" SET provider=$2 WHERE id=$1',
      [accountId, provider],
    );
    await expect(create(true, provider)).rejects.toThrow(
      'CONNECTED_ACCOUNT_CHANGED',
    );
    await expect(reconnect(provider)).rejects.toThrow(
      'CONNECTED_ACCOUNT_CHANGED',
    );
    const service = makeService(
      ConnectedAccountRefreshTokensService.prototype,
      {
        connectedAccountRepository: repository(),
        connectedAccountTokenEncryptionService: encryption,
        googleApiRefreshAccessTokenService: {
          refreshTokens: async () => tokens,
        },
        microsoftApiRefreshAccessTokenService: {
          refreshTokens: async () => tokens,
        },
        logger: { debug: () => undefined },
      },
    );
    await expect(
      service.resolveTokens(await read(), fixture.workspaceId),
    ).rejects.toThrow('CONNECTED_ACCOUNT_CHANGED');
    expect((await read()).accessToken).toBe('encrypted-old');
  });
  it('fails closed when retained-binding storage cannot be read', async () => {
    await fixture.owner.query(
      `REVOKE SELECT ON core."omniAccountBinding" FROM "${fixture.roleName}"`,
    );
    try {
      await expect(reconnect()).rejects.toThrow('permission denied');
      expect((await read()).accessToken).toBe('encrypted-old');
    } finally {
      await fixture.owner.query(
        `GRANT SELECT ON core."omniAccountBinding" TO "${fixture.roleName}"`,
      );
    }
  });
});
