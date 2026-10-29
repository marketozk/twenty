import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { OmniCoreTransactionOutcomeUnknownError } from 'src/modules/omnichannel/services/omni-core-transaction';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';

for (const [path, name] of [
  ['src/engine/twenty-orm/workspace-orm.manager', 'WorkspaceOrmManager'],
  [
    'src/engine/core-modules/cache-storage/services/cache-storage.service',
    'CacheStorageService',
  ],
  [
    'src/engine/core-modules/exception-handler/exception-handler.service',
    'ExceptionHandlerService',
  ],
  [
    'src/engine/core-modules/user-workspace/user-workspace.entity',
    'UserWorkspaceEntity',
  ],
  [
    'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity',
    'CalendarChannelEntity',
  ],
  [
    'src/modules/blocklist/repositories/blocklist.repository',
    'BlocklistRepository',
  ],
  [
    'src/modules/calendar/common/services/calendar-channel-sync-status.service',
    'CalendarChannelSyncStatusService',
  ],
  [
    'src/modules/calendar/calendar-event-import-manager/services/calendar-get-events.service',
    'CalendarGetCalendarEventsService',
  ],
  [
    'src/modules/calendar/calendar-event-import-manager/services/calendar-import-events.service',
    'CalendarImportEventsService',
  ],
  [
    'src/modules/calendar/calendar-event-import-manager/services/calendar-save-events.service',
    'CalendarSaveEventsService',
  ],
  [
    'src/modules/connected-account/email-alias-manager/services/email-alias-manager.service',
    'EmailAliasManagerService',
  ],
])
  jest.doMock(path, () => ({ [name]: class {} }));
jest.doMock(
  'src/engine/core-modules/crm-audit/delete-ordinary-sync-calendar-associations-with-audit',
  () => ({
    deleteOrdinarySyncCalendarAssociationsWithAudit: jest.fn(),
  }),
);
jest.doMock(
  'src/engine/core-modules/crm-audit/delete-native-calendar-channel-associations-with-audit',
  () => ({
    deleteNativeCalendarChannelAssociationsWithAudit: jest.fn(),
  }),
);
jest.doMock(
  'src/engine/core-modules/crm-audit/clean-workspace-native-calendar-events-with-audit',
  () => ({
    cleanWorkspaceNativeCalendarEventsWithAudit: jest.fn(),
  }),
);

// Consumer, cleaner, classifier and filtering implementations remain real.
// Only the terminal SQL owner is replaced at this entry boundary; its actual
// PostgreSQL behavior is covered by the separate calendar sync owner suite.
const { deleteOrdinarySyncCalendarAssociationsWithAudit: syncOwner } =
  require('src/engine/core-modules/crm-audit/delete-ordinary-sync-calendar-associations-with-audit') as {
    deleteOrdinarySyncCalendarAssociationsWithAudit: jest.Mock;
  };
const { CalendarEventCleanerService } =
  require('src/modules/calendar/calendar-event-cleaner/services/calendar-event-cleaner.service') as typeof import('src/modules/calendar/calendar-event-cleaner/services/calendar-event-cleaner.service');
const { CalendarFetchEventsService } =
  require('src/modules/calendar/calendar-event-import-manager/services/calendar-fetch-events.service') as typeof import('src/modules/calendar/calendar-event-import-manager/services/calendar-fetch-events.service');
const { CalendarEventsImportService } =
  require('src/modules/calendar/calendar-event-import-manager/services/calendar-events-import.service') as typeof import('src/modules/calendar/calendar-event-import-manager/services/calendar-events-import.service');
const { CalendarEventImportErrorHandlerService, CalendarEventImportSyncStep } =
  require('src/modules/calendar/calendar-event-import-manager/services/calendar-event-import-exception-handler.service') as typeof import('src/modules/calendar/calendar-event-import-manager/services/calendar-event-import-exception-handler.service');

type Kind = 'fetch' | 'import';
const fixture = (kind: Kind = 'fetch') => {
  const workspaceId = randomUUID(),
    channelId = randomUUID(),
    accountId = randomUUID();
  const account = {
    id: accountId,
    userWorkspaceId: randomUUID(),
    handleAliases: [],
  };
  const channel = {
    id: channelId,
    connectedAccountId: accountId,
    connectedAccount: account,
    handle: 'operator@example.test',
    syncCursor: 'old-cursor',
    excludePrivateEvents: false,
  };
  const run: OrdinaryMetadataSyncRun = {
    workspaceId,
    channelId,
    connectedAccountId: accountId,
    kind: 'calendar',
    stage:
      kind === 'fetch'
        ? 'CALENDAR_EVENT_LIST_FETCH_ONGOING'
        : 'CALENDAR_EVENTS_IMPORT_ONGOING',
    startedAt: '2026-10-28T00:00:00.123456Z',
  };
  const admitted = { channel, run };
  const status = {
    beginCalendarListFetch: jest.fn().mockResolvedValue(admitted),
    beginCalendarEventsImport: jest.fn().mockResolvedValue(admitted),
    recoverLegacyCalendarImport: jest.fn().mockResolvedValue(false),
    finishCalendarListFetch: jest.fn().mockResolvedValue(true),
    markAsCalendarEventSyncCompleted: jest.fn(),
    markAsCalendarEventsImportPending: jest.fn(),
    markAsFailedUnknownAndFlushCalendarEventsToImport: jest.fn(),
    markAsFailedInsufficientPermissionsAndFlushCalendarEventsToImport:
      jest.fn(),
    resetAndMarkAsCalendarEventListFetchPending: jest.fn(),
    recordTemporaryFailure: jest.fn(),
  };
  const cache = {
    setPop: jest.fn().mockResolvedValue(['removed']),
    setAdd: jest.fn(),
    del: jest.fn(),
  };
  const scope = { workspaceId };
  const enter = jest.fn(
    async (work: () => Promise<unknown>, _auth?: unknown, _options?: unknown) =>
      work(),
  );
  const transaction = jest.fn(
    async (
      work: (scope: { workspaceId: string }) => Promise<unknown>,
      _options?: unknown,
    ) => work(scope),
  );
  const manager = {
    getWorkspaceId: () => workspaceId,
    executeInWorkspaceContext: enter,
    runInWorkspaceTransaction: transaction,
    getRepository: jest.fn(() => ({ findOne: async () => null })),
  };
  const cleaner = new CalendarEventCleanerService(manager as never);
  const capture = jest.fn();
  const handler = new CalendarEventImportErrorHandlerService(
    status as never,
    { captureExceptions: capture } as never,
  );
  const handleException = jest.spyOn(handler, 'handleDriverException');
  const provider = jest.fn().mockResolvedValue(
    kind === 'fetch'
      ? {
          calendarEventIds: ['incoming'],
          calendarEventIdsToDelete: ['removed'],
          nextSyncCursor: 'next-cursor',
        }
      : [{ id: 'removed', isCanceled: true, participants: [] }],
  );
  const save = jest.fn().mockResolvedValue({ applied: true });
  const fetch = new CalendarFetchEventsService(
    cache as never,
    manager as never,
    {} as never,
    status as never,
    { getCalendarEvents: provider } as never,
    handler,
    cleaner,
  );
  const importer = new CalendarEventsImportService(
    cache as never,
    manager as never,
    { getEntriesApplicableToWorkspaceMember: async () => [] } as never,
    cleaner,
    status as never,
    { saveCalendarEventsAndEnqueueContactCreationJob: save } as never,
    handler,
    { getCalendarEvents: provider } as never,
    { refreshHandleAliases: jest.fn() } as never,
    { findOne: async () => null } as never,
  );
  const invoke = () =>
    kind === 'fetch'
      ? fetch.fetchCalendarEvents(
          channel as never,
          account as never,
          workspaceId,
        )
      : importer.processCalendarEventsImport(
          channel as never,
          account as never,
          workspaceId,
        );
  const operation: CrmAuditOperation = {
    workspaceId,
    operationId: randomUUID(),
    actor: { kind: 'system', id: 'CalendarFetchEventsService' },
    correlationId: randomUUID(),
  };
  return {
    workspaceId,
    channelId,
    accountId,
    account,
    channel,
    run,
    admitted,
    status,
    cache,
    scope,
    enter,
    transaction,
    manager,
    cleaner,
    handler,
    handleException,
    capture,
    provider,
    save,
    invoke,
    operation,
  };
};
const expectNoFailureWrites = (f: ReturnType<typeof fixture>) => {
  expect(
    f.status.markAsFailedUnknownAndFlushCalendarEventsToImport,
  ).not.toHaveBeenCalled();
  expect(
    f.status.markAsFailedInsufficientPermissionsAndFlushCalendarEventsToImport,
  ).not.toHaveBeenCalled();
  expect(
    f.status.resetAndMarkAsCalendarEventListFetchPending,
  ).not.toHaveBeenCalled();
  expect(f.status.recordTemporaryFailure).not.toHaveBeenCalled();
  expect(f.capture).not.toHaveBeenCalled();
  expect(f.cache.del).not.toHaveBeenCalled();
};
const unsafeErrors = () => [
  new NativeTransactionOutcomeUnknownError('commit', new Error('lost ack')),
  new OmniCoreTransactionOutcomeUnknownError(new Error('lost core ack')),
  new CoreAuditPostCommitError(new Error('confirmed commit hook failure')),
];
beforeEach(() => {
  syncOwner.mockReset().mockResolvedValue(true);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it('actual cleaner pins inputs and returns the owner boolean through strict exclusive scope', async () => {
  const f = fixture();
  let release!: () => Promise<void>;
  f.enter.mockImplementationOnce(
    (work) =>
      new Promise<unknown>((resolve, reject) => {
        release = async () => {
          try {
            resolve(await work());
          } catch (error) {
            reject(error);
          }
        };
      }),
  );
  const input = {
    workspaceId: f.workspaceId,
    calendarChannelId: f.channelId,
    eventExternalIds: ['removed'],
    expectedRun: { ...f.run },
    auditOperation: f.operation,
  };
  const expectedOperation = { ...f.operation, actor: { ...f.operation.actor } };
  const pending =
    f.cleaner.deleteCalendarChannelEventAssociationsAndRelatedOrphans(input);
  input.eventExternalIds.push('forged');
  input.expectedRun.startedAt = '2000-01-01T00:00:00.000001Z';
  input.auditOperation.actor = { kind: 'system', id: 'mutated' };
  await release();
  expect(await pending).toBe(true);
  expect(syncOwner).toHaveBeenCalledWith({
    scope: f.scope,
    operation: expectedOperation,
    expectedRun: f.run,
    eventExternalIds: ['removed'],
  });
  expect(f.transaction.mock.calls[0][1]).toEqual({
    commitOutcome: 'strict',
    nativeOwnershipLock: 'exclusive',
  });
});

it.each(['missing-operation', 'foreign-operation', 'foreign-run'] as const)(
  'actual cleaner refuses %s before entering a transaction',
  async (reason) => {
    const f = fixture();
    await expect(
      f.cleaner.deleteCalendarChannelEventAssociationsAndRelatedOrphans({
        workspaceId: f.workspaceId,
        calendarChannelId: f.channelId,
        eventExternalIds: ['removed'],
        expectedRun:
          reason === 'foreign-run'
            ? { ...f.run, channelId: randomUUID() }
            : f.run,
        auditOperation:
          reason === 'missing-operation'
            ? (undefined as never)
            : reason === 'foreign-operation'
              ? { ...f.operation, workspaceId: randomUUID() }
              : f.operation,
      }),
    ).rejects.toThrow();
    expect(f.transaction).not.toHaveBeenCalled();
    expect(syncOwner).not.toHaveBeenCalled();
  },
);

for (const kind of ['fetch', 'import'] as const) {
  it(
    kind +
      ' sends captured proof and its own system attribution through the actual cleaner',
    async () => {
      const f = fixture(kind),
        originalRun = { ...f.run };
      const response =
        kind === 'fetch'
          ? {
              calendarEventIds: ['incoming'],
              calendarEventIdsToDelete: ['removed'],
              nextSyncCursor: 'next-cursor',
            }
          : [{ id: 'removed', isCanceled: true, participants: [] }];
      f.provider.mockImplementationOnce(async () => {
        (f.run as { startedAt: string }).startedAt =
          '2000-01-01T00:00:00.000001Z';
        return response;
      });
      await f.invoke();
      const called = syncOwner.mock.calls[0][0];
      expect(called.expectedRun).toEqual(originalRun);
      expect(called.eventExternalIds).toEqual(['removed']);
      expect(called.operation).toMatchObject({
        workspaceId: f.workspaceId,
        actor: {
          kind: 'system',
          id:
            kind === 'fetch'
              ? 'CalendarFetchEventsService'
              : 'CalendarEventsImportService',
        },
      });
      expect(called.operation.initiator).toBeUndefined();
      expect(isUUID(called.operation.operationId)).toBe(true);
      expect(isUUID(called.operation.correlationId)).toBe(true);
      expect(f.transaction.mock.calls[0][1]).toEqual({
        commitOutcome: 'strict',
        nativeOwnershipLock: 'exclusive',
      });
    },
  );

  it(
    kind + ' accepts true with no effects and advances only after cleanup',
    async () => {
      const f = fixture(kind);
      syncOwner.mockResolvedValueOnce(true);
      const result = await f.invoke();
      expect(result).toBe(kind === 'fetch' ? true : undefined);
      expect(syncOwner).toHaveBeenCalledTimes(1);
      if (kind === 'fetch') {
        expect(f.cache.setAdd).toHaveBeenCalledTimes(1);
        expect(f.status.finishCalendarListFetch).toHaveBeenCalledWith(
          f.run,
          'next-cursor',
          true,
        );
        expect(syncOwner.mock.invocationCallOrder[0]).toBeLessThan(
          f.cache.setAdd.mock.invocationCallOrder[0],
        );
      } else {
        expect(f.cache.setPop).toHaveBeenCalledTimes(1);
        expect(f.status.markAsCalendarEventSyncCompleted).toHaveBeenCalledWith(
          [f.channelId],
          f.workspaceId,
          f.run,
        );
        expect(syncOwner.mock.invocationCallOrder[0]).toBeLessThan(
          f.status.markAsCalendarEventSyncCompleted.mock.invocationCallOrder[0],
        );
      }
      expectNoFailureWrites(f);
    },
  );

  it(
    kind + ' false cleanup stops every later cursor/cache/status transition',
    async () => {
      const f = fixture(kind);
      syncOwner.mockResolvedValueOnce(false);
      const result = await f.invoke();
      expect(result).toBe(kind === 'fetch' ? false : undefined);
      expect(f.cache.setAdd).not.toHaveBeenCalled();
      expect(f.status.finishCalendarListFetch).not.toHaveBeenCalled();
      expect(f.status.markAsCalendarEventSyncCompleted).not.toHaveBeenCalled();
      expect(f.status.markAsCalendarEventsImportPending).not.toHaveBeenCalled();
      expect(f.handleException).not.toHaveBeenCalled();
      expectNoFailureWrites(f);
      // Import already popped its batch before provider/cleanup. No rollback of that cache operation is claimed.
      expect(f.cache.setPop).toHaveBeenCalledTimes(kind === 'import' ? 1 : 0);
    },
  );

  it.each(unsafeErrors())(
    kind +
      ' preserves unsafe cleanup failure before logger/classifier and never advances or retries: %s',
    async (error) => {
      const f = fixture(kind);
      syncOwner.mockRejectedValueOnce(error);
      const errorLog = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => {
          throw new Error('logger must not replace transaction outcome');
        });
      f.capture.mockImplementation(() => {
        throw new Error('capture must not replace transaction outcome');
      });
      await expect(f.invoke()).rejects.toBe(error);
      expect(syncOwner).toHaveBeenCalledTimes(1);
      expect(f.provider).toHaveBeenCalledTimes(1);
      expect(f.transaction).toHaveBeenCalledTimes(1);
      expect(f.handleException).not.toHaveBeenCalled();
      expect(errorLog).not.toHaveBeenCalled();
      expect(f.cache.setAdd).not.toHaveBeenCalled();
      expect(f.status.finishCalendarListFetch).not.toHaveBeenCalled();
      expect(f.status.markAsCalendarEventSyncCompleted).not.toHaveBeenCalled();
      expect(f.status.markAsCalendarEventsImportPending).not.toHaveBeenCalled();
      expectNoFailureWrites(f);
      expect(f.cache.setPop).toHaveBeenCalledTimes(kind === 'import' ? 1 : 0);
    },
  );
}

it.each(unsafeErrors())(
  'actual central classifier preserves unsafe error without any failure/reset/logging effects: %s',
  async (error) => {
    const f = fixture();
    const errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {
        throw new Error('must not log unsafe transaction outcomes here');
      });
    f.capture.mockImplementation(() => {
      throw new Error('must not capture or wrap unsafe outcomes');
    });
    await expect(
      f.handler.handleDriverException(
        error,
        CalendarEventImportSyncStep.CALENDAR_EVENTS_IMPORT,
        { ...f.channel, throttleFailureCount: 0 },
        f.workspaceId,
        f.run,
      ),
    ).rejects.toBe(error);
    expect(errorLog).not.toHaveBeenCalled();
    expectNoFailureWrites(f);
  },
);
