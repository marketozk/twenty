import { randomUUID } from 'node:crypto';

import {
  ConnectedAccountProvider,
  MessageChannelSyncStage,
  MessageChannelType,
  MessageChannelVisibility,
} from 'twenty-shared/types';

import { ConnectedAccountMetadataService } from 'src/engine/metadata-modules/connected-account/connected-account-metadata.service';
import { MessageChannelMetadataService } from 'src/engine/metadata-modules/message-channel/message-channel-metadata.service';
import { ApplicationMessageChannelsService } from 'src/engine/metadata-modules/message-channel/services/application-message-channels.service';

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

const attachTransactionRunner = (
  manager: object,
  transactionManager: {
    query: (sql: string, parameters?: unknown[]) => Promise<unknown>;
  },
) => {
  Object.assign(manager, {
    connection: {
      createQueryRunner: () => ({
        isTransactionActive: false,
        isReleased: false,
        manager: transactionManager,
        query: transactionManager.query,
        async connect() {},
        async startTransaction() {
          this.isTransactionActive = true;
        },
        async commitTransaction() {
          this.isTransactionActive = false;
        },
        async rollbackTransaction() {
          this.isTransactionActive = false;
        },
        async release() {
          this.isReleased = true;
        },
        async releasePostgresConnection() {
          this.isReleased = true;
        },
      }),
    },
  });
};

const accountFixture = () => {
  const workspaceId = randomUUID();
  const account = {
    id: randomUUID(),
    workspaceId,
    userWorkspaceId: randomUUID(),
    connectionProviderId: randomUUID(),
  };
  const query = jest.fn().mockResolvedValue([]);
  const update = jest.fn().mockResolvedValue({ affected: 1 });
  const makeTransactionManager = () => ({
    update,
    queryRunner: { isTransactionActive: true },
    getRepository: (): unknown => repository,
    query: async (sql: string, parameters?: unknown[]) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.startsWith('SELECT id FROM core."connectedAccount"'))
        return (parameters?.[1] as string[]).map((id) => ({ id }));
      return query(sql, parameters);
    },
  });
  const transaction = jest.fn(
    async (isolationOrWork: unknown, maybeWork?: unknown) => {
      const work = (maybeWork ?? isolationOrWork) as (
        manager: unknown,
      ) => Promise<unknown>;
      return work(makeTransactionManager());
    },
  );
  const repository = {
    target: 'channel',
    create: jest.fn((data: unknown) => data),
    save: jest.fn().mockResolvedValue(account),
    find: jest.fn().mockResolvedValue([account]),
    findOneOrFail: jest.fn().mockResolvedValue(account),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    manager: { query, transaction },
  };
  attachTransactionRunner(repository.manager, makeTransactionManager());
  const channels = {
    find: jest.fn().mockResolvedValue([{ id: randomUUID() }]),
  };
  const calendars = {
    find: jest.fn().mockResolvedValue([{ id: randomUUID() }]),
  };
  const revoke = { revokeIfApp: jest.fn().mockResolvedValue(undefined) };
  const hooks = { runOnDisconnect: jest.fn().mockResolvedValue(undefined) };
  const calendarSubscriptions = {
    deleteSubscription: jest.fn().mockResolvedValue(undefined),
  };
  const messageSubscriptions = {
    deleteSubscription: jest.fn().mockResolvedValue(undefined),
  };
  const emitter = { emitCustomBatchEvent: jest.fn() };
  type Dependencies = ConstructorParameters<
    typeof ConnectedAccountMetadataService
  >;
  const service = new ConnectedAccountMetadataService(
    repository as unknown as Dependencies[0],
    calendars as unknown as Dependencies[1],
    channels as unknown as Dependencies[2],
    revoke as unknown as Dependencies[3],
    hooks as unknown as Dependencies[4],
    {} as Dependencies[5],
    emitter as unknown as Dependencies[6],
    calendarSubscriptions as unknown as Dependencies[7],
    messageSubscriptions as unknown as Dependencies[8],
  );
  const effects = [
    repository.update,
    repository.delete,
    update,
    revoke.revokeIfApp,
    hooks.runOnDisconnect,
    calendarSubscriptions.deleteSubscription,
    messageSubscriptions.deleteSubscription,
    emitter.emitCustomBatchEvent,
  ];
  const invoke = (
    action: 'update' | 'disconnect' | 'deleteMany' | 'transferOwnership',
  ) => {
    switch (action) {
      case 'update':
        return service.update({
          id: account.id,
          workspaceId,
          data: { handle: 'changed@example.test' },
        });
      case 'disconnect':
        return service.disconnect({ id: account.id, workspaceId });
      case 'deleteMany':
        return service.deleteMany({ ids: [account.id], workspaceId });
      case 'transferOwnership':
        return service.transferOwnership({
          fromUserWorkspaceId: account.userWorkspaceId,
          toUserWorkspaceId: randomUUID(),
          workspaceId,
        });
    }
  };
  return {
    service,
    workspaceId,
    account,
    query,
    repository,
    channels,
    calendars,
    effects,
    invoke,
    hooks,
    revoke,
  };
};

const channelFixture = () => {
  const workspaceId = randomUUID();
  const id = randomUUID();
  const account = {
    id: randomUUID(),
    applicationId: randomUUID(),
    workspaceId,
    provider: ConnectedAccountProvider.APP,
    scope: 'WORKSPACE',
    userWorkspaceId: randomUUID(),
    archivedAt: null,
  };
  const channel = {
    id,
    workspaceId,
    type: 'APP',
    connectedAccountId: account.id,
    displayName: 'Before',
    isSyncEnabled: true,
  };
  const query = jest.fn().mockResolvedValue([]);
  const repository = {
    target: 'channel',
    create: jest.fn((data: unknown) => data),
    save: jest.fn().mockResolvedValue(channel),
    findOne: jest.fn().mockResolvedValue(channel),
    findOneOrFail: jest.fn().mockResolvedValue(channel),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    manager: {
      query,
      transaction: jest.fn(
        async (
          _isolation: string,
          work: (manager: unknown) => Promise<unknown>,
        ) => work(transactionManager),
      ),
    },
  };
  const accounts = {
    target: 'account',
    findOne: jest.fn().mockResolvedValue(account),
  };
  const accountMetadata = { findById: jest.fn().mockResolvedValue(account) };
  const transactionManager = {
    queryRunner: { isTransactionActive: true },
    getRepository: (target: string) =>
      target === 'account' ? accounts : repository,
    query: async (sql: string, parameters?: unknown[]) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.startsWith('SELECT "connectedAccountId" FROM'))
        return [{ connectedAccountId: channel.connectedAccountId }];
      if (sql.startsWith('SELECT id FROM core."connectedAccount"')) {
        const rows: { id: string }[] = [];
        for (const id of parameters?.[1] as string[]) {
          if (
            id === account.id ||
            (await accountMetadata.findById({ id, workspaceId }))
          )
            rows.push({ id });
        }
        return rows;
      }
      return query(sql, parameters);
    },
  };
  attachTransactionRunner(repository.manager, transactionManager);
  const emitter = { emitCustomBatchEvent: jest.fn() };
  type GenericDependencies = ConstructorParameters<
    typeof MessageChannelMetadataService
  >;
  const generic = new MessageChannelMetadataService(
    repository as unknown as GenericDependencies[0],
    accountMetadata as unknown as GenericDependencies[1],
    {} as GenericDependencies[2],
    {} as GenericDependencies[3],
    emitter as unknown as GenericDependencies[4],
    {} as GenericDependencies[5],
  );
  type AppDependencies = ConstructorParameters<
    typeof ApplicationMessageChannelsService
  >;
  const app = new ApplicationMessageChannelsService(
    repository as unknown as AppDependencies[0],
    accounts as unknown as AppDependencies[1],
    emitter as unknown as AppDependencies[2],
  );
  const request = {
    id,
    workspaceId,
    applicationId: account.applicationId,
    requestUserWorkspaceId: account.userWorkspaceId,
  };
  const invoke = (
    action: 'genericUpdate' | 'genericDelete' | 'appUpdate' | 'appDelete',
  ) => {
    switch (action) {
      case 'genericUpdate':
        return generic.update({
          id,
          workspaceId,
          data: { isSyncEnabled: false },
        });
      case 'genericDelete':
        return generic.delete({ id, workspaceId });
      case 'appUpdate':
        return app.update({ ...request, isSyncEnabled: false });
      case 'appDelete':
        return app.delete(request);
    }
  };
  return {
    generic,
    app,
    repository,
    accounts,
    accountMetadata,
    emitter,
    request,
    query,
    id,
    channel,
    invoke,
  };
};

describe('metadata mutation entry points respect persisted omni ownership', () => {
  it.each(['update', 'disconnect', 'deleteMany', 'transferOwnership'] as const)(
    'account %s rejects owned records before every external/database effect',
    async (action) => {
      const fixture = accountFixture();
      fixture.query.mockResolvedValue([{ id: fixture.account.id }]);
      await expect(fixture.invoke(action)).rejects.toThrow(
        'OMNI_OWNED_ACCOUNT',
      );
      for (const effect of fixture.effects)
        expect(effect).not.toHaveBeenCalled();
      expect(fixture.channels.find).not.toHaveBeenCalled();
      expect(fixture.calendars.find).not.toHaveBeenCalled();
    },
  );

  it.each(['update', 'disconnect', 'deleteMany', 'transferOwnership'] as const)(
    'account %s fails closed on ownership SQL error',
    async (action) => {
      const fixture = accountFixture();
      const error = new Error('ownership unavailable');
      fixture.query.mockRejectedValue(error);
      await expect(fixture.invoke(action)).rejects.toBe(error);
      for (const effect of fixture.effects)
        expect(effect).not.toHaveBeenCalled();
    },
  );

  it.each(['update', 'disconnect', 'deleteMany', 'transferOwnership'] as const)(
    'ordinary account %s keeps existing behavior after ownership preflight',
    async (action) => {
      const fixture = accountFixture();
      await fixture.invoke(action);
      const called = fixture.effects.filter(
        (effect) => effect.mock.calls.length > 0,
      );
      expect(called.length).toBeGreaterThan(0);
      for (const effect of called)
        expect(fixture.query.mock.invocationCallOrder[0]).toBeLessThan(
          effect.mock.invocationCallOrder[0],
        );
      if (action === 'disconnect' || action === 'deleteMany')
        expect(fixture.hooks.runOnDisconnect).toHaveBeenCalledTimes(1);
      if (action !== 'update')
        expect(fixture.revoke.revokeIfApp).toHaveBeenCalledTimes(1);
    },
  );

  it('mixed account deletion refuses the whole batch before an ordinary account hook or deletion', async () => {
    const fixture = accountFixture();
    const protectedAccount = { ...fixture.account, id: randomUUID() };
    fixture.repository.find.mockResolvedValue([
      fixture.account,
      protectedAccount,
    ]);
    fixture.query.mockResolvedValue([{ id: protectedAccount.id }]);
    await expect(
      fixture.service.deleteMany({
        ids: [fixture.account.id, protectedAccount.id],
        workspaceId: fixture.workspaceId,
      }),
    ).rejects.toThrow('OMNI_OWNED_ACCOUNT');
    for (const effect of fixture.effects) expect(effect).not.toHaveBeenCalled();
  });

  it.each(['disconnect', 'delete'] as const)(
    'missing account %s preserves not-found before ownership lookup',
    async (action) => {
      const fixture = accountFixture();
      const notFound = new Error('account not found');
      fixture.repository.findOneOrFail.mockRejectedValue(notFound);
      await expect(
        fixture.service[action]({
          id: fixture.account.id,
          workspaceId: fixture.workspaceId,
        }),
      ).rejects.toBe(notFound);
      expect(fixture.query).not.toHaveBeenCalled();
      for (const effect of fixture.effects)
        expect(effect).not.toHaveBeenCalled();
    },
  );

  it('empty account selection retains its no-op behavior without ownership SQL', async () => {
    const fixture = accountFixture();
    fixture.repository.find.mockResolvedValue([]);
    await fixture.service.deleteMany({
      ids: [],
      workspaceId: fixture.workspaceId,
    });
    await fixture.invoke('transferOwnership');
    expect(fixture.query).not.toHaveBeenCalled();
    for (const effect of fixture.effects) expect(effect).not.toHaveBeenCalled();
  });

  it.each([
    'genericUpdate',
    'genericDelete',
    'appUpdate',
    'appDelete',
  ] as const)(
    'channel %s refuses owned records without mutation/emission',
    async (action) => {
      const fixture = channelFixture();
      fixture.query.mockResolvedValue([{ id: fixture.id }]);
      await expect(fixture.invoke(action)).rejects.toThrow(
        'OMNI_OWNED_CHANNEL',
      );
      expect(fixture.repository.update).not.toHaveBeenCalled();
      expect(fixture.repository.delete).not.toHaveBeenCalled();
      expect(fixture.emitter.emitCustomBatchEvent).not.toHaveBeenCalled();
    },
  );

  it.each([
    'genericUpdate',
    'genericDelete',
    'appUpdate',
    'appDelete',
  ] as const)(
    'channel %s fails closed on ownership lookup failure',
    async (action) => {
      const fixture = channelFixture();
      const error = new Error('ownership unavailable');
      fixture.query.mockRejectedValue(error);
      await expect(fixture.invoke(action)).rejects.toBe(error);
      expect(fixture.repository.update).not.toHaveBeenCalled();
      expect(fixture.repository.delete).not.toHaveBeenCalled();
      expect(fixture.emitter.emitCustomBatchEvent).not.toHaveBeenCalled();
    },
  );

  it.each([
    'genericUpdate',
    'genericDelete',
    'appUpdate',
    'appDelete',
  ] as const)(
    'ordinary channel %s retains mutation and deletion event behavior',
    async (action) => {
      const fixture = channelFixture();
      await expect(fixture.invoke(action)).resolves.toEqual(fixture.channel);
      const mutation = action.endsWith('Delete')
        ? fixture.repository.delete
        : fixture.repository.update;
      expect(mutation).toHaveBeenCalledTimes(1);
      expect(fixture.query.mock.invocationCallOrder[0]).toBeLessThan(
        mutation.mock.invocationCallOrder[0],
      );
      expect(fixture.emitter.emitCustomBatchEvent).toHaveBeenCalledTimes(
        action.endsWith('Delete') ? 1 : 0,
      );
    },
  );

  it.each(['appUpdate', 'appDelete'] as const)(
    'APP %s retains unreachable-account rejection before ownership lookup',
    async (action) => {
      const fixture = channelFixture();
      fixture.accounts.findOne.mockResolvedValue(null);
      await expect(fixture.invoke(action)).rejects.toThrow('not found');
      expect(fixture.query).not.toHaveBeenCalled();
      expect(fixture.repository.update).not.toHaveBeenCalled();
      expect(fixture.repository.delete).not.toHaveBeenCalled();
    },
  );

  it('APP update without changed fields preserves read-only no-op', async () => {
    const fixture = channelFixture();
    await expect(fixture.app.update(fixture.request)).resolves.toEqual(
      fixture.channel,
    );
    expect(fixture.query).not.toHaveBeenCalled();
    expect(fixture.repository.update).not.toHaveBeenCalled();
  });

  it('account update snapshots scalar fields before asynchronous ownership lookup', async () => {
    const fixture = accountFixture();
    let release!: (rows: { id: string }[]) => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fixture.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
          entered();
        }),
    );
    const data = {
      handle: 'before@example.test',
      workspaceId: fixture.workspaceId,
    };
    const pending = fixture.service.update({
      id: fixture.account.id,
      workspaceId: fixture.workspaceId,
      data,
    });
    data.handle = 'mutated@example.test';
    data.workspaceId = randomUUID();
    await reached;
    release([]);
    await pending;
    expect(fixture.repository.update).toHaveBeenCalledWith(
      { id: fixture.account.id, workspaceId: fixture.workspaceId },
      { handle: 'before@example.test', workspaceId: fixture.workspaceId },
    );
  });

  it('channel update snapshots destination fields before asynchronous ownership lookup', async () => {
    const fixture = channelFixture();
    let release!: (rows: { id: string }[]) => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fixture.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
          entered();
        }),
    );
    const data: Parameters<typeof fixture.generic.update>[0]['data'] = {
      displayName: 'Before',
    };
    const pending = fixture.generic.update({
      id: fixture.id,
      workspaceId: fixture.request.workspaceId,
      data,
    });
    data.displayName = 'Mutated';
    data.workspaceId = randomUUID();
    data.connectedAccountId = randomUUID();
    await reached;
    release([]);
    await pending;
    expect(fixture.repository.update).toHaveBeenCalledWith(
      { id: fixture.id, workspaceId: fixture.request.workspaceId },
      { displayName: 'Before' },
    );
    expect(fixture.accountMetadata.findById).not.toHaveBeenCalled();
  });

  it.each(['id', 'workspaceId'] as const)(
    'account and channel updates reject changing addressed %s',
    async (field) => {
      const account = accountFixture();
      const channel = channelFixture();
      await expect(
        account.service.update({
          id: account.account.id,
          workspaceId: account.workspaceId,
          data: { [field]: randomUUID() },
        }),
      ).rejects.toThrow('SCOPE_CHANGE');
      await expect(
        channel.generic.update({
          id: channel.id,
          workspaceId: channel.request.workspaceId,
          data: { [field]: randomUUID() },
        }),
      ).rejects.toThrow('SCOPE_CHANGE');
      expect(account.repository.update).not.toHaveBeenCalled();
      expect(channel.repository.update).not.toHaveBeenCalled();
    },
  );

  it('channel update cannot attach an ordinary channel to an omni-owned destination account', async () => {
    const fixture = channelFixture();
    const destinationId = randomUUID();
    fixture.accountMetadata.findById.mockResolvedValue({
      id: destinationId,
      workspaceId: fixture.request.workspaceId,
    });
    fixture.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: destinationId }]);
    await expect(
      fixture.generic.update({
        id: fixture.id,
        workspaceId: fixture.request.workspaceId,
        data: { connectedAccountId: destinationId },
      }),
    ).rejects.toThrow('OMNI_OWNED_ACCOUNT');
    expect(fixture.accountMetadata.findById).toHaveBeenCalledWith({
      id: destinationId,
      workspaceId: fixture.request.workspaceId,
    });
    expect(fixture.repository.update).not.toHaveBeenCalled();
  });

  it('channel update rejects destination accounts unavailable in its workspace', async () => {
    const fixture = channelFixture();
    fixture.accountMetadata.findById.mockResolvedValue(null);
    await expect(
      fixture.generic.update({
        id: fixture.id,
        workspaceId: fixture.request.workspaceId,
        data: { connectedAccountId: randomUUID() },
      }),
    ).rejects.toThrow('DESTINATION_ACCOUNT_NOT_FOUND');
    expect(fixture.repository.update).not.toHaveBeenCalled();
  });

  it('channel update still permits an ordinary destination in the same workspace', async () => {
    const fixture = channelFixture();
    const destinationId = randomUUID();
    fixture.accountMetadata.findById.mockResolvedValue({
      id: destinationId,
      workspaceId: fixture.request.workspaceId,
    });
    await fixture.generic.update({
      id: fixture.id,
      workspaceId: fixture.request.workspaceId,
      data: { connectedAccountId: destinationId },
    });
    expect(fixture.repository.update).toHaveBeenCalledWith(
      { id: fixture.id, workspaceId: fixture.request.workspaceId },
      { connectedAccountId: destinationId },
    );
    expect(fixture.query).toHaveBeenCalledTimes(2);
  });

  it('account create refuses a supplied id before TypeORM save can update an existing row', async () => {
    const fixture = accountFixture();
    await expect(
      fixture.service.create({
        id: fixture.account.id,
        workspaceId: fixture.workspaceId,
        handle: 'client@example.test',
        provider: ConnectedAccountProvider.APP,
        userWorkspaceId: fixture.account.userWorkspaceId,
      }),
    ).rejects.toThrow('CREATE_ID_FORBIDDEN');
    expect(fixture.repository.create).not.toHaveBeenCalled();
    expect(fixture.repository.save).not.toHaveBeenCalled();
  });

  it('channel create refuses a supplied id before TypeORM save can update an existing row', async () => {
    const fixture = channelFixture();
    await expect(
      fixture.generic.create({
        id: fixture.id,
        workspaceId: fixture.request.workspaceId,
        handle: 'client@example.test',
        connectedAccountId: randomUUID(),
        visibility: MessageChannelVisibility.SHARE_EVERYTHING,
        type: MessageChannelType.EMAIL_GROUP,
        syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
      }),
    ).rejects.toThrow('CREATE_ID_FORBIDDEN');
    expect(fixture.repository.create).not.toHaveBeenCalled();
    expect(fixture.repository.save).not.toHaveBeenCalled();
  });

  it('ordinary account and channel creation still delegates new id generation to persistence', async () => {
    const account = accountFixture();
    const channel = channelFixture();
    await expect(
      account.service.create({
        workspaceId: account.workspaceId,
        handle: 'client@example.test',
        provider: ConnectedAccountProvider.APP,
        userWorkspaceId: account.account.userWorkspaceId,
      }),
    ).resolves.toEqual(account.account);
    await expect(
      channel.generic.create({
        workspaceId: channel.request.workspaceId,
        handle: 'client@example.test',
        connectedAccountId: randomUUID(),
        visibility: MessageChannelVisibility.SHARE_EVERYTHING,
        type: MessageChannelType.EMAIL_GROUP,
        syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
      }),
    ).resolves.toEqual(channel.channel);
    expect(account.repository.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ id: expect.anything() }),
    );
    expect(channel.repository.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ id: expect.anything() }),
    );
    expect(account.repository.save).toHaveBeenCalledTimes(1);
    expect(channel.repository.save).toHaveBeenCalledTimes(1);
  });

  it('account update rejects relation-shaped workspace changes', async () => {
    const fixture = accountFixture();
    const data = { workspace: { id: randomUUID() } } as Parameters<
      typeof fixture.service.update
    >[0]['data'];
    await expect(
      fixture.service.update({
        id: fixture.account.id,
        workspaceId: fixture.workspaceId,
        data,
      }),
    ).rejects.toThrow('SCOPE_CHANGE');
    expect(fixture.repository.update).not.toHaveBeenCalled();
    expect(fixture.query).not.toHaveBeenCalled();
  });

  it.each(['workspace', 'connectedAccount'] as const)(
    'channel update rejects relation-shaped %s bypasses',
    async (relation) => {
      const fixture = channelFixture();
      const data = { [relation]: { id: randomUUID() } } as Parameters<
        typeof fixture.generic.update
      >[0]['data'];
      await expect(
        fixture.generic.update({
          id: fixture.id,
          workspaceId: fixture.request.workspaceId,
          data,
        }),
      ).rejects.toThrow('SCOPE_CHANGE');
      expect(fixture.repository.update).not.toHaveBeenCalled();
      expect(fixture.query).not.toHaveBeenCalled();
    },
  );
});
