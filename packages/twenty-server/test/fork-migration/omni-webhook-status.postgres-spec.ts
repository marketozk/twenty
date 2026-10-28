import { OmniCoreTransactionOutcomeUnknownError } from 'src/modules/omnichannel/services/omni-core-transaction';
import { webhookSubscriptionSnapshot } from 'src/modules/connected-account/webhook-subscription-manager/utils/webhook-subscription-snapshot';
import { type WebhookSubscriptionSnapshot } from 'src/modules/connected-account/webhook-subscription-manager/types/webhook-subscription-driver.type';
import { MicrosoftMessagingNotificationHandler } from 'src/modules/connected-account-sync-webhooks/drivers/microsoft/microsoft-messaging-notification.handler';
import { MicrosoftCalendarNotificationHandler } from 'src/modules/connected-account-sync-webhooks/drivers/microsoft/microsoft-calendar-notification.handler';
jest.mock(
  'src/modules/connected-account/webhook-subscription-manager/services/webhook-sync-trigger.service',
  () => ({ WebhookSyncTriggerService: class {} }),
);
jest.mock(
  'src/engine/core-modules/exception-handler/exception-handler.service',
  () => ({ ExceptionHandlerService: class {} }),
);
import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema, type QueryRunner } from 'typeorm';
import {
  ConnectedAccountProvider,
  WebhookSubscriptionChannelType,
  WebhookSubscriptionStatus,
} from 'twenty-shared/types';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { bootstrapOmniAccountBinding } from 'src/modules/omnichannel/services/omni-binding-bootstrap';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';
import { WebhookSubscriptionDriverException } from 'src/modules/connected-account/webhook-subscription-manager/drivers/exceptions/webhook-subscription-driver.exception';
import { WebhookSubscriptionDriverExceptionCode } from 'src/modules/connected-account/webhook-subscription-manager/drivers/exceptions/webhook-subscription-driver.exception';
import { WebhookSubscriptionStatusService } from 'src/modules/connected-account/webhook-subscription-manager/services/webhook-subscription-status.service';
import { MessagingWebhookSubscriptionService } from 'src/modules/connected-account/webhook-subscription-manager/services/messaging-webhook-subscription.service';
import { CalendarWebhookSubscriptionService } from 'src/modules/connected-account/webhook-subscription-manager/services/calendar-webhook-subscription.service';
import { WebhookSubscriptionExceptionHandlerService } from 'src/modules/connected-account/webhook-subscription-manager/services/webhook-subscription-exception-handler.service';
jest.mock(
  'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity',
  () => ({ CalendarChannelEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/message-channel/entities/message-channel.entity',
  () => ({ MessageChannelEntity: class {} }),
);
jest.mock('src/engine/core-modules/metrics/metrics.service', () => ({
  MetricsService: class {},
}));
jest.mock(
  'src/modules/connected-account/webhook-subscription-manager/services/webhook-subscription-driver-factory.service',
  () => ({ WebhookSubscriptionDriverFactory: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/connected-account/entities/connected-account.entity',
  () => ({ ConnectedAccountEntity: class {} }),
);
jest.mock(
  'src/modules/connected-account/webhook-subscription-manager/services/workspace-activation.service',
  () => ({ WorkspaceActivationService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);

const fixture = createOmniNativeMessageFixture();
const accountSchema = new EntitySchema<ConnectedAccountEntity>({
  name: 'WebhookAccountFixture',
  target: ConnectedAccountEntity,
  schema: 'core',
  tableName: 'connectedAccount',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
    provider: { type: 'text' },
    applicationId: { type: 'uuid', nullable: true },
    connectionProviderId: { type: 'uuid', nullable: true },
    archivedAt: { type: 'timestamptz', nullable: true },
  },
});
const common = {
  id: { type: 'uuid', primary: true },
  workspaceId: { type: 'uuid' },
  connectedAccountId: { type: 'uuid' },
  webhookSubscriptionStatus: { type: 'text', nullable: true },
  webhookSubscriptionClientState: { type: 'text', nullable: true },
  webhookSubscriptionExternalId: { type: 'text', nullable: true },
  webhookSubscriptionExpiresAt: { type: 'timestamptz', nullable: true },
  updatedAt: { type: 'timestamptz', updateDate: true },
} as const;
const relation = {
  connectedAccount: {
    type: 'many-to-one' as const,
    target: () => ConnectedAccountEntity,
    joinColumn: { name: 'connectedAccountId' },
  },
};
const messageSchema = new EntitySchema<MessageChannelEntity>({
  name: 'WebhookMessageFixture',
  target: MessageChannelEntity,
  schema: 'core',
  tableName: 'messageChannel',
  columns: { ...common, type: { type: 'text' } },
  relations: relation,
});
const calendarSchema = new EntitySchema<CalendarChannelEntity>({
  name: 'WebhookCalendarFixture',
  target: CalendarChannelEntity,
  schema: 'core',
  tableName: 'calendarChannel',
  columns: {
    ...common,
    webhookSubscriptionExternalResourceId: { type: 'text', nullable: true },
  },
  relations: relation,
});
const runtime = new DataSource({
  type: 'postgres',
  url: fixture.runtimeDatabaseUrl,
  entities: [accountSchema, messageSchema, calendarSchema],
  synchronize: false,
  migrationsRun: false,
  extra: { max: 5, statement_timeout: 10000 },
});
let accountId: string, messageId: string, calendarId: string;
const kinds = [
  WebhookSubscriptionChannelType.MESSAGING,
  WebhookSubscriptionChannelType.CALENDAR,
] as const;
const idFor = (kind: WebhookSubscriptionChannelType) =>
  kind === WebhookSubscriptionChannelType.MESSAGING ? messageId : calendarId;
const repoFor = (kind: WebhookSubscriptionChannelType) =>
  kind === WebhookSubscriptionChannelType.MESSAGING
    ? runtime.getRepository(MessageChannelEntity)
    : runtime.getRepository(CalendarChannelEntity);
const read = (kind: WebhookSubscriptionChannelType) =>
  repoFor(kind).findOneByOrFail({ id: idFor(kind) });
let status: WebhookSubscriptionStatusService;
const result = {
  externalSubscriptionId: 'new-subscription',
  externalResourceId: 'new-resource',
  expiresAt: new Date('2030-01-01T00:00:00Z'),
};
const bootstrap = (parent = accountId, channel = messageId) =>
  bootstrapOmniAccountBinding(
    runtime,
    { kind: 'system', id: 'webhook-test' },
    {
      workspaceId: fixture.workspaceId,
      platform: 'telegram',
      connectorInstanceId: 'webhook-test',
      accountId: parent,
      connectedAccountId: parent,
      messageChannelId: channel,
      idempotencyKey: randomUUID(),
      expectedRevision: '0',
    },
    async () => undefined,
  );
const bindNative = async () => {
  await runtime
    .getRepository(ConnectedAccountEntity)
    .update(accountId, { provider: ConnectedAccountProvider.APP });
  await bootstrap();
};
const makeService = <T extends object>(prototype: T, dependencies: object): T =>
  Object.assign(Object.create(prototype), dependencies);
beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid,ADD provider text,ADD "applicationId" uuid,ADD "connectionProviderId" uuid,ADD "archivedAt" timestamptz',
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageChannel" ADD "connectedAccountId" uuid REFERENCES core."connectedAccount"(id)',
  );
  await fixture.owner.query(
    'CREATE TABLE core."calendarChannel" (id uuid PRIMARY KEY,"workspaceId" uuid,"connectedAccountId" uuid REFERENCES core."connectedAccount"(id),"webhookSubscriptionExternalResourceId" text)',
  );
  for (const table of ['messageChannel', 'calendarChannel'])
    await fixture.owner.query(
      `ALTER TABLE core."${table}" ADD "webhookSubscriptionStatus" text,ADD "webhookSubscriptionClientState" text,ADD "webhookSubscriptionExternalId" text,ADD "webhookSubscriptionExpiresAt" timestamptz,ADD "updatedAt" timestamptz DEFAULT now()`,
    );
  await fixture.owner.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO "${fixture.roleName}"`,
  );
  await runtime.initialize();
  status = new WebhookSubscriptionStatusService(
    runtime.getRepository(MessageChannelEntity),
    runtime.getRepository(CalendarChannelEntity),
  );
});
beforeEach(async () => {
  await fixture.reset();
  await fixture.owner.query(
    'TRUNCATE core.workspace,core."connectedAccount",core."messageChannel",core."calendarChannel" CASCADE',
  );
  await fixture.owner.query('INSERT INTO core.workspace(id) VALUES ($1)', [
    fixture.workspaceId,
  ]);
  accountId = randomUUID();
  messageId = randomUUID();
  calendarId = randomUUID();
  await runtime.getRepository(ConnectedAccountEntity).insert({
    id: accountId,
    workspaceId: fixture.workspaceId,
    provider: ConnectedAccountProvider.GOOGLE,
  });
  await runtime.getRepository(MessageChannelEntity).insert({
    id: messageId,
    workspaceId: fixture.workspaceId,
    connectedAccountId: accountId,
    type: 'APP' as never,
    webhookSubscriptionStatus: WebhookSubscriptionStatus.FAILED,
    webhookSubscriptionClientState: 'state',
    webhookSubscriptionExternalId: 'old-subscription',
    webhookSubscriptionExpiresAt: new Date('2029-01-01T00:00:00Z'),
  });
  await runtime.getRepository(CalendarChannelEntity).insert({
    id: calendarId,
    workspaceId: fixture.workspaceId,
    connectedAccountId: accountId,
    webhookSubscriptionStatus: WebhookSubscriptionStatus.FAILED,
    webhookSubscriptionClientState: 'state',
    webhookSubscriptionExternalId: 'old-subscription',
    webhookSubscriptionExternalResourceId: 'old-resource',
    webhookSubscriptionExpiresAt: new Date('2029-01-01T00:00:00Z'),
  });
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (runtime.isInitialized) await runtime.destroy();
  await fixture.dispose();
});
const methods = [
  'claim',
  'settle',
  'active',
  'failed',
  'expired',
  'reset',
  'clear',
] as const;
const invoke = (
  method: (typeof methods)[number],
  kind: WebhookSubscriptionChannelType,
  workspaceId = fixture.workspaceId,
  expectedConnectedAccountId?: string,
) => {
  const id = idFor(kind);
  switch (method) {
    case 'claim':
      return status.claimSubscriptionCreation(
        kind,
        id,
        workspaceId,
        expectedConnectedAccountId,
      );
    case 'settle':
      return status.settleClaimedSubscription(
        kind,
        id,
        workspaceId,
        'state',
        result,
        expectedConnectedAccountId,
      );
    case 'active':
      return status.markAsActive(
        kind,
        id,
        workspaceId,
        result,
        expectedConnectedAccountId,
      );
    case 'failed':
      return status.markAsFailed(
        kind,
        id,
        workspaceId,
        expectedConnectedAccountId,
      );
    case 'expired':
      return status.markAsExpired(
        kind,
        id,
        workspaceId,
        expectedConnectedAccountId,
      );
    case 'reset':
      return status.resetPendingSubscription(
        kind,
        id,
        workspaceId,
        expectedConnectedAccountId,
      );
    case 'clear':
      return status.clearRemovedSubscription(
        kind,
        id,
        workspaceId,
        'old-subscription',
        expectedConnectedAccountId,
      );
  }
};
describe.each(kinds)('webhook local writes %s', (kind) => {
  it.each(methods)(
    'ordinary %s applies with original CAS semantics',
    async (method) => {
      if (method === 'settle')
        await repoFor(kind).update(idFor(kind), {
          webhookSubscriptionStatus: WebhookSubscriptionStatus.PENDING,
        });
      const value = await invoke(method, kind);
      expect(value).toBeTruthy();
      const channel = await read(kind);
      if (method === 'claim')
        expect(channel).toMatchObject({
          webhookSubscriptionStatus: WebhookSubscriptionStatus.PENDING,
          webhookSubscriptionClientState: value,
        });
      if (method === 'settle' || method === 'active')
        expect(channel).toMatchObject({
          webhookSubscriptionStatus: WebhookSubscriptionStatus.ACTIVE,
          webhookSubscriptionExternalId: 'new-subscription',
        });
      if (method === 'expired')
        expect(channel.webhookSubscriptionStatus).toBe(
          WebhookSubscriptionStatus.EXPIRED,
        );
      if (method === 'failed' || method === 'clear')
        expect(channel.webhookSubscriptionStatus).toBe(
          WebhookSubscriptionStatus.FAILED,
        );
      if (method === 'reset')
        expect(channel.webhookSubscriptionExpiresAt).toBeNull();
      if (method === 'clear')
        expect(channel.webhookSubscriptionExternalId).toBeNull();
    },
  );
  it.each(methods)(
    'native bound %s is explicitly declined without mutation',
    async (method) => {
      if (method === 'settle')
        await repoFor(kind).update(idFor(kind), {
          webhookSubscriptionStatus: WebhookSubscriptionStatus.PENDING,
        });
      await bindNative();
      const before = await read(kind);
      expect(await invoke(method, kind)).toBe(
        method === 'claim' ? null : false,
      );
      expect(await read(kind)).toEqual(before);
    },
  );
  it.each(methods)(
    'legacy ordinary-provider binding %s remains protected',
    async (method) => {
      if (method === 'settle')
        await repoFor(kind).update(idFor(kind), {
          webhookSubscriptionStatus: WebhookSubscriptionStatus.PENDING,
        });
      await bindNative();
      await fixture.owner.query(
        'UPDATE core."connectedAccount" SET provider=$2 WHERE id=$1',
        [accountId, ConnectedAccountProvider.GOOGLE],
      );
      const before = await read(kind);
      expect(await invoke(method, kind)).toBe(
        method === 'claim' ? null : false,
      );
      expect(await read(kind)).toEqual(before);
    },
  );
  it.each(methods)(
    'snapshot parent mismatch declines %s even for ordinary destination',
    async (method) => {
      const before = await read(kind);
      expect(
        await invoke(method, kind, fixture.workspaceId, randomUUID()),
      ).toBe(method === 'claim' ? null : false);
      expect(await read(kind)).toEqual(before);
    },
  );
  it('unbound native account is not admitted to ordinary webhook work', async () => {
    await runtime
      .getRepository(ConnectedAccountEntity)
      .update(accountId, { provider: ConnectedAccountProvider.APP });
    expect(await invoke('claim', kind)).toBeNull();
    expect(await invoke('active', kind)).toBe(false);
  });
  it('wrong workspace and missing channel decline without writes', async () => {
    const before = await read(kind);
    expect(await invoke('active', kind, randomUUID())).toBe(false);
    expect(await read(kind)).toEqual(before);
    await repoFor(kind).delete(idFor(kind));
    expect(await invoke('active', kind)).toBe(false);
  });
  it('claim concurrency and stale client/subscription CAS are retained', async () => {
    const claims = await Promise.all([
      invoke('claim', kind),
      invoke('claim', kind),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      await status.settleClaimedSubscription(
        kind,
        idFor(kind),
        fixture.workspaceId,
        'wrong-state',
        result,
      ),
    ).toBe(false);
    expect(
      await status.settleClaimedSubscription(
        kind,
        idFor(kind),
        fixture.workspaceId,
        claims.find(Boolean) as string,
        result,
      ),
    ).toBe(true);
    expect(
      await status.clearRemovedSubscription(
        kind,
        idFor(kind),
        fixture.workspaceId,
        'old-subscription',
      ),
    ).toBe(false);
    expect((await read(kind)).webhookSubscriptionExternalId).toBe(
      'new-subscription',
    );
  });
  it('ownership storage read error propagates and leaves status unchanged', async () => {
    const before = await read(kind);
    await fixture.owner.query(
      `REVOKE SELECT ON core."omniAccountBinding" FROM "${fixture.roleName}"`,
    );
    try {
      await expect(invoke('active', kind)).rejects.toThrow('permission denied');
      expect(await read(kind)).toEqual(before);
    } finally {
      await fixture.owner.query(
        `GRANT SELECT ON core."omniAccountBinding" TO "${fixture.roleName}"`,
      );
    }
  });
});

describe.each(kinds)('actual provider late callbacks %s', (kind) => {
  const service = (driver: object, metrics: object) => {
    const dependencies = {
      messageChannelRepository: runtime.getRepository(MessageChannelEntity),
      calendarChannelRepository: runtime.getRepository(CalendarChannelEntity),
      connectedAccountRepository: runtime.getRepository(ConnectedAccountEntity),
      workspaceActivationService: { isWorkspaceServiceable: async () => true },
      webhookSubscriptionDriverFactory: {
        isProviderSupported: () => true,
        getDriver: () => driver,
      },
      metricsService: metrics,
      webhookSubscriptionStatusService: status,
      webhookSubscriptionExceptionHandlerService:
        new WebhookSubscriptionExceptionHandlerService(status),
    };
    return kind === WebhookSubscriptionChannelType.MESSAGING
      ? makeService(MessagingWebhookSubscriptionService.prototype, dependencies)
      : makeService(CalendarWebhookSubscriptionService.prototype, dependencies);
  };
  const moveAndBind = async () => {
    const destination = randomUUID();
    await runtime.getRepository(ConnectedAccountEntity).insert({
      id: destination,
      workspaceId: fixture.workspaceId,
      provider: ConnectedAccountProvider.APP,
    });
    if (kind === WebhookSubscriptionChannelType.MESSAGING) {
      await repoFor(kind).update(idFor(kind), {
        connectedAccountId: destination,
      });
      await bootstrap(destination, messageId);
    } else {
      const bindingChannel = randomUUID();
      await runtime.getRepository(MessageChannelEntity).insert({
        id: bindingChannel,
        workspaceId: fixture.workspaceId,
        connectedAccountId: destination,
        type: 'APP' as never,
      });
      await repoFor(kind).update(idFor(kind), {
        connectedAccountId: destination,
      });
      await bootstrap(destination, bindingChannel);
    }
  };
  const lifecycle = (
    owner:
      | MessagingWebhookSubscriptionService
      | CalendarWebhookSubscriptionService,
    operation: 'renew' | 'recreate',
    snapshot?: WebhookSubscriptionSnapshot,
  ) => {
    const options = {
      workspaceId: fixture.workspaceId,
      expectedSubscription: snapshot,
    };
    if (owner instanceof MessagingWebhookSubscriptionService) {
      return operation === 'renew'
        ? owner.renewSubscription({ ...options, messageChannelId: messageId })
        : owner.recreateSubscription({
            ...options,
            messageChannelId: messageId,
            removedSubscriptionId: 'old-subscription',
          });
    }
    return operation === 'renew'
      ? owner.renewSubscription({ ...options, calendarChannelId: calendarId })
      : owner.recreateSubscription({
          ...options,
          calendarChannelId: calendarId,
          removedSubscriptionId: 'old-subscription',
        });
  };
  const activate = async () => {
    await repoFor(kind).update(idFor(kind), {
      webhookSubscriptionStatus: WebhookSubscriptionStatus.ACTIVE,
    });
    return webhookSubscriptionSnapshot(await read(kind));
  };
  const changeIdentity = async (
    change: 'parent' | 'externalId' | 'clientState' | 'status',
  ) => {
    if (change === 'parent') {
      const destination = randomUUID();
      await runtime.getRepository(ConnectedAccountEntity).insert({
        id: destination,
        workspaceId: fixture.workspaceId,
        provider: ConnectedAccountProvider.GOOGLE,
      });
      await repoFor(kind).update(idFor(kind), {
        connectedAccountId: destination,
      });
    } else
      await repoFor(kind).update(
        idFor(kind),
        change === 'externalId'
          ? { webhookSubscriptionExternalId: 'replacement' }
          : change === 'clientState'
            ? { webhookSubscriptionClientState: 'replacement-state' }
            : { webhookSubscriptionStatus: WebhookSubscriptionStatus.EXPIRED },
      );
  };
  const driverDouble = () => ({
    createSubscription: jest.fn().mockResolvedValue(result),
    renewSubscription: jest.fn().mockResolvedValue(result),
    deleteSubscription: jest.fn().mockResolvedValue(undefined),
  });

  describe.each(['renew', 'recreate'] as const)(
    'pinned lifecycle %s',
    (operation) => {
      it.each(['parent', 'externalId', 'clientState', 'status'] as const)(
        'stale %s snapshot sends no provider request or local write',
        async (change) => {
          const snapshot = await activate();
          await changeIdentity(change);
          const before = await read(kind),
            driver = driverDouble();
          await lifecycle(
            service(driver, { incrementCounterBy: jest.fn() }),
            operation,
            snapshot,
          );
          expect(await read(kind)).toEqual(before);
          expect(driver.createSubscription).not.toHaveBeenCalled();
          expect(driver.renewSubscription).not.toHaveBeenCalled();
        },
      );
    },
  );
  it.each(['externalId', 'clientState', 'status'] as const)(
    'late renew success cannot overwrite changed %s',
    async (change) => {
      const snapshot = await activate(),
        driver = driverDouble(),
        metrics = { incrementCounterBy: jest.fn() };
      let before: Awaited<ReturnType<typeof read>>;
      driver.renewSubscription.mockImplementationOnce(async () => {
        await changeIdentity(change);
        before = await read(kind);
        return result;
      });
      await lifecycle(service(driver, metrics), 'renew', snapshot);
      expect(await read(kind)).toEqual(before!);
      expect(metrics.incrementCounterBy).not.toHaveBeenCalled();
    },
  );
  it.each([
    WebhookSubscriptionDriverExceptionCode.NOT_FOUND,
    WebhookSubscriptionDriverExceptionCode.INSUFFICIENT_PERMISSIONS,
    WebhookSubscriptionDriverExceptionCode.TEMPORARY_ERROR,
    WebhookSubscriptionDriverExceptionCode.UNKNOWN,
  ])(
    'late renew error %s preserves replacement and cannot recreate',
    async (code) => {
      const snapshot = await activate(),
        driver = driverDouble();
      const error = new WebhookSubscriptionDriverException(
        'delayed-renew',
        code,
      );
      let before: Awaited<ReturnType<typeof read>>;
      driver.renewSubscription.mockImplementationOnce(async () => {
        await changeIdentity('clientState');
        before = await read(kind);
        throw error;
      });
      const pending = lifecycle(
        service(driver, { incrementCounterBy: jest.fn() }),
        'renew',
        snapshot,
      );
      if (
        [
          WebhookSubscriptionDriverExceptionCode.TEMPORARY_ERROR,
          WebhookSubscriptionDriverExceptionCode.UNKNOWN,
        ].includes(code)
      )
        await expect(pending).rejects.toBe(error);
      else await pending;
      expect(await read(kind)).toEqual(before!);
      expect(driver.createSubscription).not.toHaveBeenCalled();
    },
  );
  describe.each(['removed', 'notFound'] as const)('recovery %s', (cause) => {
    it.each(['ordinary', 'parent', 'replacement'] as const)(
      'only clears and recreates its own subscription: %s',
      async (race) => {
        const snapshot = await activate(),
          driver = driverDouble();
        if (cause === 'notFound')
          driver.renewSubscription.mockRejectedValueOnce(
            new WebhookSubscriptionDriverException(
              'notfound',
              WebhookSubscriptionDriverExceptionCode.NOT_FOUND,
            ),
          );
        const clear = status.clearRemovedSubscription.bind(status);
        let afterClear: Awaited<ReturnType<typeof read>>;
        jest
          .spyOn(status, 'clearRemovedSubscription')
          .mockImplementationOnce(async (...args) => {
            const accepted = await clear(...args);
            expect(accepted).toBe(true);
            if (race === 'parent') await changeIdentity('parent');
            if (race === 'replacement')
              await repoFor(kind).update(idFor(kind), {
                webhookSubscriptionStatus: WebhookSubscriptionStatus.PENDING,
                webhookSubscriptionClientState: 'new-claim',
              });
            afterClear = await read(kind);
            return accepted;
          });
        await lifecycle(
          service(driver, { incrementCounterBy: jest.fn() }),
          cause === 'removed' ? 'recreate' : 'renew',
          snapshot,
        );
        if (race === 'ordinary') {
          expect(driver.createSubscription).toHaveBeenCalledWith(
            accountId,
            kind,
            expect.any(String),
          );
          expect((await read(kind)).webhookSubscriptionExternalId).toBe(
            result.externalSubscriptionId,
          );
          expect((await read(kind)).webhookSubscriptionStatus).toBe(
            WebhookSubscriptionStatus.ACTIVE,
          );
        } else {
          expect(driver.createSubscription).not.toHaveBeenCalled();
          expect(await read(kind)).toEqual(afterClear!);
        }
      },
    );
  });
  it('same-account claim replacement before creation claim sends no request', async () => {
    const claim = status.claimSubscriptionCreation.bind(status),
      driver = driverDouble();
    jest
      .spyOn(status, 'claimSubscriptionCreation')
      .mockImplementationOnce(async (...args) => {
        await changeIdentity('clientState');
        return claim(...args);
      });
    await service(driver, { incrementCounterBy: jest.fn() }).createSubscription(
      idFor(kind),
      fixture.workspaceId,
    );
    expect(driver.createSubscription).not.toHaveBeenCalled();
    expect((await read(kind)).webhookSubscriptionClientState).toBe(
      'replacement-state',
    );
  });
  it('late create failure cannot reset or fail a newer pending claim', async () => {
    const driver = driverDouble(),
      error = new WebhookSubscriptionDriverException(
        'delayed-create',
        WebhookSubscriptionDriverExceptionCode.TEMPORARY_ERROR,
      );
    let before: Awaited<ReturnType<typeof read>>;
    driver.createSubscription.mockImplementationOnce(async () => {
      await changeIdentity('clientState');
      before = await read(kind);
      throw error;
    });
    await expect(
      service(driver, { incrementCounterBy: jest.fn() }).createSubscription(
        idFor(kind),
        fixture.workspaceId,
      ),
    ).rejects.toBe(error);
    expect(await read(kind)).toEqual(before!);
  });
  it('ordinary create failure expires its own new claim', async () => {
    const driver = driverDouble();
    driver.createSubscription.mockRejectedValueOnce(
      new WebhookSubscriptionDriverException(
        'permissions',
        WebhookSubscriptionDriverExceptionCode.INSUFFICIENT_PERMISSIONS,
      ),
    );
    await service(driver, { incrementCounterBy: jest.fn() }).createSubscription(
      idFor(kind),
      fixture.workspaceId,
    );
    const row = await read(kind);
    expect(row.webhookSubscriptionStatus).toBe(
      WebhookSubscriptionStatus.EXPIRED,
    );
    expect(row.webhookSubscriptionExpiresAt).toBeNull();
    expect(row.webhookSubscriptionClientState).not.toBe('state');
  });
  it('null expected externalId is exact and never matches a newly assigned subscription', async () => {
    await repoFor(kind).update(idFor(kind), {
      webhookSubscriptionExternalId: null,
      webhookSubscriptionClientState: null,
    });
    const snapshot = webhookSubscriptionSnapshot(await read(kind));
    await changeIdentity('externalId');
    expect(
      await status.claimSubscriptionCreation(
        kind,
        idFor(kind),
        fixture.workspaceId,
        accountId,
        snapshot,
      ),
    ).toBeNull();
    expect((await read(kind)).webhookSubscriptionExternalId).toBe(
      'replacement',
    );
  });
  it.each(['reauthorizationRequired', 'subscriptionRemoved'] as const)(
    'actual Microsoft %s notification retains authenticated snapshot across reparent',
    async (lifecycleEvent) => {
      await activate();
      const snapshot = await read(kind),
        driver = driverDouble(),
        owner = service(driver, { incrementCounterBy: jest.fn() });
      const dependencies = {
        messageChannelRepository: {
          find: async () => {
            await changeIdentity('parent');
            return [snapshot];
          },
        },
        calendarChannelRepository: {
          find: async () => {
            await changeIdentity('parent');
            return [snapshot];
          },
        },
        messagingWebhookSubscriptionService: owner,
        calendarWebhookSubscriptionService: owner,
        webhookSyncTriggerService: {
          triggerMessagingSync: jest.fn(),
          triggerCalendarSync: jest.fn(),
        },
        metricsService: { incrementCounterBy: jest.fn() },
        exceptionHandlerService: { captureExceptions: jest.fn() },
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      };
      const handler =
        kind === WebhookSubscriptionChannelType.MESSAGING
          ? makeService(
              MicrosoftMessagingNotificationHandler.prototype,
              dependencies,
            )
          : makeService(
              MicrosoftCalendarNotificationHandler.prototype,
              dependencies,
            );
      await handler.handle([
        {
          subscriptionId: 'old-subscription',
          clientState: 'state',
          lifecycleEvent,
        } as never,
      ]);
      expect(driver.createSubscription).not.toHaveBeenCalled();
      expect(driver.renewSubscription).not.toHaveBeenCalled();
      expect((await read(kind)).webhookSubscriptionExternalId).toBe(
        'old-subscription',
      );
    },
  );
  it('unknown pre-network admission commit stops renew and recovery', async () => {
    const snapshot = await activate(),
      driver = driverDouble();
    const original = runtime.createQueryRunner.bind(runtime);
    jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
      const runner = original(),
        commit = runner.commitTransaction.bind(runner);
      runner.commitTransaction = async () => {
        await commit();
        throw new Error('lost-admission-ack');
      };
      return runner;
    });
    await expect(
      lifecycle(
        service(driver, { incrementCounterBy: jest.fn() }),
        'renew',
        snapshot,
      ),
    ).rejects.toThrow('OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN');
    expect(driver.renewSubscription).not.toHaveBeenCalled();
    expect(driver.createSubscription).not.toHaveBeenCalled();
  });
  it.each(['success', 'temporary', 'permissions'] as const)(
    'newer successful renewal survives older %s response',
    async (outcome) => {
      const snapshot = await activate(),
        driver = driverDouble();
      let renewed: Awaited<ReturnType<typeof read>>;
      const newer = {
        ...result,
        externalSubscriptionId: 'old-subscription',
        expiresAt: new Date('2031-01-01T00:00:00Z'),
      };
      driver.renewSubscription.mockImplementationOnce(async () => {
        expect(
          await status.markAsActive(
            kind,
            idFor(kind),
            fixture.workspaceId,
            newer,
            accountId,
            snapshot,
          ),
        ).toBe(true);
        renewed = await read(kind);
        if (outcome === 'success') return result;
        throw new WebhookSubscriptionDriverException(
          'older-renew',
          outcome === 'temporary'
            ? WebhookSubscriptionDriverExceptionCode.TEMPORARY_ERROR
            : WebhookSubscriptionDriverExceptionCode.INSUFFICIENT_PERMISSIONS,
        );
      });
      const pending = lifecycle(
        service(driver, { incrementCounterBy: jest.fn() }),
        'renew',
        snapshot,
      );
      if (outcome === 'temporary')
        await expect(pending).rejects.toThrow('older-renew');
      else await pending;
      expect(await read(kind)).toEqual(renewed!);
    },
  );
  it.each(['create', 'renew', 'delete'] as const)(
    'unknown OAuth commit during %s is not provider failure',
    async (operation) => {
      if (operation !== 'create') await activate();
      const driver = driverDouble(),
        metrics = { incrementCounterBy: jest.fn() },
        unknown = new OmniCoreTransactionOutcomeUnknownError(
          new Error('token-commit-ack'),
        );
      let before: Awaited<ReturnType<typeof read>>;
      const fail = async () => {
        before = await read(kind);
        throw unknown;
      };
      driver.createSubscription.mockImplementationOnce(fail);
      driver.renewSubscription.mockImplementationOnce(fail);
      driver.deleteSubscription.mockImplementationOnce(fail);
      const owner = service(driver, metrics);
      const pending =
        operation === 'create'
          ? owner.createSubscription(idFor(kind), fixture.workspaceId)
          : operation === 'delete'
            ? owner.deleteSubscription(idFor(kind), fixture.workspaceId)
            : lifecycle(owner, 'renew');
      await expect(pending).rejects.toBe(unknown);
      expect(await read(kind)).toEqual(before!);
      expect(metrics.incrementCounterBy).not.toHaveBeenCalled();
    },
  );
  it('direct exception handler propagates unknown commit without mutation', async () => {
    const snapshot = await read(kind),
      error = new OmniCoreTransactionOutcomeUnknownError(new Error('unknown'));
    await expect(
      new WebhookSubscriptionExceptionHandlerService(
        status,
      ).handleDriverException(
        error,
        'RENEW',
        kind,
        snapshot,
        fixture.workspaceId,
        webhookSubscriptionSnapshot(snapshot),
      ),
    ).rejects.toBe(error);
    expect(await read(kind)).toEqual(snapshot);
  });
  it('unknown clear commit never triggers replacement creation', async () => {
    const snapshot = await activate(),
      driver = driverDouble(),
      original = runtime.createQueryRunner.bind(runtime);
    jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
      const runner = original(),
        commit = runner.commitTransaction.bind(runner);
      runner.commitTransaction = async () => {
        await commit();
        throw new Error('lost-clear-ack');
      };
      return runner;
    });
    await expect(
      lifecycle(
        service(driver, { incrementCounterBy: jest.fn() }),
        'recreate',
        snapshot,
      ),
    ).rejects.toThrow('OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN');
    expect(driver.createSubscription).not.toHaveBeenCalled();
    expect((await read(kind)).webhookSubscriptionExternalId).toBeNull();
  });
  it.each(['delete', 'renew'] as const)(
    '%s response after reparent/enrollment cannot update status or report local success',
    async (operation) => {
      await repoFor(kind).update(idFor(kind), {
        webhookSubscriptionStatus: WebhookSubscriptionStatus.ACTIVE,
      });
      const driver = {
        deleteSubscription: jest.fn(async () => {
          await moveAndBind();
        }),
        renewSubscription: jest.fn(async () => {
          await moveAndBind();
          return result;
        }),
      };
      const metrics = { incrementCounterBy: jest.fn() };
      const owner = service(driver, metrics);
      if (operation === 'delete')
        await owner.deleteSubscription(idFor(kind), fixture.workspaceId);
      else if (owner instanceof MessagingWebhookSubscriptionService)
        await owner.renewSubscription({
          messageChannelId: messageId,
          workspaceId: fixture.workspaceId,
        });
      else
        await owner.renewSubscription({
          calendarChannelId: calendarId,
          workspaceId: fixture.workspaceId,
        });
      expect((await read(kind)).webhookSubscriptionExternalId).toBe(
        'old-subscription',
      );
      expect((await read(kind)).webhookSubscriptionStatus).toBe(
        WebhookSubscriptionStatus.ACTIVE,
      );
      expect(metrics.incrementCounterBy).not.toHaveBeenCalled();
      expect(
        operation === 'delete'
          ? driver.deleteSubscription
          : driver.renewSubscription,
      ).toHaveBeenCalledTimes(1);
    },
  );
  it('create refuses a snapshot reparented before its claim and sends no request', async () => {
    const claim = status.claimSubscriptionCreation.bind(status);
    jest
      .spyOn(status, 'claimSubscriptionCreation')
      .mockImplementationOnce(async (...args) => {
        const destination = randomUUID();
        await runtime.getRepository(ConnectedAccountEntity).insert({
          id: destination,
          workspaceId: fixture.workspaceId,
          provider: ConnectedAccountProvider.GOOGLE,
        });
        await repoFor(kind).update(idFor(kind), {
          connectedAccountId: destination,
        });
        return claim(...args);
      });
    const driver = {
      createSubscription: jest.fn().mockResolvedValue(result),
      deleteSubscription: jest.fn(),
    };
    const metrics = { incrementCounterBy: jest.fn() };
    await service(driver, metrics).createSubscription(
      idFor(kind),
      fixture.workspaceId,
    );
    expect(driver.createSubscription).not.toHaveBeenCalled();
    expect(driver.deleteSubscription).not.toHaveBeenCalled();
    expect(metrics.incrementCounterBy).not.toHaveBeenCalled();
    expect((await read(kind)).webhookSubscriptionExternalId).toBe(
      'old-subscription',
    );
    expect((await read(kind)).webhookSubscriptionStatus).toBe(
      WebhookSubscriptionStatus.FAILED,
    );
  });
  it.each(['delete', 'renew'] as const)(
    '%s local lost commit ACK is not reclassified as provider failure',
    async (operation) => {
      await repoFor(kind).update(idFor(kind), {
        webhookSubscriptionStatus: WebhookSubscriptionStatus.ACTIVE,
      });
      const driver = {
        deleteSubscription: jest.fn().mockResolvedValue(undefined),
        renewSubscription: jest.fn().mockResolvedValue(result),
      };
      const metrics = { incrementCounterBy: jest.fn() };
      const owner = service(driver, metrics);
      const original = runtime.createQueryRunner.bind(runtime);
      let committed = 0;
      jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
        const runner = original(),
          commit = runner.commitTransaction.bind(runner);
        runner.commitTransaction = async () => {
          await commit();
          committed++;
          if (committed === (operation === 'renew' ? 2 : 1))
            throw new Error('webhook-lost-commit-ack');
        };
        return runner;
      });
      const pending =
        operation === 'delete'
          ? owner.deleteSubscription(idFor(kind), fixture.workspaceId)
          : owner instanceof MessagingWebhookSubscriptionService
            ? owner.renewSubscription({
                messageChannelId: messageId,
                workspaceId: fixture.workspaceId,
              })
            : owner.renewSubscription({
                calendarChannelId: calendarId,
                workspaceId: fixture.workspaceId,
              });
      await expect(pending).rejects.toThrow(
        'OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN',
      );
      expect(committed).toBe(operation === 'renew' ? 2 : 1);
      expect((await read(kind)).webhookSubscriptionStatus).toBe(
        operation === 'delete'
          ? WebhookSubscriptionStatus.EXPIRED
          : WebhookSubscriptionStatus.ACTIVE,
      );
      expect(metrics.incrementCounterBy).not.toHaveBeenCalled();
      expect(
        driver[
          operation === 'delete' ? 'deleteSubscription' : 'renewSubscription'
        ],
      ).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['delete', 'renew', 'create'] as const)(
    '%s response after ordinary reparent cannot write previous account subscription',
    async (operation) => {
      if (operation !== 'create')
        await repoFor(kind).update(idFor(kind), {
          webhookSubscriptionStatus: WebhookSubscriptionStatus.ACTIVE,
        });
      const move = async () => {
        const destination = randomUUID();
        await runtime.getRepository(ConnectedAccountEntity).insert({
          id: destination,
          workspaceId: fixture.workspaceId,
          provider: ConnectedAccountProvider.GOOGLE,
        });
        await repoFor(kind).update(idFor(kind), {
          connectedAccountId: destination,
        });
        return result;
      };
      const driver = {
        deleteSubscription: jest.fn(async () => {
          if (operation === 'delete') await move();
        }),
        renewSubscription: jest.fn(move),
        createSubscription: jest.fn(move),
      };
      const metrics = { incrementCounterBy: jest.fn() };
      const owner = service(driver, metrics);
      if (operation === 'delete')
        await owner.deleteSubscription(idFor(kind), fixture.workspaceId);
      else if (operation === 'create')
        await owner.createSubscription(idFor(kind), fixture.workspaceId);
      else if (owner instanceof MessagingWebhookSubscriptionService)
        await owner.renewSubscription({
          messageChannelId: messageId,
          workspaceId: fixture.workspaceId,
        });
      else
        await owner.renewSubscription({
          calendarChannelId: calendarId,
          workspaceId: fixture.workspaceId,
        });
      expect((await read(kind)).webhookSubscriptionExternalId).toBe(
        'old-subscription',
      );
      expect(metrics.incrementCounterBy).not.toHaveBeenCalled();
      expect(
        driver[
          operation === 'delete'
            ? 'deleteSubscription'
            : operation === 'renew'
              ? 'renewSubscription'
              : 'createSubscription'
        ],
      ).toHaveBeenCalledTimes(1);
      if (operation === 'create')
        expect(driver.deleteSubscription).toHaveBeenCalledTimes(1); // existing orphan-watch cleanup
    },
  );
  it('ordinary delete still records expiration and one success metric', async () => {
    await repoFor(kind).update(idFor(kind), {
      webhookSubscriptionStatus: WebhookSubscriptionStatus.ACTIVE,
    });
    const driver = {
        deleteSubscription: jest.fn().mockResolvedValue(undefined),
      },
      metrics = { incrementCounterBy: jest.fn() };
    await service(driver, metrics).deleteSubscription(
      idFor(kind),
      fixture.workspaceId,
    );
    expect((await read(kind)).webhookSubscriptionStatus).toBe(
      WebhookSubscriptionStatus.EXPIRED,
    );
    expect(driver.deleteSubscription).toHaveBeenCalledTimes(1);
    expect(metrics.incrementCounterBy).toHaveBeenCalledTimes(1);
  });
  it('NOT_FOUND recovery never recreates a newly protected subscription', async () => {
    const snapshot = await read(kind);
    await bindNative();
    const owner = new WebhookSubscriptionExceptionHandlerService(status);
    const error = new WebhookSubscriptionDriverException(
      'fixture-not-found',
      WebhookSubscriptionDriverExceptionCode.NOT_FOUND,
    );
    await expect(
      owner.handleDriverException(
        error,
        'RENEW',
        kind,
        snapshot,
        fixture.workspaceId,
      ),
    ).resolves.toBe('NONE');
    expect((await read(kind)).webhookSubscriptionExternalId).toBe(
      'old-subscription',
    );
  });
});

it('changed parent during lock acquisition is a declined callback, not a write to the new parent', async () => {
  const destination = randomUUID();
  await runtime.getRepository(ConnectedAccountEntity).insert({
    id: destination,
    workspaceId: fixture.workspaceId,
    provider: ConnectedAccountProvider.GOOGLE,
  });
  const original = runtime.createQueryRunner.bind(runtime);
  let moved = false;
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation(() => {
    const runner = original(),
      query = runner.query.bind(runner);
    runner.query = async (...args: Parameters<QueryRunner['query']>) => {
      const rows = await query(...args);
      if (
        !moved &&
        args[0] ===
          'SELECT "connectedAccountId" FROM core."messageChannel" WHERE "workspaceId"=$1 AND id=$2'
      ) {
        moved = true;
        await fixture.owner.query(
          'UPDATE core."messageChannel" SET "connectedAccountId"=$2 WHERE id=$1',
          [messageId, destination],
        );
      }
      return rows;
    };
    return runner;
  });
  expect(await invoke('active', WebhookSubscriptionChannelType.MESSAGING)).toBe(
    false,
  );
  expect(moved).toBe(true);
  expect(
    (await read(WebhookSubscriptionChannelType.MESSAGING))
      .webhookSubscriptionExternalId,
  ).toBe('old-subscription');
});
