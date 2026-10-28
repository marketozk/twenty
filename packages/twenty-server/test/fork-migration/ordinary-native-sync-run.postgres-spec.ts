import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import {
  ConnectedAccountProvider,
  MessageChannelType,
  MessageChannelSyncStage,
  CalendarChannelSyncStage,
  MessageParticipantRole,
  MessageChannelContactAutoCreationPolicy,
} from 'twenty-shared/types';
import { type ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { type MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { type CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import {
  type WorkspaceTransactionScope,
  type WorkspaceTransactionOptions,
} from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { MessagingSaveMessagesAndEnqueueContactCreationService } from 'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service';
import { MessagingMessageService } from 'src/modules/messaging/message-import-manager/services/messaging-message.service';
import { MessagingMessageParticipantService } from 'src/modules/messaging/message-participant-manager/services/messaging-message-participant.service';
import { MessagingMessageFolderAssociationService } from 'src/modules/messaging/message-import-manager/services/messaging-message-folder-association.service';
import { type MessageWithParticipants } from 'src/modules/messaging/message-import-manager/types/message.type';
import { MessageDirection } from 'src/modules/messaging/common/enums/message-direction.enum';
import { CalendarSaveEventsService } from 'src/modules/calendar/calendar-event-import-manager/services/calendar-save-events.service';
import { CalendarEventParticipantService } from 'src/modules/calendar/calendar-event-participant-manager/services/calendar-event-participant.service';
import { type FetchedCalendarEvent } from 'src/modules/calendar/common/types/fetched-calendar-event.type';
import { lockOrdinaryNativeSyncRun } from 'src/modules/omnichannel/services/lock-ordinary-native-sync-run';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
import { bootstrapOmniAccountBinding } from 'src/modules/omnichannel/services/omni-binding-bootstrap';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';

jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock('src/modules/match-participant/match-participant.service', () => ({
  MatchParticipantService: class {},
}));
jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity',
  () => ({ CalendarChannelEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/feature-flag/services/feature-flag.service',
  () => ({ FeatureFlagService: class {} }),
);
jest.mock(
  'src/engine/core-modules/message-queue/services/message-queue.service',
  () => ({ MessageQueueService: class {} }),
);
jest.mock(
  'src/modules/contact-creation-manager/jobs/create-company-and-contact.job',
  () => ({ CreateCompanyAndContactJob: class {} }),
);

const fixture = createOmniNativeMessageFixture({
  additionalTables: [
    'calendarEvent',
    'calendarEventParticipant',
    'calendarChannelEventAssociation',
    'messageChannelMessageAssociationMessageFolder',
  ],
});
const metadata = new DataSource({
  type: 'postgres',
  url: fixture.runtimeDatabaseUrl,
  extra: { max: 2, statement_timeout: 10000 },
});
const manager = {
  executeInWorkspaceContext: async <T>(work: () => Promise<T>) =>
    fixture.withContext(work),
  runInWorkspaceTransaction: async <T>(
    work: (scope: WorkspaceTransactionScope) => Promise<T>,
    options?: WorkspaceTransactionOptions,
  ) => fixture.dataSource.transaction(work, options),
  getRepository: () => {
    throw new Error('NATIVE_READ_ESCAPED_TRANSACTION');
  },
} as unknown as WorkspaceOrmManager;
const makeService = <T extends object>(prototype: T, deps: object): T =>
  Object.assign(Object.create(prototype), deps);
let account: ConnectedAccountEntity,
  messageChannel: MessageChannelEntity,
  calendarChannel: CalendarChannelEntity,
  folder: string;
let messages: MessagingSaveMessagesAndEnqueueContactCreationService,
  calendar: CalendarSaveEventsService;
let messageParticipants: MessagingMessageParticipantService,
  calendarParticipants: CalendarEventParticipantService;
let contacts: { add: jest.Mock },
  matchMessages: jest.SpyInstance,
  matchCalendar: jest.SpyInstance;
const startedAt = '2030-01-01T00:00:00.123456Z';
const run = (kind: 'message' | 'calendar'): OrdinaryMetadataSyncRun => ({
  workspaceId: fixture.workspaceId,
  channelId: kind === 'message' ? messageChannel.id : calendarChannel.id,
  connectedAccountId: account.id,
  kind,
  stage:
    kind === 'message'
      ? MessageChannelSyncStage.MESSAGES_IMPORT_ONGOING
      : CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
  startedAt,
});
const email = (): MessageWithParticipants => ({
  externalId: 'ordinary-email',
  headerMessageId: 'ordinary-header',
  messageThreadExternalId: 'ordinary-thread',
  subject: 'Fixture',
  text: 'Synthetic message',
  receivedAt: new Date('2026-10-27'),
  isDraft: false,
  direction: MessageDirection.INCOMING,
  attachments: [],
  messageFolderIds: [folder],
  participants: [
    {
      role: MessageParticipantRole.FROM,
      handle: 'client@example.test',
      displayName: 'Fixture client',
    },
  ],
});
const event = (): FetchedCalendarEvent => ({
  id: 'ordinary-event',
  title: 'Synthetic event',
  iCalUid: 'shared-fixture-uid',
  description: '',
  startsAt: '2026-11-01T10:00:00Z',
  endsAt: '2026-11-01T11:00:00Z',
  location: '',
  isFullDay: false,
  isCanceled: false,
  isPrivate: false,
  conferenceLinkLabel: '',
  conferenceLinkUrl: '',
  externalCreatedAt: '2026-10-27T00:00:00Z',
  externalUpdatedAt: '2026-10-27T00:00:00Z',
  conferenceSolution: '',
  organizerHandle: 'operator@example.test',
  status: 'confirmed',
  participants: [
    {
      displayName: 'Fixture client',
      handle: 'client@example.test',
      responseStatus: 'ACCEPTED',
      isOrganizer: false,
    },
  ],
});
const save = (
  kind: 'message' | 'calendar',
  proof: OrdinaryMetadataSyncRun | undefined = run(kind),
) =>
  kind === 'message'
    ? messages.saveMessagesAndEnqueueContactCreation(
        [email()],
        messageChannel,
        account,
        fixture.workspaceId,
        proof,
      )
    : calendar.saveCalendarEventsAndEnqueueContactCreationJob(
        [event()],
        calendarChannel,
        account,
        fixture.workspaceId,
        proof,
      );
const snapshot = async () => ({
  messages: await fixture.read('message'),
  threads: await fixture.read('messageThread'),
  participants: await fixture.read('messageParticipant'),
  associations: await fixture.read('messageChannelMessageAssociation'),
  folders: await fixture.read('messageChannelMessageAssociationMessageFolder'),
  events: await fixture.read('calendarEvent'),
  eventParticipants: await fixture.read('calendarEventParticipant'),
  eventAssociations: await fixture.read('calendarChannelEventAssociation'),
});
const table = (kind: 'message' | 'calendar') =>
  kind === 'message' ? 'messageChannel' : 'calendarChannel';
beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid,ADD provider text,ADD "applicationId" uuid,ADD "connectionProviderId" uuid,ADD "handleAliases" jsonb,ADD "archivedAt" timestamptz',
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageChannel" ADD "connectedAccountId" uuid,ADD "isSyncEnabled" boolean,ADD "syncStage" text,ADD "syncStageStartedAt" timestamptz',
  );
  await fixture.owner.query(
    'CREATE TABLE core."calendarChannel"(id uuid PRIMARY KEY,"workspaceId" uuid,"connectedAccountId" uuid,"isSyncEnabled" boolean,"syncStage" text,"syncStageStartedAt" timestamptz,handle text,"syncStatus" text)',
  );
  await fixture.owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "${fixture.roleName}"`,
  );
});
beforeAll(async () => {
  await metadata.initialize();
});
beforeEach(async () => {
  await fixture.reset();
  await fixture.owner.query(
    'TRUNCATE core.workspace,core."connectedAccount",core."messageChannel",core."calendarChannel" CASCADE',
  );
  await fixture.owner.query('INSERT INTO core.workspace(id) VALUES ($1)', [
    fixture.workspaceId,
  ]);
  account = {
    id: randomUUID(),
    workspaceId: fixture.workspaceId,
    provider: ConnectedAccountProvider.GOOGLE,
    handleAliases: ['operator@example.test'],
  } as ConnectedAccountEntity;
  messageChannel = {
    id: randomUUID(),
    workspaceId: fixture.workspaceId,
    connectedAccountId: account.id,
    handle: 'operator@example.test',
    type: MessageChannelType.EMAIL,
    isContactAutoCreationEnabled: true,
    contactAutoCreationPolicy:
      MessageChannelContactAutoCreationPolicy.SENT_AND_RECEIVED,
    excludeNonProfessionalEmails: false,
    excludeGroupEmails: false,
  } as MessageChannelEntity;
  calendarChannel = {
    id: randomUUID(),
    workspaceId: fixture.workspaceId,
    connectedAccountId: account.id,
    handle: 'operator@example.test',
    isSyncEnabled: true,
  } as CalendarChannelEntity;
  folder = randomUUID();
  await fixture.owner.query(
    'INSERT INTO core."connectedAccount"(id,"workspaceId",provider,"handleAliases") VALUES ($1,$2,$3,$4)',
    [
      account.id,
      fixture.workspaceId,
      account.provider,
      JSON.stringify(account.handleAliases),
    ],
  );
  await fixture.owner.query(
    'INSERT INTO core."messageChannel"(id,"workspaceId",type,"connectedAccountId","isSyncEnabled","syncStage","syncStageStartedAt") VALUES ($1,$2,$3,$4,true,$5,$6)',
    [
      messageChannel.id,
      fixture.workspaceId,
      messageChannel.type,
      account.id,
      run('message').stage,
      startedAt,
    ],
  );
  await fixture.owner.query(
    'INSERT INTO core."calendarChannel"(id,"workspaceId","connectedAccountId","isSyncEnabled","syncStage","syncStageStartedAt",handle,"syncStatus") VALUES ($1,$2,$3,true,$4,$5,$6,$7)',
    [
      calendarChannel.id,
      fixture.workspaceId,
      account.id,
      run('calendar').stage,
      startedAt,
      calendarChannel.handle,
      'ONGOING',
    ],
  );
  await fixture.owner.query(
    'INSERT INTO core."messageFolder"(id,"workspaceId","messageChannelId") VALUES ($1,$2,$3)',
    [folder, fixture.workspaceId, messageChannel.id],
  );
  contacts = { add: jest.fn() };
  messageParticipants = new MessagingMessageParticipantService(
    manager,
    {} as never,
  );
  calendarParticipants = new CalendarEventParticipantService(
    manager,
    {} as never,
    contacts as never,
  );
  matchMessages = jest
    .spyOn(messageParticipants, 'matchMessageParticipants')
    .mockResolvedValue(undefined);
  matchCalendar = jest
    .spyOn(
      calendarParticipants,
      'matchParticipantsAndEnqueueContactCreationJob',
    )
    .mockResolvedValue(undefined);
  messages = makeService(
    MessagingSaveMessagesAndEnqueueContactCreationService.prototype,
    {
      workspaceOrmManager: manager,
      messageService: new MessagingMessageService(manager),
      messageParticipantService: messageParticipants,
      messageFolderAssociationService:
        new MessagingMessageFolderAssociationService(manager),
      messageQueueService: contacts,
    },
  );
  calendar = makeService(CalendarSaveEventsService.prototype, {
    workspaceOrmManager: manager,
    calendarEventParticipantService: calendarParticipants,
    featureFlagService: { isFeatureEnabled: jest.fn().mockResolvedValue(true) },
  });
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (metadata.isInitialized) await metadata.destroy();
  await fixture.dispose();
});

for (const kind of ['message', 'calendar'] as const)
  describe('ordinary native result apply ' + kind, () => {
    it('current run commits graph using actual native repositories before postcommit work', async () => {
      await save(kind);
      const state = await snapshot();
      if (kind === 'message') {
        expect(state.messages).toHaveLength(1);
        expect(state.participants).toHaveLength(1);
        expect(state.associations).toHaveLength(1);
        expect(state.folders).toHaveLength(1);
        expect(matchMessages).toHaveBeenCalledTimes(1);
        expect(contacts.add).toHaveBeenCalledTimes(1);
      } else {
        expect(state.events).toHaveLength(1);
        expect(state.eventParticipants).toHaveLength(1);
        expect(state.eventAssociations).toHaveLength(1);
        expect(matchCalendar).toHaveBeenCalledTimes(1);
      }
    });
    it.each([
      'parent',
      'new-run',
      'disabled',
      'native',
      'derived-owned',
      'stage',
    ] as const)(
      'rejects %s before native reads/writes and postcommit jobs',
      async (mutation) => {
        if (mutation === 'parent')
          await fixture.owner.query(
            `UPDATE core."${table(kind)}" SET "connectedAccountId"=$1 WHERE id=$2`,
            [randomUUID(), run(kind).channelId],
          );
        if (mutation === 'new-run')
          await fixture.owner.query(
            `UPDATE core."${table(kind)}" SET "syncStageStartedAt"="syncStageStartedAt"+interval '1 microsecond' WHERE id=$1`,
            [run(kind).channelId],
          );
        if (mutation === 'disabled')
          await fixture.owner.query(
            `UPDATE core."${table(kind)}" SET "isSyncEnabled"=false WHERE id=$1`,
            [run(kind).channelId],
          );
        if (mutation === 'stage')
          await fixture.owner.query(
            `UPDATE core."${table(kind)}" SET "syncStage"='FAILED' WHERE id=$1`,
            [run(kind).channelId],
          );
        if (mutation === 'native' || mutation === 'derived-owned')
          await fixture.owner.query(
            'UPDATE core."connectedAccount" SET provider=$1 WHERE id=$2',
            [ConnectedAccountProvider.APP, account.id],
          );
        if (mutation === 'derived-owned') {
          await fixture.owner.query(
            'UPDATE core."messageChannel" SET type=$1 WHERE id=$2',
            [MessageChannelType.APP, messageChannel.id],
          );
          await bootstrapOmniAccountBinding(
            metadata,
            { kind: 'system', id: 'native-apply-fixture' },
            {
              workspaceId: fixture.workspaceId,
              platform: 'telegram',
              connectorInstanceId: 'fixture',
              accountId: account.id,
              connectedAccountId: account.id,
              messageChannelId: messageChannel.id,
              idempotencyKey: randomUUID(),
              expectedRevision: '0',
            },
            async () => undefined,
          );
          await fixture.owner.query(
            'UPDATE core."connectedAccount" SET provider=$1 WHERE id=$2',
            [ConnectedAccountProvider.GOOGLE, account.id],
          );
        }
        const before = await snapshot();
        const result = await save(kind);
        expect(
          kind === 'message'
            ? result
            : (result as { applied: boolean }).applied,
        ).toBe(kind === 'message' ? undefined : false);
        expect(await snapshot()).toEqual(before);
        expect(contacts.add).not.toHaveBeenCalled();
        expect(matchMessages).not.toHaveBeenCalled();
        expect(matchCalendar).not.toHaveBeenCalled();
      },
    );
    it('participant write failure rolls back whole native graph', async () => {
      if (kind === 'message')
        jest
          .spyOn(messageParticipants, 'saveMessageParticipants')
          .mockRejectedValue(new Error('participant write refused'));
      else
        jest
          .spyOn(calendarParticipants, 'writeCalendarEventParticipants')
          .mockRejectedValue(new Error('participant write refused'));
      const before = await snapshot();
      await expect(save(kind)).rejects.toThrow('participant write refused');
      expect(await snapshot()).toEqual(before);
      expect(contacts.add).not.toHaveBeenCalled();
      expect(matchMessages).not.toHaveBeenCalled();
      expect(matchCalendar).not.toHaveBeenCalled();
    });
    it('real commit with lost acknowledgement leaves graph but skips postcommit enqueue/rematch', async () => {
      const client = await fixture.pool.connect(),
        query = client.query.bind(client);
      jest.spyOn(client, 'query').mockImplementation((async (
        sql: string,
        values?: unknown[],
      ) => {
        const result = await query(sql, values);
        if (sql === 'COMMIT') throw new Error('commit ACK lost');
        return result;
      }) as typeof client.query);
      jest
        .spyOn(fixture.pool, 'connect')
        .mockImplementationOnce(() => Promise.resolve(client));
      await expect(save(kind)).rejects.toBeInstanceOf(
        NativeTransactionOutcomeUnknownError,
      );
      expect(
        await fixture.read(kind === 'message' ? 'message' : 'calendarEvent'),
      ).toHaveLength(1);
      expect(contacts.add).not.toHaveBeenCalled();
      expect(matchMessages).not.toHaveBeenCalled();
      expect(matchCalendar).not.toHaveBeenCalled();
    });
    it('two same-channel applies serialize native read/build/write and retain one graph', async () => {
      await Promise.all([save(kind), save(kind)]);
      expect(
        await fixture.read(kind === 'message' ? 'message' : 'calendarEvent'),
      ).toHaveLength(1);
      expect(
        await fixture.read(
          kind === 'message'
            ? 'messageParticipant'
            : 'calendarEventParticipant',
        ),
      ).toHaveLength(1);
      expect(
        await fixture.read(
          kind === 'message'
            ? 'messageChannelMessageAssociation'
            : 'calendarChannelEventAssociation',
        ),
      ).toHaveLength(1);
    });
    it('no-run ordinary caller remains supported', async () => {
      if (kind === 'message')
        await messages.saveMessagesAndEnqueueContactCreation(
          [email()],
          messageChannel,
          account,
          fixture.workspaceId,
        );
      else
        await calendar.saveCalendarEventsAndEnqueueContactCreationJob(
          [event()],
          calendarChannel,
          account,
          fixture.workspaceId,
        );
      expect(
        await fixture.read(kind === 'message' ? 'message' : 'calendarEvent'),
      ).toHaveLength(1);
    });
  });

it('nullable participant identities persist unchanged and only addressable contacts are queued', async () => {
  const message = email();
  message.participants[0].displayName = null;
  message.participants.push({
    role: MessageParticipantRole.TO,
    handle: null,
    displayName: null,
  });
  messageChannel.excludeNonProfessionalEmails = true;
  messageChannel.excludeGroupEmails = true;
  await messages.saveMessagesAndEnqueueContactCreation(
    [message],
    messageChannel,
    account,
    fixture.workspaceId,
    run('message'),
  );
  const participants = await fixture.read('messageParticipant');
  expect(participants).toHaveLength(2);
  expect(participants).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ handle: null, displayName: null }),
      expect.objectContaining({
        handle: 'client@example.test',
        displayName: null,
      }),
    ]),
  );
  expect(contacts.add).toHaveBeenCalledTimes(1);
  expect(contacts.add.mock.calls[0][1].contactsToCreate).toEqual([
    { handle: 'client@example.test', displayName: '' },
  ]);
});

it('APP caller without provider-run proof retains targets-only postcommit matching', async () => {
  messageChannel.type = MessageChannelType.APP;
  await messages.saveMessagesAndEnqueueContactCreation(
    [email()],
    messageChannel,
    account,
    fixture.workspaceId,
  );
  expect(matchMessages).toHaveBeenCalledWith(
    expect.objectContaining({ matchWith: 'targetsOnly' }),
  );
});
it('calendar participant decisions read inside the transaction and see prior native change', async () => {
  await save('calendar');
  matchCalendar.mockClear();
  const before = await fixture.read('calendarEventParticipant');
  expect(before).toHaveLength(1);
  await fixture.owner.query(
    `UPDATE "${fixture.schemaName}"."calendarEventParticipant" SET "displayName"='Old display' WHERE id=$1`,
    [before[0].id],
  );
  const changed = event();
  changed.participants[0].displayName = 'Updated display';
  await calendar.saveCalendarEventsAndEnqueueContactCreationJob(
    [changed],
    calendarChannel,
    account,
    fixture.workspaceId,
    run('calendar'),
  );
  const after = await fixture.read('calendarEventParticipant');
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({
    id: before[0].id,
    displayName: 'Updated display',
  });
});
it('native proof requires an active strict transaction before any query', async () => {
  const executeRawQuery = jest.fn();
  await expect(
    lockOrdinaryNativeSyncRun(
      { workspaceId: fixture.workspaceId, executeRawQuery },
      run('message'),
    ),
  ).rejects.toThrow('REQUIRES_ACTIVE_STRICT_TRANSACTION');
  expect(executeRawQuery).not.toHaveBeenCalled();
});

it('calendar sharing projection links two same-provider channels to one native event', async () => {
  await save('calendar');
  const secondAccount = {
    ...account,
    id: randomUUID(),
    handleAliases: ['second@example.test'],
  };
  const secondChannel = {
    ...calendarChannel,
    id: randomUUID(),
    connectedAccountId: secondAccount.id,
    handle: 'second@example.test',
  };
  await fixture.owner.query(
    'INSERT INTO core."connectedAccount"(id,"workspaceId",provider,"handleAliases") VALUES ($1,$2,$3,$4)',
    [
      secondAccount.id,
      fixture.workspaceId,
      secondAccount.provider,
      JSON.stringify(secondAccount.handleAliases),
    ],
  );
  await fixture.owner.query(
    'INSERT INTO core."calendarChannel"(id,"workspaceId","connectedAccountId","isSyncEnabled","syncStage","syncStageStartedAt",handle,"syncStatus") VALUES ($1,$2,$3,true,$4,$5,$6,$7)',
    [
      secondChannel.id,
      fixture.workspaceId,
      secondAccount.id,
      run('calendar').stage,
      startedAt,
      secondChannel.handle,
      'ONGOING',
    ],
  );
  const result = await calendar.saveCalendarEventsAndEnqueueContactCreationJob(
    [event()],
    secondChannel,
    secondAccount,
    fixture.workspaceId,
    {
      ...run('calendar'),
      channelId: secondChannel.id,
      connectedAccountId: secondAccount.id,
    },
  );
  expect(result.applied).toBe(true);
  expect(await fixture.read('calendarEvent')).toHaveLength(1);
  const associations = await fixture.read('calendarChannelEventAssociation');
  expect(associations).toHaveLength(2);
  expect(
    new Set(
      associations.map(
        (row: { calendarEventId: string }) => row.calendarEventId,
      ),
    ).size,
  ).toBe(1);
  expect(await fixture.read('calendarEventParticipant')).toHaveLength(1);
});
for (const kind of ['message', 'calendar'] as const)
  it(
    kind + ' native apply holds metadata run lock until native COMMIT',
    async () => {
      let entered!: () => void, release!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      jest
        .spyOn(manager, 'runInWorkspaceTransaction')
        .mockImplementation((async (
          work: (scope: WorkspaceTransactionScope) => Promise<unknown>,
          options?: WorkspaceTransactionOptions,
        ) =>
          fixture.dataSource.transaction(async (scope) => {
            const result = await work(scope);
            entered();
            await releasePromise;
            return result;
          }, options)) as typeof manager.runInWorkspaceTransaction);
      const applying = save(kind);
      await enteredPromise;
      const marker = 'native_apply_lock_' + randomUUID().replaceAll('-', '');
      const updating = fixture.owner.query(
        `/* ${marker} */ UPDATE core."${table(kind)}" SET "syncStageStartedAt"="syncStageStartedAt"+interval '1 microsecond' WHERE id=$1`,
        [run(kind).channelId],
      );
      let waiting = false;
      try {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const rows = await fixture.owner.query(
            "SELECT pid FROM pg_stat_activity WHERE query LIKE $1 AND wait_event_type='Lock'",
            ['%' + marker + '%'],
          );
          if (rows.length) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        expect(
          await fixture.read(kind === 'message' ? 'message' : 'calendarEvent'),
        ).toEqual([]);
      } finally {
        release();
        await Promise.allSettled([applying, updating]);
      }
      await applying;
      await updating;
      expect(
        await fixture.read(kind === 'message' ? 'message' : 'calendarEvent'),
      ).toHaveLength(1);
      const before = await snapshot();
      await save(kind);
      expect(await snapshot()).toEqual(before);
    },
  );
