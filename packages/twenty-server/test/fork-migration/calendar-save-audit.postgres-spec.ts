import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { bootstrapOmniAccountBinding } from 'src/modules/omnichannel/services/omni-binding-bootstrap';
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
import { CalendarSaveEventsService } from 'src/modules/calendar/calendar-event-import-manager/services/calendar-save-events.service';
import { CalendarEventParticipantService } from 'src/modules/calendar/calendar-event-participant-manager/services/calendar-event-participant.service';
import { type FetchedCalendarEvent } from 'src/modules/calendar/common/types/fetched-calendar-event.type';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
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

// Same real native repository/metadata fixture as ordinary-native-sync-run.
// Only postcommit CRM matching/contact enqueue and unrelated injected services are adapters.
const f = createOmniNativeMessageFixture({
  useStandardForeignKeyActions: true,
  additionalTables: [
    'company',
    'opportunity',
    'calendarEvent',
    'calendarEventParticipant',
    'calendarChannelEventAssociation',
    'calendarEventTarget',
    'callRecording',
  ],
});
const EVENT = 'calendarEvent',
  ASSOC = 'calendarChannelEventAssociation',
  PART = 'calendarEventParticipant',
  TARGET = 'calendarEventTarget',
  RECORD = 'callRecording';
const names = [EVENT, ASSOC, PART, TARGET, RECORD];
const table = (name: string) => `"${f.schemaName}"."${name}"`;
const manager = {
  getWorkspaceId: () => f.workspaceId,
  executeInWorkspaceContext: async <T>(work: () => Promise<T>) =>
    f.withContext(work),
  runInWorkspaceTransaction: async <T>(
    work: (scope: WorkspaceTransactionScope) => Promise<T>,
    options?: WorkspaceTransactionOptions,
  ) => f.dataSource.transaction(work, options),
  getRepository: () => {
    throw new Error('NATIVE_READ_ESCAPED_TRANSACTION');
  },
} as unknown as WorkspaceOrmManager;
const operation = (): CrmAuditOperation => ({
  workspaceId: f.workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'system', id: 'calendar-save-audit-test' },
});
const startedAt = '2030-01-01T00:00:00.123456Z';
let account: ConnectedAccountEntity,
  channel: CalendarChannelEntity,
  service: CalendarSaveEventsService,
  participants: CalendarEventParticipantService;
let match: jest.SpyInstance, flag: jest.Mock;
const proof = (
  selectedChannel = channel,
  selectedAccount = account,
): OrdinaryMetadataSyncRun => ({
  workspaceId: f.workspaceId,
  channelId: selectedChannel.id,
  connectedAccountId: selectedAccount.id,
  kind: 'calendar',
  stage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
  startedAt,
});
const event = (): FetchedCalendarEvent => ({
  id: 'external-event',
  title: 'Private meeting title',
  iCalUid: 'shared-ical-uid',
  description: 'Private meeting description',
  startsAt: '2030-01-01T10:00:00.000123Z',
  endsAt: '2030-01-01T11:00:00.000789Z',
  location: 'Private location',
  isFullDay: false,
  isCanceled: false,
  isPrivate: false,
  conferenceLinkLabel: 'Private link',
  conferenceLinkUrl: 'https://example.test/private-conference',
  externalCreatedAt: '2029-01-01T00:00:00Z',
  externalUpdatedAt: '2029-01-02T00:00:00Z',
  conferenceSolution: '',
  organizerHandle: 'organizer@example.test',
  status: 'confirmed',
  participants: [
    {
      displayName: 'Private attendee',
      handle: 'client@example.test',
      responseStatus: 'ACCEPTED',
      isOrganizer: false,
    },
  ],
});
const save = async (
  events = [event()],
  run: OrdinaryMetadataSyncRun | undefined = proof(),
  op = operation(),
  selectedChannel = channel,
  selectedAccount = account,
) =>
  service.saveCalendarEventsAndEnqueueContactCreationJob(
    events,
    selectedChannel,
    selectedAccount,
    f.workspaceId,
    op,
    run,
  );
const read = async (name: string) =>
  f.owner.query(
    `SELECT to_jsonb(row)::text AS row FROM ${table(name)} row ORDER BY id`,
  );
const graph = async () => Promise.all(names.map(read));
const audits = async () =>
  f.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "resourceId",id',
  );
const causeText = (error: unknown) => {
  const result: string[] = [];
  for (let i = 0; i < 6 && error instanceof Error; i++) {
    result.push(error.message);
    error = error.cause;
  }
  return result.join(' | ');
};
const nativeTrigger = async (
  name: string,
  timing: string,
  eventName: string,
  body: string,
  deferred = false,
) =>
  f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".calendar_save_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$; CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER calendar_save_test ${timing} ${eventName} ON ${table(name)} ${deferred ? 'DEFERRABLE INITIALLY DEFERRED ' : ''}FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".calendar_save_test()`,
  );
const auditTrigger = async (body: string) =>
  f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".calendar_save_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN ${body} RETURN NEW; END $$; CREATE TRIGGER calendar_save_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".calendar_save_test()`,
  );
const seedCore = async (
  selectedAccount: ConnectedAccountEntity,
  selectedChannel: CalendarChannelEntity,
) => {
  await f.owner.query(
    'INSERT INTO core."connectedAccount"(id,"workspaceId",provider,"handleAliases") VALUES($1,$2,$3,$4)',
    [
      selectedAccount.id,
      f.workspaceId,
      selectedAccount.provider,
      JSON.stringify(selectedAccount.handleAliases),
    ],
  );
  await f.owner.query(
    'INSERT INTO core."calendarChannel"(id,"workspaceId","connectedAccountId",handle,"isSyncEnabled","syncStatus","syncStage","syncStageStartedAt","isContactAutoCreationEnabled","contactAutoCreationPolicy","excludePrivateEvents") VALUES($1,$2,$3,$4,true,\'ONGOING\',$5,$6,false,\'AS_PARTICIPANT_AND_ORGANIZER\',false)',
    [
      selectedChannel.id,
      f.workspaceId,
      selectedAccount.id,
      selectedChannel.handle,
      proof().stage,
      startedAt,
    ],
  );
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
    'DROP TRIGGER IF EXISTS calendar_save_audit ON crm_audit."crmAuditEntry"',
  );
  for (const name of names)
    await f.owner.query(
      `DROP TRIGGER IF EXISTS calendar_save_test ON ${table(name)}`,
    );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".calendar_save_test()`,
  );
  await f.owner.query(`DROP TABLE IF EXISTS ${table('calendar_save_child')}`);
  await f.owner.query(
    `DROP INDEX IF EXISTS "${f.schemaName}".calendar_save_pair`,
  );
  await f.reset();
  await f.owner.query(
    'TRUNCATE core.workspace,core."connectedAccount",core."calendarChannel" CASCADE',
  );
  await f.owner.query('INSERT INTO core.workspace(id) VALUES($1)', [
    f.workspaceId,
  ]);
  account = {
    id: randomUUID(),
    workspaceId: f.workspaceId,
    provider: ConnectedAccountProvider.GOOGLE,
    handleAliases: ['organizer@example.test'],
  } as ConnectedAccountEntity;
  channel = {
    id: randomUUID(),
    workspaceId: f.workspaceId,
    connectedAccountId: account.id,
    handle: 'organizer@example.test',
    isSyncEnabled: true,
    isContactAutoCreationEnabled: false,
    contactAutoCreationPolicy: 'AS_PARTICIPANT_AND_ORGANIZER',
    excludePrivateEvents: false,
  } as CalendarChannelEntity;
  await seedCore(account, channel);
  participants = new CalendarEventParticipantService(
    manager,
    {} as never,
    { add: jest.fn() } as never,
  );
  match = jest
    .spyOn(participants, 'matchParticipantsAndEnqueueContactCreationJob')
    .mockResolvedValue(undefined);
  flag = jest.fn().mockResolvedValue(true);
  service = Object.assign(Object.create(CalendarSaveEventsService.prototype), {
    workspaceOrmManager: manager,
    calendarEventParticipantService: participants,
    featureFlagService: { isFeatureEnabled: flag },
  });
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it('commits the actual three-object graph and one operation before postcommit matching', async () => {
  match.mockImplementation(async () => {
    expect(await audits()).toHaveLength(3);
    expect(await f.read(EVENT)).toHaveLength(1);
  });
  const result = await save(),
    rows = await audits();
  expect(result).toEqual({
    applied: true,
    calendarEventIds: [(await f.read(EVENT))[0].id],
  });
  expect(rows).toHaveLength(3);
  expect(
    new Set(rows.map((row: { operationId: string }) => row.operationId)).size,
  ).toBe(1);
  for (const row of rows)
    expect(row).toMatchObject({
      resourceKind: 'crmRecord',
      action: 'create',
      actor: { kind: 'system', id: 'calendar-save-audit-test' },
    });
  for (const secret of [
    'Private meeting title',
    'Private meeting description',
    'client@example.test',
    'https://example.test/private-conference',
  ])
    expect(JSON.stringify(rows)).not.toContain(secret);
  expect(match).toHaveBeenCalledTimes(1);
  expect(match.mock.calls[0][0].savedParticipantIds).toEqual([
    (await f.read(PART))[0].id,
  ]);
});

it('updates Event/Association/Participant and deletes the missing only-channel participant in one operation', async () => {
  const initial = event();
  initial.participants.push({
    ...initial.participants[0],
    handle: 'removed@example.test',
  });
  await save([initial]);
  const oldParticipants = await f.read(PART),
    removed = oldParticipants.find(
      (row: { handle: string }) => row.handle === 'removed@example.test',
    );
  const oldAudits = await audits(),
    next = event();
  next.title = 'Changed title';
  next.recurringEventExternalId = 'recurrence-2';
  next.participants[0].displayName = 'Changed attendee';
  await save([next]);
  const rows = (await audits()).filter(
    (row: { id: string }) =>
      !oldAudits.some((old: { id: string }) => old.id === row.id),
  );
  expect(rows).toHaveLength(4);
  expect(
    new Set(rows.map((row: { operationId: string }) => row.operationId)).size,
  ).toBe(1);
  expect(
    rows.filter((row: { action: string }) => row.action === 'delete'),
  ).toEqual([expect.objectContaining({ resourceId: removed.id })]);
  expect(await f.read(PART)).toEqual([
    expect.objectContaining({
      handle: 'client@example.test',
      displayName: 'Changed attendee',
    }),
  ]);
  expect((await f.read(EVENT))[0].title).toBe('Changed title');
  expect((await f.read(ASSOC))[0].recurringEventExternalId).toBe(
    'recurrence-2',
  );
});

it('keeps an identical replay graph and audit unchanged', async () => {
  await save();
  const before = await graph(),
    entries = await audits();
  await save();
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual(entries);
});

it('preserves matched person links, targets and precision-rich recording data when changing event and attendee', async () => {
  await save();
  const root = (await f.read(EVENT))[0],
    personId = randomUUID(),
    targetId = randomUUID(),
    recordingId = randomUUID();
  await f.owner.query(
    `INSERT INTO ${table('person')}(id,"nameFirstName") VALUES($1,'Matched')`,
    [personId],
  );
  await f.owner.query(`UPDATE ${table(PART)} SET "personId"=$1`, [personId]);
  await f.owner.query(
    `INSERT INTO ${table(TARGET)}(id,"calendarEventId","targetPersonId","isManuallyAssigned") VALUES($1,$2,$3,true)`,
    [targetId, root.id, personId],
  );
  await f.owner.query(
    `INSERT INTO ${table(RECORD)}(id,"calendarEventId",video,transcript,"updatedAt") VALUES($1,$2,$3::jsonb,'{"n":900719925474099312345,"secret":"recording"}'::jsonb,'2030-01-01T00:00:00.000789Z')`,
    [
      recordingId,
      root.id,
      JSON.stringify([{ fileId: randomUUID(), name: 'private.mp4' }]),
    ],
  );
  const retained = await Promise.all([TARGET, RECORD].map(read)),
    next = event();
  next.title = 'New title';
  next.participants[0].displayName = 'New name';
  await save([next]);
  expect(await Promise.all([TARGET, RECORD].map(read))).toEqual(retained);
  expect((await f.read(PART))[0].personId).toBe(personId);
});

it.each(['event-update', 'participant-insert'] as const)(
  'audits actual effects when %s is skipped by a real trigger',
  async (kind) => {
    if (kind === 'event-update') await save();
    const oldAudits = await audits();
    await nativeTrigger(
      kind === 'event-update' ? EVENT : PART,
      'BEFORE',
      kind === 'event-update' ? 'UPDATE' : 'INSERT',
      'RETURN NULL;',
    );
    const next = event();
    next.title = 'Skipped changed title';
    const result = await save([next]);
    expect(result.applied).toBe(true);
    if (kind === 'event-update') {
      expect((await f.read(EVENT))[0].title).toBe('Private meeting title');
      expect(await audits()).toEqual(oldAudits);
    } else {
      expect(await f.read(PART)).toEqual([]);
      expect(await audits()).toHaveLength(2);
      expect(match.mock.calls[0][0].savedParticipantIds).toEqual([]);
    }
  },
);

it.each([EVENT, ASSOC, PART])(
  'rolls back every preceding write if %s SQL fails',
  async (name) => {
    const before = await graph();
    await nativeTrigger(
      name,
      'BEFORE',
      'INSERT',
      "RAISE EXCEPTION 'calendar save phase refusal';",
    );
    const failure = await save().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(causeText(failure)).toContain('calendar save phase refusal');
    expect(await graph()).toEqual(before);
    expect(await audits()).toEqual([]);
    expect(match).not.toHaveBeenCalled();
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it('rolls back all graph writes and native events on audit failure', async () => {
  const before = await graph();
  await auditTrigger("RAISE EXCEPTION 'calendar save audit refusal';");
  const failure = await save().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(causeText(failure)).toContain('calendar save audit refusal');
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(match).not.toHaveBeenCalled();
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('rolls back the first participant batch when the second real INSERT batch fails', async () => {
  const next = event();
  next.participants = Array.from({ length: 101 }, (_, index) => ({
    ...next.participants[0],
    handle: `attendee-${index}@example.test`,
  }));
  await nativeTrigger(
    PART,
    'BEFORE',
    'INSERT',
    "IF NEW.handle='attendee-100@example.test' THEN RAISE EXCEPTION 'second participant batch refused'; END IF; RETURN NEW;",
  );
  const before = await graph(),
    failure = await save([next]).then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(causeText(failure)).toContain('second participant batch refused');
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(match).not.toHaveBeenCalled();
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('refuses a trigger changing a declared CREATE field instead of adopting RETURNING as proof', async () => {
  const before = await graph();
  await nativeTrigger(
    EVENT,
    'BEFORE',
    'INSERT',
    "NEW.title='silently changed'; RETURN NEW;",
  );
  await expect(save()).rejects.toThrow();
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(match).not.toHaveBeenCalled();
});

it('rejects a skipped Event insert before its dependent association and participant plan can persist', async () => {
  const before = await graph();
  await nativeTrigger(EVENT, 'BEFORE', 'INSERT', 'RETURN NULL;');
  await expect(save()).rejects.toThrow();
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(match).not.toHaveBeenCalled();
});

it('retains exact recording postimages rather than adopting an Event trigger side effect', async () => {
  await save();
  const root = (await f.read(EVENT))[0];
  await f.owner.query(
    `INSERT INTO ${table(RECORD)}(id,"calendarEventId",transcript) VALUES($1,$2,'{"n":900719925474099312345}'::jsonb)`,
    [randomUUID(), root.id],
  );
  const before = await graph(),
    entries = await audits(),
    next = event();
  next.title = 'Changed title';
  await nativeTrigger(
    EVENT,
    'AFTER',
    'UPDATE',
    `UPDATE ${table(RECORD)} SET transcript='{"n":900719925474099312346}'::jsonb WHERE "calendarEventId"=NEW.id; RETURN NEW;`,
  );
  await expect(save([next])).rejects.toThrow();
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual(entries);
});

it('refuses an Association trigger rewriting its already inserted parent before the next phase', async () => {
  const before = await graph();
  await nativeTrigger(
    ASSOC,
    'AFTER',
    'INSERT',
    `UPDATE ${table(EVENT)} SET title='late parent drift' WHERE id=NEW."calendarEventId"; RETURN NEW;`,
  );
  await expect(save()).rejects.toThrow();
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual([]);
});

it.each(['graph', 'aliases', 'run'] as const)(
  'rejects late %s drift after audit flush and restores graph and source',
  async (kind) => {
    const before = await graph(),
      core = await f.owner.query(
        'SELECT to_jsonb(row)::text AS row FROM core."calendarChannel" row ORDER BY id',
      ),
      accounts = await f.owner.query(
        'SELECT to_jsonb(row)::text AS row FROM core."connectedAccount" row ORDER BY id',
      );
    const body =
      kind === 'graph'
        ? `UPDATE ${table(EVENT)} SET title='late audit drift';`
        : kind === 'aliases'
          ? `UPDATE core."connectedAccount" SET "handleAliases"='["changed@example.test"]'::jsonb WHERE id='${account.id}';`
          : `UPDATE core."calendarChannel" SET "syncStageStartedAt"="syncStageStartedAt"+interval '1 microsecond' WHERE id='${channel.id}';`;
    await auditTrigger(body);
    await expect(save()).rejects.toThrow();
    expect(await graph()).toEqual(before);
    expect(await audits()).toEqual([]);
    expect(
      await f.owner.query(
        'SELECT to_jsonb(row)::text AS row FROM core."calendarChannel" row ORDER BY id',
      ),
    ).toEqual(core);
    expect(
      await f.owner.query(
        'SELECT to_jsonb(row)::text AS row FROM core."connectedAccount" row ORDER BY id',
      ),
    ).toEqual(accounts);
    expect(match).not.toHaveBeenCalled();
  },
);

it('rejects duplicate participant keys before the first Event write', async () => {
  const next = event();
  next.participants.push({
    ...next.participants[0],
    displayName: 'Conflicting same handle',
  });
  const before = await graph();
  const failure = await save([next]).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(causeText(failure)).toContain(
    'Calendar save ambiguous duplicate participant identity',
  );
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(match).not.toHaveBeenCalled();
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('rolls back a late retained binding that makes the admitted import account owned', async () => {
  const metadata = new DataSource({
    type: 'postgres',
    url: f.runtimeDatabaseUrl,
  });
  const nativeAccountId = randomUUID(),
    nativeChannelId = randomUUID();
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
      { kind: 'system', id: 'calendar-save-binding-fixture' },
      {
        workspaceId: f.workspaceId,
        platform: 'telegram',
        connectorInstanceId: 'calendar-save-binding-fixture',
        accountId: nativeAccountId,
        connectedAccountId: nativeAccountId,
        messageChannelId: nativeChannelId,
        idempotencyKey: randomUUID(),
        expectedRevision: '0',
      },
      async () => undefined,
    );
    const [binding] = await f.owner.query(
      'SELECT id,status FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND "connectedAccountId"=$2',
      [f.workspaceId, nativeAccountId],
    );
    expect(binding.status).toBe('inactive');
    const before = await graph(),
      entries = await audits();
    const bindingBefore = await f.owner.query(
      'SELECT to_jsonb(row)::text AS row FROM core."omniAccountBinding" row WHERE id=$1',
      [binding.id],
    );
    await auditTrigger(
      `UPDATE core."omniAccountBinding" SET "connectedAccountId"='${account.id}' WHERE id='${binding.id}';`,
    );
    const failure = await save().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(causeText(failure)).toContain(
      'Calendar save run ownership changed before commit',
    );
    expect(await graph()).toEqual(before);
    expect(await audits()).toEqual(entries);
    expect(
      await f.owner.query(
        'SELECT to_jsonb(row)::text AS row FROM core."omniAccountBinding" row WHERE id=$1',
        [binding.id],
      ),
    ).toEqual(bindingBefore);
    expect(match).not.toHaveBeenCalled();
  } finally {
    await metadata.destroy();
  }
});

// Exercise real PostgreSQL stored generated values; the narrow expression has
// the same title-derived tsvector mechanism as the production search column.
const withGeneratedCalendarSearch = async (work: () => Promise<void>) => {
  const [original] = await f.owner.query(
    `SELECT format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS required, a.attgenerated AS generated, pg_get_expr(d.adbin,d.adrelid) AS expression FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::regclass AND a.attname='searchVector' AND NOT a.attisdropped`,
    [table(EVENT)],
  );
  expect(original).toBeDefined();
  await f.owner.query(`ALTER TABLE ${table(EVENT)} DROP COLUMN "searchVector"`);
  await f.owner.query(
    `ALTER TABLE ${table(EVENT)} ADD COLUMN "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig,COALESCE(title,''))) STORED`,
  );
  try {
    await work();
  } finally {
    await f.owner.query(`DROP TABLE IF EXISTS ${table('calendar_save_child')}`);
    await f.owner.query(
      `DROP INDEX IF EXISTS "${f.schemaName}".calendar_save_pair`,
    );
    await f.owner.query(
      `ALTER TABLE ${table(EVENT)} DROP COLUMN "searchVector"`,
    );
    await f.owner.query(
      `ALTER TABLE ${table(EVENT)} ADD COLUMN "searchVector" ${original.type}${original.generated ? ` GENERATED ALWAYS AS (${original.expression}) STORED` : original.expression ? ` DEFAULT ${original.expression}` : ''}${original.required ? ' NOT NULL' : ''}`,
    );
  }
};

it('audits a real generated searchVector recomputed from a changed title', async () => {
  await withGeneratedCalendarSearch(async () => {
    await save();
    const [before] = await f.owner.query(
        `SELECT id,"searchVector"::text AS vector FROM ${table(EVENT)}`,
      ),
      entries = await audits();
    const next = event();
    next.title = 'Replacement searchable meeting';
    await save([next]);
    const [after] = await f.owner.query(
      `SELECT id,"searchVector"::text AS vector,"searchVector"=to_tsvector('simple'::regconfig,title) AS correct FROM ${table(EVENT)}`,
    );
    expect(after.id).toBe(before.id);
    expect(after.correct).toBe(true);
    expect(after.vector).not.toBe(before.vector);
    const added = (await audits()).filter(
      (row: { id: string }) =>
        !entries.some((previous: { id: string }) => previous.id === row.id),
    );
    expect(added).toEqual([
      expect.objectContaining({ action: 'update', resourceId: before.id }),
    ]);
  });
});

it('refuses generated searchVector ON UPDATE CASCADE without modifying its unaudited child', async () => {
  await withGeneratedCalendarSearch(async () => {
    await save();
    const root = (await f.read(EVENT))[0];
    await f.owner.query(
      `CREATE UNIQUE INDEX calendar_save_pair ON ${table(EVENT)}(id,"searchVector")`,
    );
    await f.owner.query(
      `CREATE TABLE ${table('calendar_save_child')}(id uuid PRIMARY KEY,"eventId" uuid,vector tsvector,FOREIGN KEY("eventId",vector) REFERENCES ${table(EVENT)}(id,"searchVector") ON UPDATE CASCADE)`,
    );
    await f.owner.query(
      `GRANT SELECT ON ${table('calendar_save_child')} TO "${f.roleName}"`,
    );
    await f.owner.query(
      `INSERT INTO ${table('calendar_save_child')}(id,"eventId",vector) SELECT $1,id,"searchVector" FROM ${table(EVENT)} WHERE id=$2`,
      [randomUUID(), root.id],
    );
    const childBefore = await read('calendar_save_child'),
      probe = f.owner.createQueryRunner();
    await probe.connect();
    await probe.startTransaction();
    try {
      await probe.query(
        `UPDATE ${table(EVENT)} SET title='Raw generated cascade proof' WHERE id=$1`,
        [root.id],
      );
      expect(
        await probe.query(
          `SELECT vector=to_tsvector('simple'::regconfig,'Raw generated cascade proof') AS cascaded FROM ${table('calendar_save_child')}`,
        ),
      ).toEqual([{ cascaded: true }]);
    } finally {
      await probe.rollbackTransaction();
      await probe.release();
    }
    const before = await graph(),
      entries = await audits(),
      next = event();
    next.title = 'Audited generated cascade refusal';
    const failure = await save([next]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(causeText(failure)).toContain(
      'Native audit excludes referential UPDATE effects',
    );
    expect(await graph()).toEqual(before);
    expect(await audits()).toEqual(entries);
    expect(await read('calendar_save_child')).toEqual(childBefore);
  });
});

it('drains deferred graph corruption before confirming graph and audit', async () => {
  const before = await graph();
  await nativeTrigger(
    ASSOC,
    'AFTER',
    'INSERT',
    `UPDATE ${table(EVENT)} SET title='deferred corruption' WHERE id=NEW."calendarEventId"; RETURN NEW;`,
    true,
  );
  expect(
    await f.owner.query(
      "SELECT tgdeferrable,tginitdeferred FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname='calendar_save_test'",
      [table(ASSOC)],
    ),
  ).toEqual([{ tgdeferrable: true, tginitdeferred: true }]);
  await expect(save()).rejects.toThrow();
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(match).not.toHaveBeenCalled();
});

it('captures nested provider inputs and operation before the feature-flag await', async () => {
  const next = event(),
    op = operation();
  flag.mockImplementationOnce(async () => {
    next.title = 'mutated title';
    next.participants[0].handle = 'mutated@example.test';
    next.participants.push({ ...next.participants[0] });
    op.actor = { kind: 'system', id: 'mutated-actor' };
    return true;
  });
  await save([next], proof(), op);
  expect((await f.read(EVENT))[0].title).toBe('Private meeting title');
  expect(await f.read(PART)).toEqual([
    expect.objectContaining({ handle: 'client@example.test' }),
  ]);
  for (const row of await audits())
    expect(row.actor).toEqual({
      kind: 'system',
      id: 'calendar-save-audit-test',
    });
});

it.each(['stale', 'disabled', 'foreign-operation'] as const)(
  'refuses %s before writes or matching',
  async (kind) => {
    const run = { ...proof() },
      op = operation();
    if (kind === 'stale') run.startedAt = '2030-01-01T00:00:00.123455Z';
    if (kind === 'disabled')
      await f.owner.query(
        'UPDATE core."calendarChannel" SET "isSyncEnabled"=false WHERE id=$1',
        [channel.id],
      );
    if (kind === 'foreign-operation') op.workspaceId = randomUUID();
    const before = await graph();
    if (kind === 'foreign-operation')
      await expect(save([event()], run, op)).rejects.toThrow();
    else
      expect(await save([event()], run, op)).toEqual({
        calendarEventIds: [],
        applied: false,
      });
    expect(await graph()).toEqual(before);
    expect(await audits()).toEqual([]);
    expect(match).not.toHaveBeenCalled();
  },
);

it('supports the no-run manual persistence mode with a strict audited transaction', async () => {
  const result = await service.saveCalendarEventsAndEnqueueContactCreationJob(
    [event()],
    channel,
    account,
    f.workspaceId,
    operation(),
  );
  expect(result.applied).toBe(true);
  expect(await audits()).toHaveLength(3);
});

it('reports matching failure as known committed while retaining the graph and audit', async () => {
  match.mockRejectedValueOnce(new Error('matching unavailable'));
  await expect(save()).rejects.toBeInstanceOf(CoreAuditPostCommitError);
  for (const name of [EVENT, ASSOC, PART])
    expect(await f.read(name)).toHaveLength(1);
  expect(await audits()).toHaveLength(3);
  expect(match).toHaveBeenCalledTimes(1);
});

it.each([ConnectedAccountProvider.GOOGLE, ConnectedAccountProvider.MICROSOFT])(
  'preserves %s organizer and attendee sharing roles',
  async (provider) => {
    account.provider = provider;
    await f.owner.query(
      'UPDATE core."connectedAccount" SET provider=$1 WHERE id=$2',
      [provider, account.id],
    );
    const initial = event();
    initial.participants = [
      {
        displayName: 'Organizer',
        handle: 'organizer@example.test',
        responseStatus: 'ACCEPTED',
        isOrganizer: true,
      },
      {
        displayName: 'Second',
        handle: 'second@example.test',
        responseStatus: 'ACCEPTED',
        isOrganizer: false,
      },
    ];
    await save([initial]);
    const secondAccount = {
        ...account,
        id: randomUUID(),
        handleAliases: ['second@example.test'],
      },
      secondChannel = {
        ...channel,
        id: randomUUID(),
        connectedAccountId: secondAccount.id,
        handle: 'second@example.test',
      };
    await seedCore(secondAccount, secondChannel);
    const fetched = {
      ...initial,
      id:
        provider === ConnectedAccountProvider.MICROSOFT
          ? 'different-provider-id'
          : initial.id,
      title: 'Attendee must not replace organizer title',
      participants: initial.participants.map((participant) => ({
        ...participant,
        responseStatus: 'DECLINED',
      })),
    };
    await save(
      [fetched],
      proof(secondChannel, secondAccount),
      operation(),
      secondChannel,
      secondAccount,
    );
    expect(await f.read(EVENT)).toEqual([
      expect.objectContaining({ title: initial.title }),
    ]);
    expect(await f.read(ASSOC)).toHaveLength(2);
    const people = await f.read(PART);
    expect(
      people.find(
        (row: { handle: string }) => row.handle === 'organizer@example.test',
      ).responseStatus,
    ).toBe('ACCEPTED');
    expect(
      people.find(
        (row: { handle: string }) => row.handle === 'second@example.test',
      ).responseStatus,
    ).toBe('DECLINED');
  },
);

it('rejects populated incoming ON UPDATE CASCADE rather than modifying an unaudited child', async () => {
  await save();
  const root = (await f.read(EVENT))[0];
  await f.owner.query(
    `CREATE UNIQUE INDEX calendar_save_pair ON ${table(EVENT)}(id,title)`,
  );
  await f.owner.query(
    `CREATE TABLE ${table('calendar_save_child')}(id uuid PRIMARY KEY,"eventId" uuid,title text,FOREIGN KEY("eventId",title) REFERENCES ${table(EVENT)}(id,title) ON UPDATE CASCADE)`,
  );
  await f.owner.query(
    `GRANT SELECT ON ${table('calendar_save_child')} TO "${f.roleName}"`,
  );
  await f.owner.query(
    `INSERT INTO ${table('calendar_save_child')} VALUES($1,$2,$3)`,
    [randomUUID(), root.id, root.title],
  );
  const before = await graph(),
    entries = await audits(),
    children = await read('calendar_save_child'),
    next = event();
  next.title = 'Would cascade';
  await expect(save([next])).rejects.toThrow();
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual(entries);
  expect(await read('calendar_save_child')).toEqual(children);
});

it('rejects a populated unknown Participant delete cascade before removing the attendee', async () => {
  await save();
  const participant = (await f.read(PART))[0];
  await f.owner.query(
    `CREATE TABLE ${table('calendar_save_child')}(id uuid PRIMARY KEY,"participantId" uuid REFERENCES ${table(PART)}(id) ON DELETE CASCADE)`,
  );
  await f.owner.query(
    `GRANT SELECT ON ${table('calendar_save_child')} TO "${f.roleName}"`,
  );
  await f.owner.query(
    `INSERT INTO ${table('calendar_save_child')} VALUES($1,$2)`,
    [randomUUID(), participant.id],
  );
  const before = await graph(),
    entries = await audits(),
    children = await read('calendar_save_child'),
    next = event();
  next.participants = [];
  await expect(save([next])).rejects.toThrow();
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual(entries);
  expect(await read('calendar_save_child')).toEqual(children);
});

it('serializes concurrent same-channel save plans and keeps one actual graph', async () => {
  await Promise.all([save(), save()]);
  for (const name of [EVENT, ASSOC, PART])
    expect(await f.read(name)).toHaveLength(1);
  expect(await audits()).toHaveLength(3);
});

it.each(['import', 'manual'] as const)(
  'keeps actual graph/audit after lost COMMIT ACK in %s mode without matching',
  async (mode) => {
    const client = await f.pool.connect(),
      query = client.query.bind(client);
    let failed = false;
    jest.spyOn(client, 'query').mockImplementation((async (
      sql: string,
      values?: unknown[],
    ) => {
      const result = await query(sql, values);
      if (sql === 'COMMIT' && !failed) {
        failed = true;
        throw new Error('calendar-save ACK lost');
      }
      return result;
    }) as typeof client.query);
    jest
      .spyOn(f.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    const saving =
      mode === 'import'
        ? save()
        : service.saveCalendarEventsAndEnqueueContactCreationJob(
            [event()],
            channel,
            account,
            f.workspaceId,
            operation(),
          );
    await expect(saving).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
    for (const name of [EVENT, ASSOC, PART])
      expect(await f.read(name)).toHaveLength(1);
    expect(await audits()).toHaveLength(3);
    expect(match).not.toHaveBeenCalled();
  },
);
