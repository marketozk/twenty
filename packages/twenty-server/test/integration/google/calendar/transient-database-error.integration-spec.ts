import { randomUUID } from 'node:crypto';

import {
  CalendarChannelSyncStage,
  CalendarChannelSyncStatus,
  ConnectedAccountProvider,
} from 'twenty-shared/types';

import { POSTGRESQL_ERROR_CODES } from 'src/engine/api/graphql/workspace-query-runner/constants/postgres-error-codes.constants';
import {
  type WorkspaceTransactionScope,
  type WorkspaceTransactionOptions,
} from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { CalendarEventParticipantService } from 'src/modules/calendar/calendar-event-participant-manager/services/calendar-event-participant.service';

import { googleCalendarEvent } from 'test/integration/google/mocks/google-calendar-event.util';
import { setupGoogleMock } from 'test/integration/google/mocks/setup-google-mock.util';
import { connectMessagingAccount } from 'test/integration/utils/connect-messaging-account.util';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import { raiseSqlState } from 'test/integration/utils/raise-sql-state.util';
import { readBackendState } from 'test/integration/utils/read-backend-state.util';
import { queryCalendarChannel } from 'test/integration/utils/query-messaging.util';
import { resetCalendarChannelSyncState } from 'test/integration/utils/reset-channel-sync-state.util';
import { runCalendarChannelEventsImport } from 'test/integration/utils/run-calendar-channel-events-import.util';
import { runCalendarChannelListFetch } from 'test/integration/utils/run-calendar-channel-list-fetch.util';

const HANDLE = 'calendar-transient-database-error@apple.dev';

// The error has to be raised by Postgres itself: an Error built in the jest
// realm is not an `instanceof Error` for the application realm the app runs in.
describe('Calendar import transient database errors (integration)', () => {
  const google = setupGoogleMock({ handle: HANDLE });

  let channel: Awaited<ReturnType<typeof connectMessagingAccount>>;
  let calendarEventParticipantService: CalendarEventParticipantService;
  let workspaceOrmManager: WorkspaceOrmManager;

  type ParticipantWrite = 'insert' | 'updateMany' | 'delete';
  type ParticipantWriter = Record<
    ParticipantWrite,
    (...args: unknown[]) => Promise<unknown>
  >;
  const observeParticipantWrites = (
    observe: (
      scope: WorkspaceTransactionScope,
      phase: ParticipantWrite,
      records: unknown,
    ) => Promise<void>,
  ) => {
    let observedSaveScope: WorkspaceTransactionScope | undefined;
    const transaction =
      workspaceOrmManager.runInWorkspaceTransaction.bind(workspaceOrmManager);
    jest
      .spyOn(workspaceOrmManager, 'runInWorkspaceTransaction')
      .mockImplementation(((
        work: (scope: WorkspaceTransactionScope) => Promise<unknown>,
        options?: WorkspaceTransactionOptions,
      ) =>
        transaction(async (scope) => {
          // Both save and postcommit matching use strict/exclusive transactions.
          // Inject only into the first participant-writing scope (the save).
          if (
            options?.commitOutcome === 'strict' &&
            options.nativeOwnershipLock === 'exclusive'
          ) {
            const getRepository = scope.getRepository.bind(scope);
            const instrumented = new WeakSet<object>();
            scope.getRepository = ((
              ...args: Parameters<WorkspaceTransactionScope['getRepository']>
            ) => {
              const repository = getRepository(...args);
              if (
                args[0] === 'calendarEventParticipant' &&
                !instrumented.has(repository)
              ) {
                instrumented.add(repository);
                const writer = repository as unknown as ParticipantWriter;
                for (const phase of [
                  'insert',
                  'updateMany',
                  'delete',
                ] as const) {
                  const perform = writer[phase].bind(writer);
                  jest
                    .spyOn(writer, phase)
                    .mockImplementation(async (...values: unknown[]) => {
                      observedSaveScope ??= scope;
                      if (scope === observedSaveScope)
                        await observe(scope, phase, values[0]);
                      return perform(...values);
                    });
                }
              }
              return repository;
            }) as WorkspaceTransactionScope['getRepository'];
          }
          return work(scope);
        }, options)) as typeof workspaceOrmManager.runInWorkspaceTransaction);
  };

  const fetchEvent = async ({
    eventId,
    title,
    attendees,
  }: {
    eventId: string;
    title: string;
    attendees: string[];
  }): Promise<void> => {
    google.serveCalendarEvents(
      [
        googleCalendarEvent({
          id: eventId,
          summary: title,
          attendees: attendees.map((email) => ({ email })),
        }),
      ],
      { nextSyncToken: `sync-token-${randomUUID()}` },
    );

    await resetCalendarChannelSyncState(channel.calendarChannelId, '');
    await runCalendarChannelListFetch(channel.calendarChannelId);
  };

  const fetchOneEvent = async (): Promise<void> => {
    await fetchEvent({
      eventId: `google-calendar-event-${randomUUID()}`,
      title: `Calendar event ${randomUUID()}`,
      attendees: [`attendee-${randomUUID()}@acme.com`],
    });
  };

  beforeAll(async () => {
    channel = await connectMessagingAccount({
      provider: ConnectedAccountProvider.GOOGLE,
      handle: HANDLE,
    });

    calendarEventParticipantService =
      getAppProviderByClassName<CalendarEventParticipantService>(
        'CalendarEventParticipantService',
      );
    workspaceOrmManager = getAppProviderByClassName<WorkspaceOrmManager>(
      'WorkspaceOrmManager',
    );
  }, 60000);

  afterAll(async () => {
    await channel?.cleanup().catch(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should fail the calendar channel as unknown when a unique violation aborts the import transaction', async () => {
    await fetchOneEvent();

    let injected = 0;
    observeParticipantWrites(async (scope) => {
      injected++;
      await scope.executeRawQuery(
        raiseSqlState(POSTGRESQL_ERROR_CODES.UNIQUE_VIOLATION),
      );
    });

    await runCalendarChannelEventsImport(channel.calendarChannelId);

    expect(injected).toBe(1);

    const channelState = await queryCalendarChannel(channel);

    expect(channelState.syncStatus).toBe(
      CalendarChannelSyncStatus.FAILED_UNKNOWN,
    );
    expect(channelState.syncStage).toBe(CalendarChannelSyncStage.FAILED);
    expect(channelState.throttleFailureCount).toBe(0);
  }, 120000);

  it('should reschedule the calendar channel when the import transaction is killed by the idle-in-transaction timeout', async () => {
    await fetchOneEvent();

    let injected = 0;
    observeParticipantWrites(async (scope) => {
      injected++;
      await scope.executeRawQuery(
        raiseSqlState(
          POSTGRESQL_ERROR_CODES.IDLE_IN_TRANSACTION_SESSION_TIMEOUT,
        ),
      );
    });

    await runCalendarChannelEventsImport(channel.calendarChannelId);

    expect(injected).toBe(1);

    const channelState = await queryCalendarChannel(channel);

    expect(channelState.throttleFailureCount).toBe(1);
    expect(channelState.syncStage).toBe(
      CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_PENDING,
    );
    expect(channelState.syncStatus).toBe(CalendarChannelSyncStatus.ONGOING);
  }, 120000);

  it('should have ended the import transaction before the contact creation job is enqueued and the participants are matched', async () => {
    await fetchOneEvent();

    const matchParticipantsAndEnqueueContactCreationJob =
      calendarEventParticipantService.matchParticipantsAndEnqueueContactCreationJob.bind(
        calendarEventParticipantService,
      );

    let importBackendPid: number | undefined;
    let importBackendStateWhileMatching: string | undefined;

    observeParticipantWrites(async (scope) => {
      const backends = await scope.executeRawQuery(
        'SELECT pg_backend_pid() AS pid',
      );
      importBackendPid = Number(backends[0].pid);
    });

    jest
      .spyOn(
        calendarEventParticipantService,
        'matchParticipantsAndEnqueueContactCreationJob',
      )
      .mockImplementation(async (args) => {
        importBackendStateWhileMatching = await readBackendState(
          importBackendPid ?? 0,
        );

        return matchParticipantsAndEnqueueContactCreationJob(args);
      });

    await runCalendarChannelEventsImport(channel.calendarChannelId);

    expect(importBackendPid).toEqual(expect.any(Number));
    expect(importBackendStateWhileMatching).toBeDefined();
    expect(importBackendStateWhileMatching).not.toBe('idle in transaction');
  }, 120000);

  it('should return only the newly saved participants without appending to the caller participant list when an existing event gains an attendee', async () => {
    const eventId = `google-calendar-event-${randomUUID()}`;
    const title = `Calendar event ${randomUUID()}`;
    const knownAttendee = `attendee-known-${randomUUID()}@acme.com`;
    const newAttendee = `attendee-new-${randomUUID()}@acme.com`;

    await fetchEvent({ eventId, title, attendees: [knownAttendee] });
    await runCalendarChannelEventsImport(channel.calendarChannelId);

    await fetchEvent({
      eventId,
      title,
      attendees: [knownAttendee, newAttendee],
    });

    let insertedHandles: string[] = [];
    let updatedParticipantCount = 0;

    observeParticipantWrites(async (_scope, phase, records) => {
      if (phase === 'insert')
        insertedHandles.push(
          ...(records as { handle: string }[]).map(({ handle }) => handle),
        );
      if (phase === 'updateMany')
        updatedParticipantCount += (records as unknown[]).length;
    });

    await runCalendarChannelEventsImport(channel.calendarChannelId);

    expect(insertedHandles).toEqual([newAttendee]);
    expect(updatedParticipantCount).toBe(0);
  }, 180000);

  it('should read and write inside the locked transaction before postcommit matching', async () => {
    await fetchOneEvent();

    const calls: string[] = [];

    const findCalendarEventParticipantsByCalendarEventIds =
      calendarEventParticipantService.findCalendarEventParticipantsByCalendarEventIds.bind(
        calendarEventParticipantService,
      );
    const matchParticipantsAndEnqueueContactCreationJob =
      calendarEventParticipantService.matchParticipantsAndEnqueueContactCreationJob.bind(
        calendarEventParticipantService,
      );

    jest
      .spyOn(
        calendarEventParticipantService,
        'findCalendarEventParticipantsByCalendarEventIds',
      )
      .mockImplementation(async (args) => {
        expect(
          args.transactionScope?.transactionLifecycle?.isTransactionActive,
        ).toBe(true);
        calls.push('read');

        return findCalendarEventParticipantsByCalendarEventIds(args);
      });

    observeParticipantWrites(async (scope) => {
      expect(scope.transactionLifecycle?.isTransactionActive).toBe(true);
      calls.push('write');
    });

    jest
      .spyOn(
        calendarEventParticipantService,
        'matchParticipantsAndEnqueueContactCreationJob',
      )
      .mockImplementation(async (args) => {
        calls.push('match');

        return matchParticipantsAndEnqueueContactCreationJob(args);
      });

    await runCalendarChannelEventsImport(channel.calendarChannelId);

    expect(calls).toEqual(['read', 'write', 'match']);
  }, 120000);
});
