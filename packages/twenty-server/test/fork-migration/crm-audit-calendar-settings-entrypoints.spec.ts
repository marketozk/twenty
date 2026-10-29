import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import {
  captureCrmAuditRequest,
  withCrmAuditRequest,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { OmniCoreTransactionOutcomeUnknownError } from 'src/modules/omnichannel/services/omni-core-transaction';
import { calendarImportCacheKey } from 'src/modules/calendar/common/utils/calendar-import-cache-key';
import {
  CalendarChannelException,
  CalendarChannelExceptionCode,
} from 'src/engine/metadata-modules/calendar-channel/calendar-channel.exception';
import { calendarChannelGraphqlApiExceptionHandler } from 'src/engine/metadata-modules/calendar-channel/utils/calendar-channel-graphql-api-exception-handler.util';

for (const [path, name] of [
  [
    'src/engine/metadata-modules/connected-account/connected-account-metadata.service',
    'ConnectedAccountMetadataService',
  ],
  [
    'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity',
    'CalendarChannelEntity',
  ],
  [
    'src/engine/metadata-modules/connected-account/entities/connected-account.entity',
    'ConnectedAccountEntity',
  ],
  [
    'src/engine/core-modules/user-workspace/user-workspace.entity',
    'UserWorkspaceEntity',
  ],
  ['src/engine/core-modules/workspace/workspace.entity', 'WorkspaceEntity'],
  [
    'src/engine/workspace-event-emitter/workspace-event-emitter',
    'WorkspaceEventEmitter',
  ],
  ['src/engine/twenty-orm/workspace-orm.manager', 'WorkspaceOrmManager'],
  [
    'src/engine/core-modules/cache-storage/services/cache-storage.service',
    'CacheStorageService',
  ],
  ['src/engine/core-modules/metrics/metrics.service', 'MetricsService'],
  [
    'src/modules/connected-account/services/accounts-to-reconnect.service',
    'AccountsToReconnectService',
  ],
  ['src/engine/guards/no-permission.guard', 'NoPermissionGuard'],
  [
    'src/engine/metadata-modules/calendar-channel/interceptors/calendar-channel-graphql-api-exception.interceptor',
    'CalendarChannelGraphqlApiExceptionInterceptor',
  ],
  [
    'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter',
    'AuthGraphqlApiExceptionFilter',
  ],
])
  jest.doMock(path, () => ({ [name]: class {} }));
jest.doMock('src/engine/guards/auth-principal.guard', () => ({
  AuthPrincipalGuard: () => class {},
}));
jest.doMock(
  'src/engine/api/graphql/graphql-config/decorators/metadata-resolver.decorator',
  () => ({ MetadataResolver: () => () => undefined }),
);
jest.doMock(
  'src/engine/core-modules/crm-audit/update-calendar-channel-settings-with-audit',
  () => ({
    ...jest.requireActual(
      'src/engine/core-modules/crm-audit/update-calendar-channel-settings-with-audit',
    ),
    updateCalendarChannelSettingsWithAudit: jest.fn(),
  }),
);

// These are the actual public resolver, metadata service, cache-only helper and
// attribution ALS. Only the terminal SQL owner and unrelated DI dependencies
// are adapters here; the owner has a separate real PostgreSQL acceptance suite.
const {
  updateCalendarChannelSettingsWithAudit: owner,
  CalendarChannelSettingsError,
} =
  require('src/engine/core-modules/crm-audit/update-calendar-channel-settings-with-audit') as {
    updateCalendarChannelSettingsWithAudit: jest.Mock;
    CalendarChannelSettingsError: typeof import('src/engine/core-modules/crm-audit/update-calendar-channel-settings-with-audit').CalendarChannelSettingsError;
  };
const { CalendarChannelMetadataService } =
  require('src/engine/metadata-modules/calendar-channel/calendar-channel-metadata.service') as typeof import('src/engine/metadata-modules/calendar-channel/calendar-channel-metadata.service');
const { CalendarChannelResolver } =
  require('src/engine/metadata-modules/calendar-channel/resolvers/calendar-channel.resolver') as typeof import('src/engine/metadata-modules/calendar-channel/resolvers/calendar-channel.resolver');
const { CalendarChannelSyncStatusService } =
  require('src/modules/calendar/common/services/calendar-channel-sync-status.service') as typeof import('src/modules/calendar/common/services/calendar-channel-sync-status.service');

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const build = () => {
  const workspaceId = randomUUID(),
    userId = randomUUID(),
    userWorkspaceId = randomUUID();
  const channelId = randomUUID(),
    accountId = randomUUID();
  const workspace = { id: workspaceId },
    user = { id: userId };
  const data = { excludePrivateEvents: true, isSyncEnabled: false };
  const caller = { userWorkspaceId, userId };
  const request = { workspace, user };
  const query = jest.fn();
  const connection = { marker: 'original-data-source' };
  const manager = {
    connection,
    query,
    queryRunner: undefined as undefined | { isTransactionActive: boolean },
  };
  const repository = { manager, update: jest.fn(), findOneOrFail: jest.fn() };
  const cache = { del: jest.fn().mockResolvedValue(undefined) };
  const status = new CalendarChannelSyncStatusService(
    {} as never,
    cache as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const flush = jest.spyOn(status, 'flushImportCache');
  const service = new CalendarChannelMetadataService(
    repository as never,
    {} as never,
    {} as never,
  );
  const verify = jest.spyOn(service, 'verifyOwnership');
  const resolver = new CalendarChannelResolver(service, status);
  const calendarChannel = {
    id: channelId,
    workspaceId,
    connectedAccountId: accountId,
    excludePrivateEvents: true,
    syncStage: 'CALENDAR_EVENTS_IMPORT_ONGOING',
    syncCursor: 'pre-reset-cursor',
    syncStageStartedAt: new Date('2026-10-28T12:00:00Z'),
  };
  const result = {
    calendarChannel,
    resetChannel: { id: channelId, connectedAccountId: accountId },
  };
  owner.mockResolvedValue(result);
  const input = { id: channelId, update: data };
  const invoke = () =>
    withCrmAuditRequest(captureCrmAuditRequest(request), () =>
      resolver.updateCalendarChannel(
        input,
        workspace as never,
        userWorkspaceId,
        user as never,
      ),
    );
  const invokeService = () =>
    withCrmAuditRequest(captureCrmAuditRequest(request), () =>
      service.update({ id: channelId, workspaceId, data, caller }),
    );
  return {
    workspaceId,
    userId,
    userWorkspaceId,
    channelId,
    accountId,
    workspace,
    user,
    request,
    data,
    caller,
    query,
    connection,
    manager,
    repository,
    cache,
    status,
    flush,
    service,
    verify,
    resolver,
    calendarChannel,
    result,
    input,
    invoke,
    invokeService,
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  owner.mockReset();
});

it('passes captured resolver primitives directly into the closed update without an ownership preflight', async () => {
  const f = build(),
    gate = deferred<never>();
  const update = jest
    .spyOn(f.service, 'update')
    .mockImplementation(() => gate.promise);
  const pending = f.invoke();
  f.input.id = randomUUID();
  f.workspace.id = randomUUID();
  f.user.id = randomUUID();
  f.data.excludePrivateEvents = false;
  expect(update).toHaveBeenCalledWith({
    id: f.channelId,
    workspaceId: f.workspaceId,
    data: { excludePrivateEvents: true, isSyncEnabled: false },
    caller: { userWorkspaceId: f.userWorkspaceId, userId: f.userId },
  });
  expect(f.verify).not.toHaveBeenCalled();
  gate.resolve({ calendarChannel: f.calendarChannel } as never);
  expect(await pending).toBe(f.calendarChannel);
});

it('captures settings, caller and trusted impersonation attribution before its first lookup await', async () => {
  const f = build(),
    impersonatorMembershipId = randomUUID(),
    impersonatorUserId = randomUUID();
  const gate = deferred<unknown[]>();
  f.query.mockReturnValue(gate.promise);
  const pending = withCrmAuditRequest(
    captureCrmAuditRequest({
      ...f.request,
      impersonationContext: {
        impersonatorUserWorkspaceId: impersonatorMembershipId,
      },
    }),
    () =>
      f.service.update({
        id: f.channelId,
        workspaceId: f.workspaceId,
        data: f.data,
        caller: f.caller,
      }),
  );
  f.data.excludePrivateEvents = false;
  f.caller.userId = randomUUID();
  f.caller.userWorkspaceId = randomUUID();
  f.user.id = randomUUID();
  gate.resolve([{ userId: impersonatorUserId }]);
  await pending;
  expect(f.query).toHaveBeenCalledWith(expect.any(String), [
    impersonatorMembershipId,
  ]);
  expect(owner).toHaveBeenCalledTimes(1);
  expect(owner).toHaveBeenCalledWith(
    expect.objectContaining({
      dataSource: f.connection,
      workspaceId: f.workspaceId,
      calendarChannelId: f.channelId,
      caller: { userWorkspaceId: f.userWorkspaceId, userId: f.userId },
      updates: { excludePrivateEvents: true, isSyncEnabled: false },
      operation: expect.objectContaining({
        workspaceId: f.workspaceId,
        actor: { kind: 'coreUser', id: f.userId },
        initiator: { kind: 'coreUser', id: impersonatorUserId },
      }),
    }),
  );
  const operation = owner.mock.calls[0][0].operation;
  expect(isUUID(operation.operationId)).toBe(true);
  expect(isUUID(operation.correlationId)).toBe(true);
});

it('returns the pre-reset DTO and flushes only the pinned current account cache key', async () => {
  const f = build();
  expect(await f.invoke()).toBe(f.calendarChannel);
  expect(f.flush).toHaveBeenCalledWith([f.result.resetChannel], f.workspaceId);
  expect(f.cache.del).toHaveBeenCalledTimes(1);
  expect(f.cache.del).toHaveBeenCalledWith(
    calendarImportCacheKey({
      workspaceId: f.workspaceId,
      calendarChannelId: f.channelId,
      connectedAccountId: f.accountId,
    }),
  );
  expect(f.calendarChannel.syncStage).toBe('CALENDAR_EVENTS_IMPORT_ONGOING');
  expect(f.calendarChannel.syncCursor).toBe('pre-reset-cursor');
  expect(f.repository.update).not.toHaveBeenCalled();
  expect(f.repository.findOneOrFail).not.toHaveBeenCalled();
  expect(f.verify).not.toHaveBeenCalled();
});

it('does not flush before the terminal owner confirms completion', async () => {
  const f = build(),
    gate = deferred<typeof f.result>(),
    entered = deferred<void>();
  owner.mockImplementation(() => {
    entered.resolve();
    return gate.promise;
  });
  const pending = f.invoke();
  await entered.promise;
  expect(f.cache.del).not.toHaveBeenCalled();
  gate.resolve(f.result);
  await pending;
  expect(f.cache.del).toHaveBeenCalledTimes(1);
});

it('does not flush when the owner reports no actual reset', async () => {
  const f = build();
  owner.mockResolvedValue({ calendarChannel: f.calendarChannel });
  expect(await f.invoke()).toBe(f.calendarChannel);
  expect(f.flush).not.toHaveBeenCalled();
  expect(f.cache.del).not.toHaveBeenCalled();
});

it.each([
  'ordinary',
  'native-unknown',
  'core-unknown',
  'known-commit',
] as const)(
  'preserves %s owner failure without cache work or retry',
  async (kind) => {
    const f = build(),
      cause = new Error('controlled owner failure');
    const failure =
      kind === 'native-unknown'
        ? new NativeTransactionOutcomeUnknownError('commit', cause)
        : kind === 'core-unknown'
          ? new OmniCoreTransactionOutcomeUnknownError(cause)
          : kind === 'known-commit'
            ? new CoreAuditPostCommitError(cause)
            : cause;
    owner.mockRejectedValue(failure);
    await expect(f.invoke()).rejects.toBe(failure);
    expect(owner).toHaveBeenCalledTimes(1);
    expect(f.cache.del).not.toHaveBeenCalled();
    expect(f.repository.update).not.toHaveBeenCalled();
  },
);

it('classifies cache failure after success as confirmed commit without invoking mutation again', async () => {
  const f = build(),
    cause = new Error('controlled cache failure');
  f.cache.del.mockRejectedValue(cause);
  const failure = await f.invoke().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(CoreAuditPostCommitError);
  expect(failure).toMatchObject({ commitConfirmed: true, cause });
  expect(owner).toHaveBeenCalledTimes(1);
  expect(f.cache.del).toHaveBeenCalledTimes(1);
  expect(f.repository.update).not.toHaveBeenCalled();
});

it('rejects unavailable audit identity instead of manufacturing a system actor', async () => {
  const f = build();
  await expect(
    f.service.update({
      id: f.channelId,
      workspaceId: f.workspaceId,
      data: f.data,
      caller: f.caller,
    }),
  ).rejects.toThrow('Calendar channel settings require audit identity');
  expect(owner).not.toHaveBeenCalled();
  expect(f.cache.del).not.toHaveBeenCalled();
});

it('rejects foreign request attribution before owner or cache effects', async () => {
  const f = build();
  await expect(
    withCrmAuditRequest(
      captureCrmAuditRequest({ ...f.request, workspace: { id: randomUUID() } }),
      () =>
        f.service.update({
          id: f.channelId,
          workspaceId: f.workspaceId,
          data: f.data,
          caller: f.caller,
        }),
    ),
  ).rejects.toThrow('CRM audit context workspace mismatch');
  expect(owner).not.toHaveBeenCalled();
  expect(f.cache.del).not.toHaveBeenCalled();
});

it('rejects an already active repository transaction before opening the closed owner', async () => {
  const f = build();
  f.manager.queryRunner = { isTransactionActive: true };
  await expect(f.invoke()).rejects.toThrow(
    'OMNI_METADATA_REQUIRES_FRESH_TRANSACTION',
  );
  expect(owner).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
  expect(f.cache.del).not.toHaveBeenCalled();
});

it('does not silently drop an unsupported settings field before owner validation', async () => {
  const f = build(),
    invalid = { ...f.data, connectedAccountId: randomUUID() };
  const failure = new Error('invalid settings command');
  owner.mockRejectedValue(failure);
  await expect(
    withCrmAuditRequest(captureCrmAuditRequest(f.request), () =>
      f.service.update({
        id: f.channelId,
        workspaceId: f.workspaceId,
        data: invalid,
        caller: f.caller,
      }),
    ),
  ).rejects.toBe(failure);
  expect(owner.mock.calls[0][0].updates).toEqual(invalid);
  expect(f.cache.del).not.toHaveBeenCalled();
});

it('captures every cache key before waiting for the first deletion', async () => {
  const f = build(),
    gate = deferred<void>();
  const channels = [
    { id: randomUUID(), connectedAccountId: randomUUID() },
    { id: randomUUID(), connectedAccountId: randomUUID() },
  ];
  const captured = channels.map((channel) => ({ ...channel }));
  f.cache.del.mockImplementationOnce(() => gate.promise);
  const pending = f.status.flushImportCache(channels, f.workspaceId);
  channels[1].id = randomUUID();
  channels[1].connectedAccountId = randomUUID();
  channels.push(channels[0]);
  gate.resolve();
  await pending;
  expect(f.cache.del.mock.calls.map(([key]) => key)).toEqual(
    captured.map(({ id, connectedAccountId }) =>
      calendarImportCacheKey({
        workspaceId: f.workspaceId,
        calendarChannelId: id,
        connectedAccountId,
      }),
    ),
  );
});

it('propagates the cache-only helper failure without attempting later keys', async () => {
  const f = build(),
    failure = new Error('cache unavailable');
  f.cache.del.mockRejectedValue(failure);
  await expect(
    f.status.flushImportCache(
      [
        { id: f.channelId, connectedAccountId: f.accountId },
        { id: randomUUID(), connectedAccountId: randomUUID() },
      ],
      f.workspaceId,
    ),
  ).rejects.toBe(failure);
  expect(f.cache.del).toHaveBeenCalledTimes(1);
});

it.each([
  [CalendarChannelExceptionCode.CALENDAR_CHANNEL_NOT_FOUND, 'NOT_FOUND'],
  [
    CalendarChannelExceptionCode.CALENDAR_CHANNEL_OWNERSHIP_VIOLATION,
    'FORBIDDEN',
  ],
  [
    CalendarChannelExceptionCode.INVALID_CALENDAR_CHANNEL_INPUT,
    'BAD_USER_INPUT',
  ],
] as const)(
  'preserves domain error %s through the service and maps its public GraphQL code',
  async (code, graphqlCode) => {
    const f = build();
    const failure = new CalendarChannelSettingsError(
      'controlled calendar failure',
      code,
    );
    owner.mockRejectedValue(failure);
    const propagated = await f.invoke().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(propagated).toBeInstanceOf(CalendarChannelException);
    expect(propagated).toMatchObject({ message: failure.message, code });
    let mapped: unknown;
    try {
      calendarChannelGraphqlApiExceptionHandler(propagated as Error);
    } catch (error) {
      mapped = error;
    }
    expect(mapped).toMatchObject({
      message: 'controlled calendar failure',
      extensions: {
        code: graphqlCode,
        subCode: code,
        userFriendlyMessage: (propagated as CalendarChannelException)
          .userFriendlyMessage,
      },
    });
    expect(owner).toHaveBeenCalledTimes(1);
    expect(f.cache.del).not.toHaveBeenCalled();
    expect(f.repository.update).not.toHaveBeenCalled();
  },
);

it.each(['native-unknown', 'core-unknown', 'known-commit'] as const)(
  'preserves the exact unsafe %s instance through service and the actual public error handler',
  async (kind) => {
    const f = build(),
      cause = new Error('controlled transaction outcome');
    const failure =
      kind === 'native-unknown'
        ? new NativeTransactionOutcomeUnknownError('commit', cause)
        : kind === 'core-unknown'
          ? new OmniCoreTransactionOutcomeUnknownError(cause)
          : new CoreAuditPostCommitError(cause);
    owner.mockRejectedValue(failure);
    const propagated = await f.invoke().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(propagated).toBe(failure);
    let mapped: unknown;
    try {
      calendarChannelGraphqlApiExceptionHandler(propagated as Error);
    } catch (error) {
      mapped = error;
    }
    expect(mapped).toBe(failure);
    expect(owner).toHaveBeenCalledTimes(1);
    expect(f.cache.del).not.toHaveBeenCalled();
    expect(f.repository.update).not.toHaveBeenCalled();
  },
);
