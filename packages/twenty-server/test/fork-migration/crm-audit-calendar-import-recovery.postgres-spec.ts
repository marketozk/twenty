import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  CalendarChannelSyncStage,
  ConnectedAccountProvider,
} from 'twenty-shared/types';
import { type CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { type ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import {
  type WorkspaceTransactionScope,
  type WorkspaceTransactionOptions,
} from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { CALENDAR_IMPORT_MATCHING_INTENT_NAME } from 'src/engine/core-modules/crm-audit/calendar-save-proof';
import { CalendarSaveEventsService } from 'src/modules/calendar/calendar-event-import-manager/services/calendar-save-events.service';
import { CalendarEventParticipantService } from 'src/modules/calendar/calendar-event-participant-manager/services/calendar-event-participant.service';
import { type CalendarEventParticipantWorkspaceEntity } from 'src/modules/calendar/common/standard-objects/calendar-event-participant.workspace-entity';
import { type FetchedCalendarEvent } from 'src/modules/calendar/common/types/fetched-calendar-event.type';
import { MatchParticipantService } from 'src/modules/match-participant/match-participant.service';
import { ParticipantTargetReconciliationService } from 'src/modules/match-participant/participant-target-reconciliation.service';
import { bootstrapOmniAccountBinding } from 'src/modules/omnichannel/services/omni-binding-bootstrap';
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

const f = createOmniNativeMessageFixture({
  useStandardForeignKeyActions: true,
  additionalTables: [
    'workspaceMember',
    'company',
    'opportunity',
    'calendarEvent',
    'calendarEventParticipant',
    'calendarChannelEventAssociation',
    'calendarEventTarget',
    'callRecording',
  ],
});
const EVENT = 'calendarEvent';
const ASSOC = 'calendarChannelEventAssociation';
const PART = 'calendarEventParticipant';
const TARGET = 'calendarEventTarget';
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

const matcher =
  new MatchParticipantService<CalendarEventParticipantWorkspaceEntity>(
    manager,
    new ParticipantTargetReconciliationService(manager, f.owner),
    {} as never,
    f.owner,
  );

const audits = () =>
  f.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt" ASC, "resourceId" ASC, id ASC',
  );
const intents = () =>
  f.owner.query(
    'SELECT * FROM core."deferredWorkspaceMigrationAction" WHERE name=$1 ORDER BY "createdAt" ASC, id ASC',
    [CALENDAR_IMPORT_MATCHING_INTENT_NAME],
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

const buildFetchedEvent = (
  externalId = 'calendar-recovery-event-1',
  participantEmail = 'client@example.test',
): FetchedCalendarEvent => ({
  id: externalId,
  title: 'Private recovery meeting',
  iCalUid: `ical-${externalId}`,
  description: 'Private recovery description',
  startsAt: '2030-01-01T10:00:00.000123Z',
  endsAt: '2030-01-01T11:00:00.000789Z',
  location: 'Private location',
  isFullDay: false,
  isCanceled: false,
  isPrivate: false,
  conferenceLinkLabel: 'Recovery link',
  conferenceLinkUrl: 'https://example.test/recovery-conference',
  externalCreatedAt: '2029-01-01T00:00:00Z',
  externalUpdatedAt: '2029-01-02T00:00:00Z',
  conferenceSolution: '',
  organizerHandle: 'organizer@example.test',
  status: 'confirmed',
  participants: [
    {
      displayName: 'Recovery attendee',
      handle: participantEmail,
      responseStatus: 'ACCEPTED',
      isOrganizer: false,
    },
  ],
});

const createHarness = async (autoCreateContacts = true) => {
  const accountId = randomUUID();
  const channelId = randomUUID();
  await f.owner.query(
    'INSERT INTO core."connectedAccount"(id,"workspaceId",provider,"handleAliases") VALUES($1,$2,$3,$4)',
    [
      accountId,
      f.workspaceId,
      ConnectedAccountProvider.GOOGLE,
      JSON.stringify(['organizer@example.test']),
    ],
  );
  await f.owner.query(
    'INSERT INTO core."calendarChannel"(id,"workspaceId","connectedAccountId",handle,"isSyncEnabled","syncStatus","syncStage","syncStageStartedAt","isContactAutoCreationEnabled","contactAutoCreationPolicy","excludePrivateEvents") VALUES($1,$2,$3,$4,true,\'ONGOING\',$5,$6,$7,\'AS_PARTICIPANT_AND_ORGANIZER\',false)',
    [
      channelId,
      f.workspaceId,
      accountId,
      'organizer@example.test',
      CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
      startedAt,
      autoCreateContacts,
    ],
  );
  const companyId = await insertNative('company', {
    name: 'Matched Company',
  });
  const personId = await insertNative('person', {
    name: { firstName: 'Matched', lastName: 'Client' },
    emails: { primaryEmail: 'client@example.test', additionalEmails: [] },
    companyId,
  });
  const memberId = await insertNative('workspaceMember', {
    userId: randomUUID(),
    name: { firstName: 'Matched', lastName: 'Member' },
    userEmail: 'client@example.test',
  });
  const account = {
    id: accountId,
    workspaceId: f.workspaceId,
    provider: ConnectedAccountProvider.GOOGLE,
    handleAliases: ['organizer@example.test'],
  } as ConnectedAccountEntity;
  const channel = {
    id: channelId,
    workspaceId: f.workspaceId,
    connectedAccountId: accountId,
    handle: 'organizer@example.test',
    isSyncEnabled: true,
    isContactAutoCreationEnabled: autoCreateContacts,
    contactAutoCreationPolicy: 'AS_PARTICIPANT_AND_ORGANIZER',
    excludePrivateEvents: false,
  } as CalendarChannelEntity;
  const expectedRun: OrdinaryMetadataSyncRun = {
    workspaceId: f.workspaceId,
    channelId,
    connectedAccountId: accountId,
    kind: 'calendar',
    stage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
    startedAt,
  };
  const operation: CrmAuditOperation = {
    workspaceId: f.workspaceId,
    operationId: randomUUID(),
    correlationId: randomUUID(),
    actor: { kind: 'coreUser', id: randomUUID() },
    initiator: { kind: 'coreUser', id: randomUUID() },
  };
  const contacts = { add: jest.fn().mockResolvedValue(undefined) };
  const participants = new CalendarEventParticipantService(
    manager,
    matcher,
    contacts as never,
  );
  const service = Object.assign(
    Object.create(CalendarSaveEventsService.prototype),
    {
      workspaceOrmManager: manager,
      calendarEventParticipantService: participants,
      featureFlagService: {
        isFeatureEnabled: jest.fn().mockResolvedValue(true),
      },
    },
  ) as CalendarSaveEventsService;
  return {
    accountId,
    channelId,
    companyId,
    personId,
    memberId,
    account,
    channel,
    expectedRun,
    operation,
    contacts,
    participants,
    service,
    save: (
      events: FetchedCalendarEvent[] = [buildFetchedEvent()],
      run: OrdinaryMetadataSyncRun | undefined = expectedRun,
      op: CrmAuditOperation = operation,
    ) =>
      service.saveCalendarEventsAndEnqueueContactCreationJob(
        events,
        channel,
        account,
        f.workspaceId,
        op,
        run,
      ),
  };
};

beforeAll(async () => {
  await f.initialize();
  await f.owner.query(
    'ALTER TABLE core."messageChannel" ADD "connectedAccountId" uuid',
  );
  await f.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid,ADD provider text,ADD "applicationId" uuid,ADD "connectionProviderId" uuid,ADD "handleAliases" jsonb,ADD "archivedAt" timestamptz',
  );
  await f.owner.query(
    'CREATE TABLE core."calendarChannel"(id uuid PRIMARY KEY,"workspaceId" uuid,"connectedAccountId" uuid,handle text,"isSyncEnabled" boolean,"syncStatus" text,"syncStage" text,"syncStageStartedAt" timestamptz,"isContactAutoCreationEnabled" boolean,"contactAutoCreationPolicy" text,"excludePrivateEvents" boolean)',
  );
  await f.owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "${f.roleName}"`,
  );
});

beforeEach(async () => {
  await f.owner.query(
    'DROP TRIGGER IF EXISTS calendar_intent_test ON core."deferredWorkspaceMigrationAction"',
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".calendar_intent_test()`,
  );
  await f.reset();
  await f.owner.query(
    'TRUNCATE core.workspace,core."connectedAccount",core."calendarChannel" CASCADE',
  );
  await f.owner.query('INSERT INTO core.workspace(id) VALUES($1)', [
    f.workspaceId,
  ]);
});

afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it('persists a PENDING durable calendar matching intent inside the save transaction and deletes it inside the matching commit', async () => {
  const h = await createHarness();
  let observedIntentsDuringQueue: Record<string, unknown>[] = [];
  h.contacts.add.mockImplementationOnce(async () => {
    observedIntentsDuringQueue = await intents();
  });
  const result = await h.save();
  expect(result.applied).toBe(true);
  expect(observedIntentsDuringQueue).toHaveLength(1);
  expect(observedIntentsDuringQueue[0]).toMatchObject({
    workspaceId: f.workspaceId,
    name: CALENDAR_IMPORT_MATCHING_INTENT_NAME,
    status: 'PENDING',
    attempts: 0,
  });
  expect(await intents()).toHaveLength(0);
  const [savedParticipant] = await f.read(PART);
  expect(savedParticipant).toMatchObject({
    personId: h.personId,
    workspaceMemberId: h.memberId,
  });
  const targets = await f.read(TARGET);
  expect(targets).toHaveLength(2);
  expect(targets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        targetPersonId: h.personId,
        isAutomaticallyAssigned: true,
      }),
      expect.objectContaining({
        targetCompanyId: h.companyId,
        isAutomaticallyAssigned: true,
      }),
    ]),
  );
});

it('inserts no durable calendar matching intent when saving an empty event batch', async () => {
  const h = await createHarness();
  const result = await h.save([]);
  expect(result).toEqual({ calendarEventIds: [], applied: true });
  expect(await intents()).toHaveLength(0);
});

it.each([
  ['skipped insert', 'RETURN NULL;'],
  ['rewritten status', "NEW.status := 'IN_PROGRESS'; RETURN NEW;"],
  [
    'rewritten payload',
    "NEW.payload := jsonb_set(NEW.payload, '{eventIds}', '[]'::jsonb, true); RETURN NEW;",
  ],
])(
  'rolls back calendarEvent, association, participant and audit if a BEFORE INSERT trigger causes %s on the durable intent row',
  async (_label, body) => {
    const h = await createHarness();
    await f.owner.query(
      `CREATE FUNCTION "${f.schemaName}".calendar_intent_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN ${body} END $$; CREATE TRIGGER calendar_intent_test BEFORE INSERT ON core."deferredWorkspaceMigrationAction" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".calendar_intent_test()`,
    );
    await expect(h.save()).rejects.toThrow(/matching intent/);
    for (const name of [EVENT, ASSOC, PART, TARGET])
      expect(await f.read(name)).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
    expect(await intents()).toHaveLength(0);
  },
);

it('rolls back the entire calendar save if a deferred trigger deletes the durable intent row before COMMIT', async () => {
  const h = await createHarness();
  await f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".calendar_intent_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN DELETE FROM core."deferredWorkspaceMigrationAction" WHERE id = NEW.id; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER calendar_intent_test AFTER INSERT ON core."deferredWorkspaceMigrationAction" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".calendar_intent_test()`,
  );
  await expect(h.save()).rejects.toThrow(
    'Calendar save matching intent changed before commit',
  );
  for (const name of [EVENT, ASSOC, PART, TARGET])
    expect(await f.read(name)).toHaveLength(0);
  expect(await audits()).toHaveLength(0);
  expect(await intents()).toHaveLength(0);
});

it('rolls back participant links, targets and matching audit if a deferred trigger resurrects the deleted intent row before COMMIT', async () => {
  const h = await createHarness();
  h.contacts.add.mockImplementationOnce(async () => {
    await f.owner.query(
      `CREATE FUNCTION "${f.schemaName}".calendar_intent_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN INSERT INTO core."deferredWorkspaceMigrationAction"(id,"workspaceId","applicationUniversalIdentifier",name,payload,position,status,attempts) VALUES(OLD.id,OLD."workspaceId",OLD."applicationUniversalIdentifier",OLD.name,OLD.payload,OLD.position,'IN_PROGRESS',OLD.attempts); RETURN OLD; END $$; CREATE CONSTRAINT TRIGGER calendar_intent_test AFTER DELETE ON core."deferredWorkspaceMigrationAction" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".calendar_intent_test()`,
    );
  });
  await expect(h.save()).rejects.toBeInstanceOf(CoreAuditPostCommitError);
  const [savedParticipant] = await f.read(PART);
  expect(savedParticipant).toMatchObject({
    personId: null,
    workspaceMemberId: null,
  });
  expect(await f.read(TARGET)).toHaveLength(0);
  expect(await audits()).toHaveLength(3);
  const remaining = await intents();
  expect(remaining).toHaveLength(1);
  expect(remaining[0].status).toBe('PENDING');
  expect(remaining[0].lastError).toBe(
    'Calendar matching intent remained after completion',
  );
});

it('recovers first-save participant matching and target reconciliation after contacts.add failure even if an identical re-save runs first', async () => {
  const h = await createHarness();
  h.contacts.add.mockRejectedValueOnce(new Error('contact queue down'));
  await expect(h.save()).rejects.toBeInstanceOf(CoreAuditPostCommitError);

  const afterFirstSaveIntents = await intents();
  expect(afterFirstSaveIntents).toHaveLength(1);
  expect(afterFirstSaveIntents[0].status).toBe('PENDING');
  const [unmatchedAfterFirstSave] = await f.read(PART);
  expect(unmatchedAfterFirstSave).toMatchObject({
    personId: null,
    workspaceMemberId: null,
  });

  await h.save();
  const [stillUnmatchedAfterResave] = await f.read(PART);
  expect(stillUnmatchedAfterResave).toMatchObject({
    personId: null,
    workspaceMemberId: null,
  });
  expect(await intents()).toHaveLength(1);

  const recovered = await h.participants.reconcileCalendarImportMatchingIntents(
    {
      workspaceId: f.workspaceId,
    },
  );
  expect(recovered).toEqual({
    processedIntents: 1,
    completedIntents: 1,
  });
  expect(await intents()).toHaveLength(0);
  const [matchedParticipant] = await f.read(PART);
  expect(matchedParticipant).toMatchObject({
    personId: h.personId,
    workspaceMemberId: h.memberId,
  });
  expect(await f.read(TARGET)).toHaveLength(2);
  const allAudits = await audits();
  expect(allAudits).toHaveLength(6);
  const saveOperationId = allAudits[0].operationId;
  const matchingAudits = allAudits.slice(3);
  for (const entry of matchingAudits) {
    expect(entry).toMatchObject({
      actor: h.operation.actor,
      initiator: h.operation.initiator,
      correlationId: h.operation.correlationId,
      causationId: saveOperationId,
    });
  }
});

it('replays a pending calendar intent after syncStage transitions to FAILED and refuses if sync is disabled, account is archived or account becomes omni-owned', async () => {
  const h = await createHarness();
  h.contacts.add.mockRejectedValueOnce(new Error('contact queue down'));
  await expect(h.save()).rejects.toBeInstanceOf(CoreAuditPostCommitError);

  await f.owner.query(
    `UPDATE core."calendarChannel" SET "syncStage"='FAILED',"syncStageStartedAt"='2030-01-02T00:00:00.000000Z' WHERE id=$1`,
    [h.channelId],
  );

  await f.owner.query(
    `UPDATE core."calendarChannel" SET "isSyncEnabled"=false WHERE id=$1`,
    [h.channelId],
  );
  await expect(
    h.participants.reconcileCalendarImportMatchingIntents({
      workspaceId: f.workspaceId,
    }),
  ).rejects.toThrow('Calendar matching recovery channel unavailable');
  await f.owner.query(
    `UPDATE core."calendarChannel" SET "isSyncEnabled"=true WHERE id=$1`,
    [h.channelId],
  );

  await f.owner.query(
    `UPDATE core."connectedAccount" SET "archivedAt"=now() WHERE id=$1`,
    [h.accountId],
  );
  await expect(
    h.participants.reconcileCalendarImportMatchingIntents({
      workspaceId: f.workspaceId,
    }),
  ).rejects.toThrow('Calendar matching recovery channel unavailable');
  await f.owner.query(
    `UPDATE core."connectedAccount" SET "archivedAt"=NULL WHERE id=$1`,
    [h.accountId],
  );

  const metadata = new DataSource({
    type: 'postgres',
    url: f.runtimeDatabaseUrl,
  });
  const nativeAccountId = randomUUID();
  const nativeChannelId = randomUUID();
  await metadata.initialize();
  try {
    await f.owner.query(
      'INSERT INTO core."connectedAccount"(id,"workspaceId",provider) VALUES($1,$2,\'app\')',
      [nativeAccountId, f.workspaceId],
    );
    await f.owner.query(
      'INSERT INTO core."messageChannel"(id,"workspaceId",type,"connectedAccountId") VALUES($1,$2,\'APP\',$3)',
      [nativeChannelId, f.workspaceId, nativeAccountId],
    );
    await bootstrapOmniAccountBinding(
      metadata,
      { kind: 'system', id: 'calendar-recovery-binding-fixture' },
      {
        workspaceId: f.workspaceId,
        platform: 'telegram',
        connectorInstanceId: 'calendar-recovery-binding-fixture',
        accountId: nativeAccountId,
        connectedAccountId: nativeAccountId,
        messageChannelId: nativeChannelId,
        idempotencyKey: randomUUID(),
        expectedRevision: '0',
      },
      async () => undefined,
    );
    await f.owner.query(
      'UPDATE core."omniAccountBinding" SET "connectedAccountId"=$1 WHERE "workspaceId"=$2 AND "connectedAccountId"=$3',
      [h.accountId, f.workspaceId, nativeAccountId],
    );
    await expect(
      h.participants.reconcileCalendarImportMatchingIntents({
        workspaceId: f.workspaceId,
      }),
    ).rejects.toThrow('Calendar matching recovery channel unavailable');
    const [failedAfterThreeAttempts] = await intents();
    expect(failedAfterThreeAttempts).toMatchObject({
      status: 'FAILED',
      attempts: 3,
    });
    await f.owner.query(
      'UPDATE core."omniAccountBinding" SET "connectedAccountId"=$1 WHERE "workspaceId"=$2 AND "connectedAccountId"=$3',
      [nativeAccountId, f.workspaceId, h.accountId],
    );
    await f.owner.query(
      'UPDATE core."deferredWorkspaceMigrationAction" SET status=\'PENDING\',attempts=0 WHERE id=$1',
      [failedAfterThreeAttempts.id],
    );
  } finally {
    await metadata.destroy();
  }

  const recovered = await h.participants.reconcileCalendarImportMatchingIntents(
    {
      workspaceId: f.workspaceId,
    },
  );
  expect(recovered).toEqual({
    processedIntents: 1,
    completedIntents: 1,
  });
  expect(await intents()).toHaveLength(0);
  const [matchedParticipant] = await f.read(PART);
  expect(matchedParticipant).toMatchObject({
    personId: h.personId,
    workspaceMemberId: h.memberId,
  });
});

it('fences a matching intent into FAILED with unsafeOutcome on NativeTransactionOutcomeUnknownError and refuses automatic replay', async () => {
  const h = await createHarness();
  let txCount = 0;
  const originalRunInTx = manager.runInWorkspaceTransaction.bind(manager);
  const unknownCommitError = new NativeTransactionOutcomeUnknownError(
    'commit',
    new Error('COMMIT ACK lost before matching completion'),
  );
  const txSpy = jest
    .spyOn(manager, 'runInWorkspaceTransaction')
    .mockImplementation((async (work: unknown, options: unknown) => {
      txCount += 1;
      if (txCount === 2) {
        throw unknownCommitError;
      }
      return originalRunInTx(work as never, options as never);
    }) as typeof manager.runInWorkspaceTransaction);

  await expect(h.save()).rejects.toBe(unknownCommitError);
  txSpy.mockRestore();

  const fenced = await intents();
  expect(fenced).toHaveLength(1);
  expect(fenced[0].status).toBe('FAILED');
  expect(fenced[0].payload).toMatchObject({
    unsafeOutcome: {
      reason: unknownCommitError.message,
    },
  });

  const retryResult =
    await h.participants.reconcileCalendarImportMatchingIntents({
      workspaceId: f.workspaceId,
    });
  expect(retryResult).toEqual({
    processedIntents: 0,
    completedIntents: 0,
  });
});

it('leaves no pending intent when COMMIT ACK is lost after the matching transaction actually committed', async () => {
  const h = await createHarness();
  let txCount = 0;
  const originalRunInTx = manager.runInWorkspaceTransaction.bind(manager);
  const ackLostError = new NativeTransactionOutcomeUnknownError(
    'commit',
    new Error('COMMIT ACK lost after actual matching commit'),
  );
  const txSpy = jest
    .spyOn(manager, 'runInWorkspaceTransaction')
    .mockImplementation((async (work: unknown, options: unknown) => {
      txCount += 1;
      const result = await originalRunInTx(work as never, options as never);
      if (txCount === 2) {
        throw ackLostError;
      }
      return result;
    }) as typeof manager.runInWorkspaceTransaction);

  await expect(h.save()).rejects.toBe(ackLostError);
  txSpy.mockRestore();

  expect(await intents()).toHaveLength(0);
  const [matchedParticipant] = await f.read(PART);
  expect(matchedParticipant).toMatchObject({
    personId: h.personId,
    workspaceMemberId: h.memberId,
  });
});

it('serializes concurrent recovery workers and observes background recovery completion cleanly if recovery finishes while contacts.add is awaiting', async () => {
  const h = await createHarness();
  h.contacts.add.mockImplementationOnce(async () => {
    const [r1, r2] = await Promise.all([
      h.participants.reconcileCalendarImportMatchingIntents({
        workspaceId: f.workspaceId,
      }),
      h.participants.reconcileCalendarImportMatchingIntents({
        workspaceId: f.workspaceId,
      }),
    ]);
    expect(r1.completedIntents + r2.completedIntents).toBe(1);
  });
  const result = await h.save();
  expect(result.applied).toBe(true);
  expect(await intents()).toHaveLength(0);
  const [matchedParticipant] = await f.read(PART);
  expect(matchedParticipant).toMatchObject({
    personId: h.personId,
    workspaceMemberId: h.memberId,
  });
  expect(await audits()).toHaveLength(6);
});
