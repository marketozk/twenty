import { randomUUID } from 'node:crypto';
import { Module, type Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, NestFactory } from '@nestjs/core';
import { DataSource, EntitySchema } from 'typeorm';
import {
  CalendarChannelSyncStage,
  ConnectedAccountProvider,
  MessageParticipantRole,
} from 'twenty-shared/types';
import { MessageDirection } from 'src/modules/messaging/common/enums/message-direction.enum';
import { type CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { type ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { DeferredWorkspaceMigrationActionEntity } from 'src/engine/metadata-modules/deferred-workspace-migration-action/deferred-workspace-migration-action.entity';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import {
  type WorkspaceTransactionOptions,
  type WorkspaceTransactionScope,
} from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { CALENDAR_IMPORT_MATCHING_INTENT_NAME } from 'src/engine/core-modules/crm-audit/calendar-save-proof';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import {
  MESSAGE_IMPORT_MATCHING_INTENT_NAME,
  type MessageImportMatchingContext,
} from 'src/engine/core-modules/crm-audit/message-import-matching-context';
import {
  IMPORT_MATCHING_INTENT_RECONCILIATION,
  ReconcileCalendarImportMatchingDeferredActionHandlerService,
  ReconcileMessageImportMatchingDeferredActionHandlerService,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/deferred-action-handlers/services/reconcile-import-matching-deferred-action-handler.service';
import {
  SyncWorkflowRunSharesDeferredActionHandlerService,
  WORKFLOW_RUN_SHARE_RECONCILIATION,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/deferred-action-handlers/services/sync-workflow-run-shares-deferred-action-handler.service';
import { DeferredWorkspaceMigrationActionException } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/exceptions/deferred-workspace-migration-action.exception';
import { DeferredWorkspaceMigrationActionHandlerRegistryService } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/registry/deferred-workspace-migration-action-handler-registry.service';
import { DeferredWorkspaceMigrationActionRecoveryService } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-recovery.service';
import { DeferredWorkspaceMigrationActionRunnerService } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/deferred-workspace-migration-action-runner.service';
import { CalendarSaveEventsService } from 'src/modules/calendar/calendar-event-import-manager/services/calendar-save-events.service';
import { CalendarEventParticipantService } from 'src/modules/calendar/calendar-event-participant-manager/services/calendar-event-participant.service';
import { type FetchedCalendarEvent } from 'src/modules/calendar/common/types/fetched-calendar-event.type';
import { MatchParticipantModule } from 'src/modules/match-participant/match-participant.module';
import { MatchParticipantService } from 'src/modules/match-participant/match-participant.service';
import { ParticipantTargetReconciliationService } from 'src/modules/match-participant/participant-target-reconciliation.service';
import { type MessageParticipantWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-participant.workspace-entity';
import { MessagingMessageFolderAssociationService } from 'src/modules/messaging/message-import-manager/services/messaging-message-folder-association.service';
import { MessagingMessageService } from 'src/modules/messaging/message-import-manager/services/messaging-message.service';
import { MessagingSaveMessagesAndEnqueueContactCreationService } from 'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service';
import { MessagingMessageParticipantService } from 'src/modules/messaging/message-participant-manager/services/messaging-message-participant.service';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';

jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
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
jest.mock('src/engine/core-modules/metrics/metrics.service', () => ({
  MetricsService: class {},
}));
jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({ TwentyConfigService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service',
  () => ({ WorkspaceManyOrAllFlatEntityMapsCacheService: class {} }),
);
jest.mock(
  'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/workspace-schema-migration-runner-action-handlers.module',
  () => ({
    WorkspaceSchemaMigrationRunnerActionHandlersModule: class {},
  }),
);
jest.mock(
  'src/engine/metadata-modules/deferred-workspace-migration-action/deferred-workspace-migration-action.entity',
  () => ({
    DeferredWorkspaceMigrationActionEntity: class DeferredWorkspaceMigrationActionEntity {},
  }),
);
jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository',
  () => ({ WorkspaceScopedRepository: class {} }),
);
jest.mock(
  'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator',
  () => ({ InjectWorkspaceScopedRepository: () => () => {} }),
);

const deferredEntitySchema = new EntitySchema({
  name: 'DeferredWorkspaceMigrationActionEntity',
  target: DeferredWorkspaceMigrationActionEntity,
  schema: 'core',
  tableName: 'deferredWorkspaceMigrationAction',
  columns: {
    id: { type: 'uuid', primary: true, generated: 'uuid' },
    workspaceId: { type: 'uuid' },
    applicationUniversalIdentifier: { type: 'varchar' },
    name: { type: 'varchar' },
    payload: { type: 'jsonb' },
    position: { type: 'integer' },
    runByVersion: { type: 'varchar', nullable: true },
    status: { type: 'varchar', default: 'PENDING' },
    attempts: { type: 'integer', default: 0 },
    lastError: { type: 'text', nullable: true },
    startedAt: { type: 'timestamptz', nullable: true },
    createdAt: { type: 'timestamptz', createDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
});

const f = createOmniNativeMessageFixture({
  useStandardForeignKeyActions: true,
  additionalTables: [
    'workspaceMember',
    'company',
    'opportunity',
    'messageThreadTarget',
    'messageCampaign',
    'blocklist',
    'messageChannelMessageAssociationMessageFolder',
    'calendarEvent',
    'calendarEventParticipant',
    'calendarChannelEventAssociation',
    'calendarEventTarget',
    'callRecording',
  ],
});
const table = (name: string) => `"${f.schemaName}"."${name}"`;
const startedAt = '2030-01-01T00:00:00.123456Z';
const manager = {
  getWorkspaceId: () => f.workspaceId,
  executeInWorkspaceContext: async <T>(work: () => Promise<T>) =>
    f.withContext(work),
  runInWorkspaceTransaction: async <T>(
    work: (scope: WorkspaceTransactionScope) => Promise<T>,
    options?: WorkspaceTransactionOptions,
  ) => f.dataSource.transaction(work, options),
  getRepository: (name: string, permissionOptions?: never) =>
    f.dataSource.getRepository(name, permissionOptions),
} as unknown as WorkspaceOrmManager;
const matcher = new MatchParticipantService<MessageParticipantWorkspaceEntity>(
  manager,
  new ParticipantTargetReconciliationService(manager, f.owner),
  {} as never,
  f.owner,
);

const messageHandler =
  new ReconcileMessageImportMatchingDeferredActionHandlerService(matcher);
const calendarHandler =
  new ReconcileCalendarImportMatchingDeferredActionHandlerService(matcher);
const syncWorkflowShares = jest.fn().mockResolvedValue(undefined);
const workflowHandler = new SyncWorkflowRunSharesDeferredActionHandlerService({
  syncRunsOfCoreWorkflows: syncWorkflowShares,
});

const handlers = new Map<string, unknown>([
  [MESSAGE_IMPORT_MATCHING_INTENT_NAME, messageHandler],
  [CALENDAR_IMPORT_MATCHING_INTENT_NAME, calendarHandler],
  ['sync_workflowRunShares', workflowHandler],
]);

const deferredDataSource = new DataSource({
  type: 'postgres',
  url: f.runtimeDatabaseUrl,
  entities: [deferredEntitySchema],
  extra: { max: 4, statement_timeout: 12000 },
});

const scopedDeferredRepository = {
  find: (scope: string, options: object) =>
    deferredDataSource
      .getRepository(DeferredWorkspaceMigrationActionEntity)
      .find({
        ...options,
        where: { workspaceId: scope, ...(options as { where?: object }).where },
      }),
  update: (scope: string, criteria: object, changes: object) =>
    deferredDataSource
      .getRepository(DeferredWorkspaceMigrationActionEntity)
      .update({ ...criteria, workspaceId: scope }, changes),
  delete: (scope: string, criteria: object) =>
    deferredDataSource
      .getRepository(DeferredWorkspaceMigrationActionEntity)
      .delete({ ...criteria, workspaceId: scope }),
  createQueryBuilder: (alias?: string) =>
    deferredDataSource
      .getRepository(DeferredWorkspaceMigrationActionEntity)
      .createQueryBuilder(alias ?? 'deferredWorkspaceMigrationAction'),
};

const workspaceQueue = { add: jest.fn().mockResolvedValue(undefined) };
const runner = new DeferredWorkspaceMigrationActionRunnerService(
  scopedDeferredRepository as never,
  deferredDataSource,
  workspaceQueue as never,
  { getOrRecomputeManyOrAllFlatEntityMaps: async () => ({}) } as never,
  {
    getHandler: (name: string) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Missing handler for ${name}`);
      return handler;
    },
  } as never,
  { get: () => 'test-version' } as never,
  { recordHistogram: jest.fn() } as never,
);
const recovery = new DeferredWorkspaceMigrationActionRecoveryService(
  scopedDeferredRepository as never,
  runner,
);

const intents = () =>
  f.owner.query(
    'SELECT * FROM core."deferredWorkspaceMigrationAction" ORDER BY "createdAt" ASC, position ASC, id ASC',
  );

const insertNative = async (name: string, fields: Record<string, unknown>) => {
  const id = randomUUID();
  await f.withContext(() =>
    f.dataSource.transaction(
      async (scope) => {
        await scope
          .getRepository(name, { shouldBypassPermissionChecks: true })
          .insert({ id, ...fields });
      },
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
  f.eventEmitter.mockClear();
  return id;
};

const createImportHarness = async (messageParticipantCount = 1) => {
  const userId = randomUUID();
  const userWorkspaceId = randomUUID();
  const accountId = randomUUID();
  const messageChannelId = randomUUID();
  await f.owner.query('INSERT INTO core."user"(id) VALUES($1)', [userId]);
  await f.owner.query(
    'INSERT INTO core."userWorkspace"(id,"userId","workspaceId") VALUES($1,$2,$3)',
    [userWorkspaceId, userId, f.workspaceId],
  );
  await f.owner.query(
    'INSERT INTO core."connectedAccount"(id,"workspaceId",provider,scope,"userWorkspaceId","handleAliases") VALUES($1,$2,$3,$4,$5,$6)',
    [
      accountId,
      f.workspaceId,
      ConnectedAccountProvider.GOOGLE,
      'USER',
      userWorkspaceId,
      JSON.stringify(['organizer@example.test']),
    ],
  );
  await f.owner.query(
    'INSERT INTO core."messageChannel"(id,"workspaceId",type,"connectedAccountId",handle,"isSyncEnabled","syncStage","syncStageStartedAt") VALUES($1,$2,$3,$4,$5,true,$6,$7)',
    [
      messageChannelId,
      f.workspaceId,
      'EMAIL_GROUP',
      accountId,
      'inbound@example.test',
      'MESSAGES_IMPORT_ONGOING',
      startedAt,
    ],
  );
  const calendarChannelId = randomUUID();
  await f.owner.query(
    'INSERT INTO core."calendarChannel"(id,"workspaceId","connectedAccountId",handle,"isSyncEnabled","syncStatus","syncStage","syncStageStartedAt","isContactAutoCreationEnabled","contactAutoCreationPolicy","excludePrivateEvents") VALUES($1,$2,$3,$4,true,\'ONGOING\',$5,$6,true,\'AS_PARTICIPANT_AND_ORGANIZER\',false)',
    [
      calendarChannelId,
      f.workspaceId,
      accountId,
      'organizer@example.test',
      CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
      startedAt,
    ],
  );
  const personId = await insertNative('person', {
    name: { firstName: 'Match', lastName: 'Person' },
    emails: { primaryEmail: 'client@example.test', additionalEmails: [] },
  });
  const memberId = await insertNative('workspaceMember', {
    userId: randomUUID(),
    name: { firstName: 'Match', lastName: 'Member' },
    userEmail: 'client@example.test',
  });
  const contacts = { add: jest.fn().mockResolvedValue(undefined) };
  const messageParticipants = new MessagingMessageParticipantService(
    manager,
    matcher as never,
  );
  const messageSaveService =
    new MessagingSaveMessagesAndEnqueueContactCreationService(
      contacts as never,
      new MessagingMessageService(manager),
      messageParticipants,
      new MessagingMessageFolderAssociationService(manager),
      manager,
      f.owner as never,
    );
  const calendarParticipants = new CalendarEventParticipantService(
    manager,
    matcher as never,
    contacts as never,
  );
  const calendarSaveService = Object.assign(
    Object.create(CalendarSaveEventsService.prototype),
    {
      workspaceOrmManager: manager,
      calendarEventParticipantService: calendarParticipants,
      featureFlagService: {
        isFeatureEnabled: jest.fn().mockResolvedValue(true),
      },
    },
  ) as CalendarSaveEventsService;

  const messageContext: MessageImportMatchingContext = {
    authority: {
      kind: 'inbound',
      workspaceId: f.workspaceId,
      connectedAccountId: accountId,
      channelId: messageChannelId,
      channelType: 'EMAIL_GROUP',
      recipient: 'inbound@example.test',
    },
    operation: {
      workspaceId: f.workspaceId,
      operationId: randomUUID(),
      correlationId: randomUUID(),
      actor: { kind: 'system', id: 'DeferredRunnerMessageTest' },
    },
  };
  const messagesToSave = [
    {
      externalId: 'deferred-runner-msg-1',
      headerMessageId: 'deferred-runner-hdr-1',
      subject: 'Deferred runner subject',
      messageThreadExternalId: 'deferred-runner-thread-1',
      receivedAt: new Date('2030-01-01T00:00:00.000Z'),
      direction: MessageDirection.INCOMING,
      participants: Array.from(
        { length: messageParticipantCount },
        (_, index) => ({
          role:
            index === 0
              ? MessageParticipantRole.FROM
              : MessageParticipantRole.CC,
          handle:
            index === 0 ? 'client@example.test' : `extra-${index}@example.test`,
          displayName: `Client ${index}`,
        }),
      ),
      attachments: [],
      text: 'Deferred runner body',
      isDraft: false,
    },
  ];
  const calendarChannel = {
    id: calendarChannelId,
    workspaceId: f.workspaceId,
    connectedAccountId: accountId,
    handle: 'organizer@example.test',
    isSyncEnabled: true,
    isContactAutoCreationEnabled: true,
    contactAutoCreationPolicy: 'AS_PARTICIPANT_AND_ORGANIZER',
    excludePrivateEvents: false,
  } as CalendarChannelEntity;
  const connectedAccount = {
    id: accountId,
    workspaceId: f.workspaceId,
    provider: ConnectedAccountProvider.GOOGLE,
    handle: 'organizer@example.test',
    handleAliases: ['organizer@example.test'],
  } as ConnectedAccountEntity;
  const calendarRun: OrdinaryMetadataSyncRun = {
    workspaceId: f.workspaceId,
    channelId: calendarChannelId,
    connectedAccountId: accountId,
    kind: 'calendar',
    stage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
    startedAt,
  };
  const calendarEvents: FetchedCalendarEvent[] = [
    {
      id: 'deferred-runner-cal-1',
      title: 'Deferred runner meeting',
      iCalUid: 'ical-deferred-runner-1',
      description: 'Deferred runner description',
      startsAt: '2030-01-01T10:00:00.000123Z',
      endsAt: '2030-01-01T11:00:00.000789Z',
      location: 'Room 1',
      isFullDay: false,
      isCanceled: false,
      isPrivate: false,
      conferenceLinkLabel: 'Link',
      conferenceLinkUrl: 'https://example.test/meet',
      externalCreatedAt: '2029-01-01T00:00:00Z',
      externalUpdatedAt: '2029-01-02T00:00:00Z',
      conferenceSolution: '',
      organizerHandle: 'organizer@example.test',
      status: 'confirmed',
      participants: [
        {
          displayName: 'Calendar Client',
          handle: 'client@example.test',
          responseStatus: 'ACCEPTED',
          isOrganizer: false,
        },
      ],
    },
  ];

  return {
    accountId,
    messageChannelId,
    calendarChannelId,
    personId,
    memberId,
    contacts,
    saveMessages: () =>
      messageSaveService.saveMessagesAndEnqueueContactCreation(
        messagesToSave as never,
        {
          id: messageChannelId,
          connectedAccountId: accountId,
          type: 'EMAIL_GROUP',
          isContactAutoCreationEnabled: true,
          contactAutoCreationPolicy: 'SENT_AND_RECEIVED',
          excludeNonProfessionalEmails: false,
          excludeGroupEmails: false,
        } as never,
        connectedAccount as never,
        f.workspaceId,
        { context: messageContext },
      ),
    saveCalendarEvents: () =>
      calendarSaveService.saveCalendarEventsAndEnqueueContactCreationJob(
        calendarEvents,
        calendarChannel,
        connectedAccount,
        f.workspaceId,
        {
          workspaceId: f.workspaceId,
          operationId: randomUUID(),
          correlationId: randomUUID(),
          actor: { kind: 'system', id: 'DeferredRunnerCalendarTest' },
        },
        calendarRun,
      ),
  };
};

beforeAll(async () => {
  await f.initialize();
  await deferredDataSource.initialize();
  await f.owner.query(
    'ALTER TABLE core."messageChannel" ADD "connectedAccountId" uuid,ADD handle text,ADD "isSyncEnabled" boolean,ADD "syncStage" text,ADD "syncStageStartedAt" timestamptz',
  );
  await f.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid,ADD provider text,ADD "applicationId" uuid,ADD "connectionProviderId" uuid,ADD scope text,ADD "userWorkspaceId" uuid,ADD "handleAliases" jsonb,ADD "archivedAt" timestamptz',
  );
  await f.owner.query(
    'CREATE TABLE core."calendarChannel"(id uuid PRIMARY KEY,"workspaceId" uuid,"connectedAccountId" uuid,handle text,"isSyncEnabled" boolean,"syncStatus" text,"syncStage" text,"syncStageStartedAt" timestamptz,"isContactAutoCreationEnabled" boolean,"contactAutoCreationPolicy" text,"excludePrivateEvents" boolean)',
  );
  await f.owner.query(
    'CREATE TABLE core."user"(id uuid PRIMARY KEY,disabled boolean NOT NULL DEFAULT false,"deletedAt" timestamptz)',
  );
  await f.owner.query(
    'CREATE TABLE core."userWorkspace"(id uuid PRIMARY KEY,"userId" uuid NOT NULL,"workspaceId" uuid NOT NULL,"deletedAt" timestamptz)',
  );
  await f.owner.query(
    'CREATE TABLE core.application(id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL,"deletedAt" timestamptz)',
  );
  await f.owner.query(
    'CREATE TABLE core.agent(id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL,"applicationId" uuid,"deletedAt" timestamptz)',
  );
  await f.owner.query(
    'CREATE TABLE core.workflow(id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL)',
  );
  await f.owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "${f.roleName}"`,
  );
});

beforeEach(async () => {
  workspaceQueue.add.mockClear();
  syncWorkflowShares.mockClear();
  await f.reset();
  await f.owner.query(
    'TRUNCATE core.workspace,core."connectedAccount",core."messageChannel",core."calendarChannel",core."user",core."userWorkspace",core.application,core.agent,core.workflow CASCADE',
  );
  await f.owner.query('INSERT INTO core.workspace(id) VALUES($1)', [
    f.workspaceId,
  ]);
});

afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (deferredDataSource.isInitialized) await deferredDataSource.destroy();
  await f.dispose();
});

it('discovers both import matching handlers in DeferredWorkspaceMigrationActionHandlerRegistryService from MatchParticipantModule', async () => {
  const matchProviders = (
    Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      MatchParticipantModule,
    ) as Provider[]
  ).filter(
    (provider) =>
      provider === ReconcileMessageImportMatchingDeferredActionHandlerService ||
      provider ===
        ReconcileCalendarImportMatchingDeferredActionHandlerService ||
      (typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        (provider as { provide: unknown }).provide ===
          IMPORT_MATCHING_INTENT_RECONCILIATION),
  );
  class RegistryFixtureModule {}
  Module({
    imports: [DiscoveryModule],
    providers: [
      { provide: MatchParticipantService, useValue: matcher },
      ...matchProviders,
      {
        provide: WORKFLOW_RUN_SHARE_RECONCILIATION,
        useValue: { syncRunsOfCoreWorkflows: syncWorkflowShares },
      },
      SyncWorkflowRunSharesDeferredActionHandlerService,
      DeferredWorkspaceMigrationActionHandlerRegistryService,
    ],
  })(RegistryFixtureModule);

  const app = await NestFactory.createApplicationContext(
    RegistryFixtureModule,
    {
      logger: false,
    },
  );
  try {
    const registry = app.get(
      DeferredWorkspaceMigrationActionHandlerRegistryService,
    );
    expect(registry.getHandler(MESSAGE_IMPORT_MATCHING_INTENT_NAME)).toBe(
      app.get(ReconcileMessageImportMatchingDeferredActionHandlerService),
    );
    expect(registry.getHandler(CALENDAR_IMPORT_MATCHING_INTENT_NAME)).toBe(
      app.get(ReconcileCalendarImportMatchingDeferredActionHandlerService),
    );
    expect(registry.getHandler('sync_workflowRunShares')).toBe(
      app.get(SyncWorkflowRunSharesDeferredActionHandlerService),
    );
  } finally {
    await app.close();
  }
});

it('executes pending message and calendar import matching intents alongside sync_workflowRunShares through DeferredWorkspaceMigrationActionRunnerService.runPendingActions', async () => {
  const h = await createImportHarness();
  const workflowId = randomUUID();
  await f.owner.query(
    'INSERT INTO core.workflow(id,"workspaceId") VALUES($1,$2)',
    [workflowId, f.workspaceId],
  );
  h.contacts.add.mockRejectedValue(new Error('contact queue down'));
  await expect(h.saveMessages()).rejects.toThrow('contact queue down');
  await expect(h.saveCalendarEvents()).rejects.toBeInstanceOf(
    CoreAuditPostCommitError,
  );
  await f.owner.query(
    'INSERT INTO core."deferredWorkspaceMigrationAction"(id,"workspaceId","applicationUniversalIdentifier",name,payload,position,status,attempts) VALUES($1,$2,$3,\'sync_workflowRunShares\',$4::jsonb,2,\'PENDING\',0)',
    [
      randomUUID(),
      f.workspaceId,
      randomUUID(),
      JSON.stringify({ version: 1, coreWorkflowId: workflowId }),
    ],
  );

  expect(await intents()).toHaveLength(3);
  const enqueuedCount = await recovery.enqueueWorkspacesWithPendingActions();
  expect(enqueuedCount).toBe(1);
  expect(workspaceQueue.add).toHaveBeenCalledTimes(1);

  await runner.runPendingActions(f.workspaceId);

  expect(await intents()).toHaveLength(0);
  expect(syncWorkflowShares).toHaveBeenCalledWith({
    workspaceId: f.workspaceId,
    coreWorkflowIds: [workflowId],
  });
  const [matchedMsgParticipant] = await f.owner.query(
    `SELECT * FROM ${table('messageParticipant')}`,
  );
  expect(matchedMsgParticipant).toMatchObject({
    personId: h.personId,
    workspaceMemberId: h.memberId,
  });
  const [matchedCalParticipant] = await f.owner.query(
    `SELECT * FROM ${table('calendarEventParticipant')}`,
  );
  expect(matchedCalParticipant).toMatchObject({
    personId: h.personId,
    workspaceMemberId: h.memberId,
  });
  expect(
    await f.owner.query(`SELECT * FROM ${table('messageThreadTarget')}`),
  ).toHaveLength(1);
  expect(
    await f.owner.query(`SELECT * FROM ${table('calendarEventTarget')}`),
  ).toHaveLength(1);
});

it('preserves self-managed nextPageIndex cursor across runner.runPendingActions partial failure and resumes from Page 1 on retry', async () => {
  const h = await createImportHarness(201);
  h.contacts.add.mockRejectedValueOnce(new Error('contact queue down'));
  await expect(h.saveMessages()).rejects.toThrow('contact queue down');

  let txCalls = 0;
  const originalRunInTx = manager.runInWorkspaceTransaction.bind(manager);
  const txSpy = jest
    .spyOn(manager, 'runInWorkspaceTransaction')
    .mockImplementation((async (work: unknown, options: unknown) => {
      txCalls += 1;
      if (txCalls === 2) {
        throw new Error('page 1 transient failure in runner');
      }
      return originalRunInTx(work as never, options as never);
    }) as typeof manager.runInWorkspaceTransaction);

  await expect(runner.runPendingActions(f.workspaceId)).rejects.toBeInstanceOf(
    DeferredWorkspaceMigrationActionException,
  );
  txSpy.mockRestore();

  const [partialRow] = await intents();
  expect(partialRow).toMatchObject({
    status: 'PENDING',
    attempts: 1,
    lastError: 'page 1 transient failure in runner',
  });
  expect((partialRow.payload as { nextPageIndex: number }).nextPageIndex).toBe(
    1,
  );

  const resumeSpy = jest.spyOn(manager, 'runInWorkspaceTransaction');
  await runner.runPendingActions(f.workspaceId);
  expect(resumeSpy).toHaveBeenCalledTimes(1);
  resumeSpy.mockRestore();
  expect(await intents()).toHaveLength(0);
});

it('deletes obsolete PENDING import matching intents on a soft-deleted workspace while fencing any PENDING row with unsafeOutcome', async () => {
  const h = await createImportHarness();
  h.contacts.add.mockRejectedValue(new Error('contact queue down'));
  await expect(h.saveMessages()).rejects.toThrow('contact queue down');
  await expect(h.saveCalendarEvents()).rejects.toBeInstanceOf(
    CoreAuditPostCommitError,
  );
  await f.owner.query(
    'UPDATE core.workspace SET "deletedAt"=now() WHERE id=$1',
    [f.workspaceId],
  );

  await runner.runPendingActions(f.workspaceId);
  expect(await intents()).toHaveLength(0);

  const tamperedId = randomUUID();
  await f.owner.query(
    'INSERT INTO core."deferredWorkspaceMigrationAction"(id,"workspaceId","applicationUniversalIdentifier",name,payload,position,status,attempts) VALUES($1,$2,$3,$4,$5::jsonb,0,\'PENDING\',1)',
    [
      tamperedId,
      f.workspaceId,
      randomUUID(),
      CALENDAR_IMPORT_MATCHING_INTENT_NAME,
      JSON.stringify({ unsafeOutcome: { reason: 'lost commit ack' } }),
    ],
  );
  await expect(runner.runPendingActions(f.workspaceId)).rejects.toBeInstanceOf(
    DeferredWorkspaceMigrationActionException,
  );
  const [fenced] = await intents();
  expect(fenced).toMatchObject({
    id: tamperedId,
    status: 'FAILED',
    lastError: 'Calendar matching intent fenced by unsafe outcome',
  });
});

it('keeps unsafeOutcome rows fenced in FAILED across runner.runPendingActions, recovery.retryFailedActions, recovery.resetStaleInProgressActions and recovery.enqueueWorkspacesWithPendingActions', async () => {
  const h = await createImportHarness();
  h.contacts.add.mockRejectedValue(new Error('contact queue down'));
  await expect(h.saveMessages()).rejects.toThrow('contact queue down');
  await expect(h.saveCalendarEvents()).rejects.toBeInstanceOf(
    CoreAuditPostCommitError,
  );

  const unknownCommitError = new NativeTransactionOutcomeUnknownError(
    'commit',
    new Error('COMMIT ACK lost in runner'),
  );
  const txSpy = jest
    .spyOn(manager, 'runInWorkspaceTransaction')
    .mockImplementation((async () => {
      throw unknownCommitError;
    }) as typeof manager.runInWorkspaceTransaction);

  await expect(runner.runPendingActions(f.workspaceId)).rejects.toBeInstanceOf(
    DeferredWorkspaceMigrationActionException,
  );
  txSpy.mockRestore();

  const rowsAfterFirstRun = await intents();
  expect(rowsAfterFirstRun).toHaveLength(2);
  const messageRow = rowsAfterFirstRun.find(
    (r: { name: string }) => r.name === MESSAGE_IMPORT_MATCHING_INTENT_NAME,
  );
  const calendarRow = rowsAfterFirstRun.find(
    (r: { name: string }) => r.name === CALENDAR_IMPORT_MATCHING_INTENT_NAME,
  );
  expect(messageRow.status).toBe('FAILED');
  expect(messageRow.payload).toHaveProperty('unsafeOutcome');
  expect(calendarRow.status).toBe('PENDING');

  const retriedCount = await recovery.retryFailedActions(f.workspaceId);
  expect(retriedCount).toBe(0);

  await f.owner.query(
    'UPDATE core."deferredWorkspaceMigrationAction" SET status=\'IN_PROGRESS\',"startedAt"=now() - interval \'2 hours\',attempts=1 WHERE id=$1',
    [messageRow.id],
  );
  await f.owner.query(
    'UPDATE core."deferredWorkspaceMigrationAction" SET status=\'IN_PROGRESS\',"startedAt"=now() - interval \'2 hours\',attempts=1 WHERE id=$1',
    [calendarRow.id],
  );

  const resetCount = await recovery.resetStaleInProgressActions();
  expect(resetCount).toBe(2);

  const afterReset = await intents();
  const resetMessageRow = afterReset.find(
    (r: { id: string }) => r.id === messageRow.id,
  );
  const resetCalendarRow = afterReset.find(
    (r: { id: string }) => r.id === calendarRow.id,
  );
  expect(resetMessageRow).toMatchObject({
    status: 'FAILED',
    startedAt: null,
  });
  expect(resetCalendarRow).toMatchObject({
    status: 'PENDING',
    startedAt: null,
  });

  await runner.runPendingActions(f.workspaceId);

  const remaining = await intents();
  expect(remaining).toHaveLength(1);
  expect(remaining[0]).toMatchObject({
    id: messageRow.id,
    status: 'FAILED',
  });
  expect(await recovery.enqueueWorkspacesWithPendingActions()).toBe(0);

  await f.owner.query(
    'UPDATE core."deferredWorkspaceMigrationAction" SET status=\'PENDING\' WHERE id=$1',
    [messageRow.id],
  );
  expect(await recovery.enqueueWorkspacesWithPendingActions()).toBe(0);
  await expect(runner.runPendingActions(f.workspaceId)).rejects.toBeInstanceOf(
    DeferredWorkspaceMigrationActionException,
  );
  const [fencedAgain] = await intents();
  expect(fencedAgain.status).toBe('FAILED');
});

it('retries ordinary exhausted FAILED import matching intents while leaving unsafeOutcome rows FAILED and validates direct handler calls without actionId', async () => {
  const h = await createImportHarness();
  h.contacts.add.mockRejectedValue(new Error('contact queue down'));
  await expect(h.saveCalendarEvents()).rejects.toBeInstanceOf(
    CoreAuditPostCommitError,
  );

  await f.owner.query(
    'UPDATE core."calendarChannel" SET "isSyncEnabled"=false WHERE id=$1',
    [h.calendarChannelId],
  );
  for (let attempt = 1; attempt <= 3; attempt++) {
    await expect(
      runner.runPendingActions(f.workspaceId),
    ).rejects.toBeInstanceOf(DeferredWorkspaceMigrationActionException);
    const [row] = await intents();
    expect(row.attempts).toBe(attempt);
    expect(row.status).toBe(attempt < 3 ? 'PENDING' : 'FAILED');
  }

  await f.owner.query(
    'UPDATE core."calendarChannel" SET "isSyncEnabled"=true WHERE id=$1',
    [h.calendarChannelId],
  );
  expect(await recovery.retryFailedActions()).toBe(1);
  const [resetRow] = await intents();
  expect(resetRow).toMatchObject({
    status: 'PENDING',
    attempts: 0,
    startedAt: null,
  });

  await runner.runPendingActions(f.workspaceId);
  expect(await intents()).toHaveLength(0);

  const queryRunner = f.owner.createQueryRunner();
  try {
    await expect(
      messageHandler.execute({
        workspaceId: f.workspaceId,
        payload: { version: 2 },
        queryRunner,
      }),
    ).rejects.toThrow('Native message import matching intent payload invalid');
    await expect(
      calendarHandler.execute({
        workspaceId: f.workspaceId,
        payload: { version: 2 },
        queryRunner,
      }),
    ).rejects.toThrow('Calendar import matching intent payload invalid');
  } finally {
    await queryRunner.release();
  }
});
