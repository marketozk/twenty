import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CalendarChannelSyncStage } from 'twenty-shared/types';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { deleteOrdinarySyncCalendarAssociationsWithAudit } from 'src/engine/core-modules/crm-audit/delete-ordinary-sync-calendar-associations-with-audit';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
import { bootstrapOmniAccountBinding } from 'src/modules/omnichannel/services/omni-binding-bootstrap';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';

jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
const f = createOmniNativeMessageFixture({
  useStandardForeignKeyActions: true,
  additionalTables: [
    'calendarEvent',
    'calendarEventParticipant',
    'calendarChannelEventAssociation',
    'calendarEventTarget',
    'callRecording',
    'company',
    'opportunity',
    'workspaceMember',
  ],
});
const metadata = new DataSource({
  type: 'postgres',
  url: f.runtimeDatabaseUrl,
  extra: { max: 2, statement_timeout: 10000 },
});
const EVENT = 'calendarEvent',
  ASSOC = 'calendarChannelEventAssociation',
  PART = 'calendarEventParticipant',
  TARGET = 'calendarEventTarget',
  RECORD = 'callRecording';
const table = (name: string) => `"${f.schemaName}"."${name}"`;
const names = [EVENT, ASSOC, PART, TARGET, RECORD, 'person'];
let accountId: string, channelId: string, messageChannelId: string;
const startedAt = '2030-01-01T00:00:00.123456Z';
const proof = (): OrdinaryMetadataSyncRun => ({
  workspaceId: f.workspaceId,
  connectedAccountId: accountId,
  channelId,
  kind: 'calendar',
  stage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_ONGOING,
  startedAt,
});
const operation = (): CrmAuditOperation => ({
  workspaceId: f.workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'system', id: 'calendar-sync-cleanup-test' },
});
const clean = async (
  eventExternalIds: string[] = ['selected'],
  expectedRun = proof(),
  op = operation(),
) =>
  f.withContext(() =>
    f.dataSource.transaction(
      (scope) =>
        deleteOrdinarySyncCalendarAssociationsWithAudit({
          scope,
          operation: op,
          expectedRun,
          eventExternalIds,
        }),
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
const read = async (name: string) =>
  f.owner.query(
    `SELECT to_jsonb(row)::text AS row FROM ${table(name)} row ORDER BY id`,
  );
const graph = async () => Promise.all(names.map(read));
const ids = async (name: string) =>
  (await f.owner.query(`SELECT id FROM ${table(name)} ORDER BY id`)).map(
    (row: { id: string }) => row.id,
  );
const audits = async () =>
  f.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "resourceId"',
  );
const core = async () =>
  Promise.all(
    ['connectedAccount', 'calendarChannel'].map((name) =>
      f.owner.query(
        `SELECT to_jsonb(row)::text AS row FROM core."${name}" row ORDER BY id`,
      ),
    ),
  );
const recordingValues = async () =>
  f.owner.query(
    `SELECT (to_jsonb(row)-'calendarEventId')::text AS row FROM ${table(RECORD)} row ORDER BY id`,
  );
const seed = async (externalId = 'selected') => {
  const s = {
    eventId: randomUUID(),
    otherEventId: randomUUID(),
    personId: randomUUID(),
    associationId: randomUUID(),
    trashedAssociationId: randomUUID(),
    participantId: randomUUID(),
    targetId: randomUUID(),
    recordingId: randomUUID(),
  };
  await f.owner.query(
    `INSERT INTO ${table('person')}(id,"nameFirstName") VALUES($1,'Sync cleanup person')`,
    [s.personId],
  );
  await f.owner.query(
    `INSERT INTO ${table(EVENT)}(id,title,"iCalUid") VALUES($1,'selected event',$3),($2,'unrelated orphan',$4)`,
    [s.eventId, s.otherEventId, randomUUID(), randomUUID()],
  );
  await f.owner.query(
    `INSERT INTO ${table(ASSOC)}(id,"calendarEventId","calendarChannelId","eventExternalId","deletedAt") VALUES($1,$3,$4,$5,NULL),($2,$3,$4,'old trashed',clock_timestamp())`,
    [s.associationId, s.trashedAssociationId, s.eventId, channelId, externalId],
  );
  await f.owner.query(
    `INSERT INTO ${table(PART)}(id,"calendarEventId","personId",handle,"responseStatus") VALUES($1,$2,$3,'private-sync@example.test','ACCEPTED')`,
    [s.participantId, s.eventId, s.personId],
  );
  await f.owner.query(
    `INSERT INTO ${table(TARGET)}(id,"calendarEventId","targetPersonId","isManuallyAssigned","isAutomaticallyAssigned") VALUES($1,$2,$3,true,false)`,
    [s.targetId, s.eventId, s.personId],
  );
  await f.owner.query(
    `INSERT INTO ${table(RECORD)}(id,"calendarEventId",video,transcript,"updatedAt") VALUES($1,$2,$3::jsonb,'{"n":900719925474099312345,"secret":"sync-private-transcript"}'::jsonb,'2026-02-03T04:05:06.000789Z')`,
    [
      s.recordingId,
      s.eventId,
      JSON.stringify([
        { fileId: randomUUID(), name: 'sync-private-video.mp4' },
      ]),
    ],
  );
  return s;
};
const auditTrigger = async (body: string) =>
  f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".calendar_sync_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN ${body} RETURN NEW; END $$; CREATE TRIGGER calendar_sync_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".calendar_sync_test()`,
  );
const nativeTrigger = async (name: string, body: string) =>
  f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".calendar_sync_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$; CREATE TRIGGER calendar_sync_test BEFORE DELETE ON ${table(name)} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".calendar_sync_test()`,
  );
const causeText = (error: unknown) => {
  const messages: string[] = [];
  for (let n = 0; n < 6 && error instanceof Error; n++) {
    messages.push(error.message);
    error = error.cause;
  }
  return messages.join(' | ');
};

beforeAll(async () => {
  await f.initialize();
  await f.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid,ADD provider text,ADD "applicationId" uuid,ADD "connectionProviderId" uuid,ADD "archivedAt" timestamptz',
  );
  await f.owner.query(
    'ALTER TABLE core."messageChannel" ADD "connectedAccountId" uuid',
  );
  // Same core run fields consumed by the existing ordinary-native-sync-run
  // fixture. Native graph and its CASCADE/SET NULL FKs use standard metadata.
  await f.owner.query(
    'CREATE TABLE core."calendarChannel"(id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL,"connectedAccountId" uuid NOT NULL REFERENCES core."connectedAccount"(id),"isSyncEnabled" boolean,"syncStage" text,"syncStageStartedAt" timestamptz)',
  );
  await f.owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "${f.roleName}"`,
  );
  await metadata.initialize();
});
beforeEach(async () => {
  await f.owner.query(
    'DROP TRIGGER IF EXISTS calendar_sync_audit ON crm_audit."crmAuditEntry"',
  );
  for (const name of [EVENT, ASSOC])
    await f.owner.query(
      `DROP TRIGGER IF EXISTS calendar_sync_test ON ${table(name)}`,
    );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".calendar_sync_test()`,
  );
  await f.reset();
  await f.owner.query(
    'TRUNCATE core.workspace,core."connectedAccount",core."messageChannel",core."calendarChannel" CASCADE',
  );
  accountId = randomUUID();
  channelId = randomUUID();
  messageChannelId = randomUUID();
  await f.owner.query('INSERT INTO core.workspace(id) VALUES($1)', [
    f.workspaceId,
  ]);
  await f.owner.query(
    'INSERT INTO core."connectedAccount"(id,"workspaceId",provider) VALUES($1,$2,\'google\')',
    [accountId, f.workspaceId],
  );
  await f.owner.query(
    'INSERT INTO core."messageChannel"(id,"workspaceId",type,"connectedAccountId") VALUES($1,$2,\'EMAIL\',$3)',
    [messageChannelId, f.workspaceId, accountId],
  );
  await f.owner.query(
    'INSERT INTO core."calendarChannel"(id,"workspaceId","connectedAccountId","isSyncEnabled","syncStage","syncStageStartedAt") VALUES($1,$2,$3,true,$4,$5)',
    [channelId, f.workspaceId, accountId, proof().stage, startedAt],
  );
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (metadata.isInitialized) await metadata.destroy();
  await f.dispose();
});

it('commits selected association, orphan graph and recording relation in one audit operation', async () => {
  const s = await seed(),
    beforeRecording = await recordingValues(),
    beforeCore = await core();
  expect(await clean()).toBe(true);
  expect(await ids(EVENT)).toEqual([s.otherEventId]);
  for (const name of [ASSOC, PART, TARGET]) expect(await ids(name)).toEqual([]);
  expect(await recordingValues()).toEqual(beforeRecording);
  expect(
    await f.owner.query(`SELECT "calendarEventId" FROM ${table(RECORD)}`),
  ).toEqual([{ calendarEventId: null }]);
  expect(await core()).toEqual(beforeCore);
  const entries = await audits();
  expect(entries).toHaveLength(6);
  expect(
    new Set(entries.map((row: { operationId: string }) => row.operationId))
      .size,
  ).toBe(1);
  expect(
    entries
      .filter((row: { action: string }) => row.action === 'delete')
      .map((row: { resourceId: string }) => row.resourceId)
      .sort(),
  ).toEqual(
    [
      s.associationId,
      s.trashedAssociationId,
      s.eventId,
      s.participantId,
      s.targetId,
    ].sort(),
  );
  expect(
    entries.filter((row: { action: string }) => row.action === 'update'),
  ).toEqual([expect.objectContaining({ resourceId: s.recordingId })]);
  expect(JSON.stringify(entries)).not.toContain('sync-private');
  expect(JSON.stringify(entries)).not.toContain('900719925474099312345');
  expect(await clean()).toBe(true);
  expect(await audits()).toEqual(entries);
});

it.each([
  'new-run',
  'disabled',
  'stage',
  'parent',
  'reserved-app',
  'missing-channel',
] as const)('declines stale %s before graph or audit effects', async (kind) => {
  await seed();
  if (kind === 'new-run')
    await f.owner.query(
      'UPDATE core."calendarChannel" SET "syncStageStartedAt"="syncStageStartedAt"+interval \'1 microsecond\' WHERE id=$1',
      [channelId],
    );
  if (kind === 'disabled')
    await f.owner.query(
      'UPDATE core."calendarChannel" SET "isSyncEnabled"=false WHERE id=$1',
      [channelId],
    );
  if (kind === 'stage')
    await f.owner.query(
      'UPDATE core."calendarChannel" SET "syncStage"=\'FAILED\' WHERE id=$1',
      [channelId],
    );
  if (kind === 'parent') {
    const other = randomUUID();
    await f.owner.query(
      'INSERT INTO core."connectedAccount"(id,"workspaceId",provider) VALUES($1,$2,\'google\')',
      [other, f.workspaceId],
    );
    await f.owner.query(
      'UPDATE core."calendarChannel" SET "connectedAccountId"=$1 WHERE id=$2',
      [other, channelId],
    );
  }
  if (kind === 'reserved-app')
    await f.owner.query(
      'UPDATE core."connectedAccount" SET provider=\'app\' WHERE id=$1',
      [accountId],
    );
  if (kind === 'missing-channel')
    await f.owner.query('DELETE FROM core."calendarChannel" WHERE id=$1', [
      channelId,
    ]);
  const before = await graph(),
    beforeCore = await core();
  expect(await clean()).toBe(false);
  expect(await graph()).toEqual(before);
  expect(await core()).toEqual(beforeCore);
  expect(await audits()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('keeps the existing retained binding exclusion even if the account provider now looks ordinary', async () => {
  await seed();
  await f.owner.query(
    'UPDATE core."connectedAccount" SET provider=\'app\' WHERE id=$1',
    [accountId],
  );
  await f.owner.query(
    'UPDATE core."messageChannel" SET type=\'APP\' WHERE id=$1',
    [messageChannelId],
  );
  await bootstrapOmniAccountBinding(
    metadata,
    { kind: 'system', id: 'calendar-sync-fixture' },
    {
      workspaceId: f.workspaceId,
      platform: 'telegram',
      connectorInstanceId: 'fixture',
      accountId,
      connectedAccountId: accountId,
      messageChannelId,
      idempotencyKey: randomUUID(),
      expectedRevision: '0',
    },
    async () => undefined,
  );
  await f.owner.query(
    'UPDATE core."connectedAccount" SET provider=\'google\' WHERE id=$1',
    [accountId],
  );
  const before = await graph(),
    entries = await audits();
  expect(await clean()).toBe(false);
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual(entries);
});

it.each(['workspace', 'kind', 'timestamp'] as const)(
  'rejects invalid %s proof rather than treating it as accepted cleanup',
  async (kind) => {
    await seed();
    const invalid = { ...proof() };
    if (kind === 'workspace') invalid.workspaceId = randomUUID();
    if (kind === 'kind') invalid.kind = 'message';
    if (kind === 'timestamp') invalid.startedAt = '2030-01-01T00:00:00.123Z';
    const before = await graph();
    await expect(clean(['selected'], invalid)).rejects.toThrow();
    expect(await graph()).toEqual(before);
    expect(await audits()).toEqual([]);
  },
);

it('deletes only the selected-channel association while a shared Event remains referenced', async () => {
  const s = await seed(),
    otherId = randomUUID();
  await f.owner.query(
    `INSERT INTO ${table(ASSOC)}(id,"calendarEventId","calendarChannelId","eventExternalId") VALUES($1,$2,$3,'selected')`,
    [otherId, s.eventId, randomUUID()],
  );
  const before = await Promise.all([EVENT, PART, TARGET, RECORD].map(read));
  expect(await clean()).toBe(true);
  expect(await ids(ASSOC)).toEqual([otherId, s.trashedAssociationId].sort());
  expect(await Promise.all([EVENT, PART, TARGET, RECORD].map(read))).toEqual(
    before,
  );
  expect(
    (await audits()).map((row: { resourceId: string }) => row.resourceId),
  ).toEqual([s.associationId]);
});

it('does not select tombstoned source associations or perform a workspace-wide orphan sweep', async () => {
  const s = await seed();
  await f.owner.query(
    `UPDATE ${table(ASSOC)} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
    [s.associationId],
  );
  const before = await graph();
  expect(await clean()).toBe(true);
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual([]);
});

it('preserves candidate tombstone semantics for an Event reached through an actual selected source deletion', async () => {
  const s = await seed();
  await f.owner.query(
    `UPDATE ${table(EVENT)} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
    [s.eventId],
  );
  expect(await clean()).toBe(true);
  expect(await ids(EVENT)).toEqual([s.otherEventId]);
  expect(await audits()).toHaveLength(6);
});

it('uses actual association RETURNING so a skipped source retains its Event and recording', async () => {
  const first = await seed('skip'),
    second = await seed('delete');
  const beforeRecording = await f.owner.query(
    `SELECT to_jsonb(row)::text AS row FROM ${table(RECORD)} row WHERE id=$1`,
    [first.recordingId],
  );
  await nativeTrigger(
    ASSOC,
    `IF OLD.id='${first.associationId}'::uuid THEN RETURN NULL; END IF; RETURN OLD;`,
  );
  expect(await clean(['skip', 'delete'])).toBe(true);
  expect(await ids(EVENT)).toEqual(
    [first.eventId, first.otherEventId, second.otherEventId].sort(),
  );
  expect(await ids(ASSOC)).toEqual(
    [first.associationId, first.trashedAssociationId].sort(),
  );
  expect(
    await f.owner.query(
      `SELECT to_jsonb(row)::text AS row FROM ${table(RECORD)} row WHERE id=$1`,
      [first.recordingId],
    ),
  ).toEqual(beforeRecording);
  expect(await audits()).toHaveLength(6);
  expect(
    (await audits()).some((row: { resourceId: string }) =>
      [
        first.associationId,
        first.trashedAssociationId,
        first.eventId,
        first.recordingId,
      ].some((id) => id === row.resourceId),
    ),
  ).toBe(false);
});

it('rolls back the direct association deletion when the orphan stage refuses', async () => {
  await seed();
  const before = await graph();
  await nativeTrigger(EVENT, "RAISE EXCEPTION 'calendar sync orphan failure';");
  const failure = await clean().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(causeText(failure)).toContain('calendar sync orphan failure');
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it.each(['event', 'recording'] as const)(
  'rejects source DELETE trigger changes to %s before orphan-stage recapture',
  async (kind) => {
    const s = await seed(),
      before = await graph();
    await nativeTrigger(
      ASSOC,
      kind === 'event'
        ? `UPDATE ${table(EVENT)} SET title='unaudited changed parent' WHERE id='${s.eventId}'; RETURN OLD;`
        : `UPDATE ${table(RECORD)} SET transcript='{"n":900719925474099312346}'::jsonb WHERE id='${s.recordingId}'; RETURN OLD;`,
    );
    await expect(clean()).rejects.toThrow('effects mismatch');
    expect(await graph()).toEqual(before);
    expect(await audits()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it('refuses a source reparent committed after unlocked discovery rather than deleting its replacement parent', async () => {
  const s = await seed(),
    expected = await graph(),
    client = await f.pool.connect(),
    original = client.query.bind(client);
  let moved = false;
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const sql = typeof statement === 'string' ? statement : statement.text,
      result = await original(statement as string, values);
    if (
      !moved &&
      sql.trimStart().startsWith('SELECT') &&
      sql.includes(table(ASSOC)) &&
      sql.includes('"eventExternalId"') &&
      !sql.includes('FOR UPDATE')
    ) {
      // Independent committed writer in the initial discovery/row-lock gap.
      // Its move must survive rejection; rollback applies only to this owner.
      await f.owner.query(
        `UPDATE ${table(ASSOC)} SET "calendarEventId"=$1 WHERE id=$2`,
        [s.otherEventId, s.associationId],
      );
      expected[1] = await read(ASSOC);
      moved = true;
    }
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await expect(clean()).rejects.toThrow('reference changed');
  expect(moved).toBe(true);
  expect(await graph()).toEqual(expected);
  expect(await audits()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it.each(['new-run', 'account-provider'] as const)(
  'rolls back late core %s drift after actual graph writes',
  async (kind) => {
    await seed();
    const before = await graph(),
      beforeCore = await core();
    await auditTrigger(
      kind === 'new-run'
        ? `UPDATE core."calendarChannel" SET "syncStageStartedAt"="syncStageStartedAt"+interval '1 microsecond' WHERE id='${channelId}';`
        : `UPDATE core."connectedAccount" SET provider='microsoft' WHERE id='${accountId}';`,
    );
    await expect(clean()).rejects.toThrow('authority changed');
    expect(await graph()).toEqual(before);
    expect(await core()).toEqual(beforeCore);
    expect(await audits()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it('captures expectedRun, external IDs and operation before the first executor await', async () => {
  const s = await seed(),
    run = { ...proof() },
    externalIds = ['selected'],
    op = operation(),
    client = await f.pool.connect(),
    original = client.query.bind(client);
  let changed = false;
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const sql = typeof statement === 'string' ? statement : statement.text;
    if (!changed && sql.startsWith('SET LOCAL')) {
      changed = true;
      run.channelId = randomUUID();
      externalIds[0] = 'not-selected';
      op.actor = { kind: 'system', id: 'mutated' };
    }
    return original(statement as string, values);
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  expect(await clean(externalIds, run, op)).toBe(true);
  expect(changed).toBe(true);
  expect(await ids(EVENT)).toEqual([s.otherEventId]);
  expect(
    (await audits()).every(
      (row: { actor: { id: string } }) =>
        row.actor.id === 'calendar-sync-cleanup-test',
    ),
  ).toBe(true);
});

it('processes 501 external IDs and orphan candidates with a single operation', async () => {
  const selected = Array.from({ length: 501 }, () => randomUUID()).sort(),
    associations = Array.from({ length: 501 }, () => randomUUID()),
    externalIds = selected.map((id) => 'external-' + id);
  await f.owner.query(
    `INSERT INTO ${table(EVENT)}(id,title) SELECT id,'page event' FROM unnest($1::uuid[]) item(id)`,
    [selected],
  );
  await f.owner.query(
    `INSERT INTO ${table(ASSOC)}(id,"calendarEventId","calendarChannelId","eventExternalId") SELECT association_id,event_id,$4,external_id FROM unnest($1::uuid[],$2::uuid[],$3::text[]) item(association_id,event_id,external_id)`,
    [associations, selected, externalIds, channelId],
  );
  expect(await clean([...externalIds, externalIds[0]])).toBe(true);
  expect(await ids(EVENT)).toEqual([]);
  expect(await ids(ASSOC)).toEqual([]);
  const entries = await audits();
  expect(entries).toHaveLength(1002);
  expect(
    new Set(entries.map((row: { operationId: string }) => row.operationId))
      .size,
  ).toBe(1);
}, 30000);

it('reports actual COMMIT ACK loss and repeats with no second mutation audit', async () => {
  const s = await seed(),
    client = await f.pool.connect(),
    original = client.query.bind(client);
  let failed = false;
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const result = await original(statement as string, values);
    if (
      !failed &&
      (typeof statement === 'string' ? statement : statement.text) === 'COMMIT'
    ) {
      failed = true;
      throw new Error('calendar sync ACK lost');
    }
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await expect(clean()).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(await ids(EVENT)).toEqual([s.otherEventId]);
  const entries = await audits();
  expect(entries).toHaveLength(6);
  expect(f.eventEmitter).not.toHaveBeenCalled();
  expect(await clean()).toBe(true);
  expect(await audits()).toEqual(entries);
});

it('pages more than 500 source Associations sharing one requested external ID', async () => {
  const s = await seed('one-external-id');
  const extraIds = Array.from({ length: 500 }, () => randomUUID());
  await f.owner.query(
    `INSERT INTO ${table(ASSOC)}(id,"calendarEventId","calendarChannelId","eventExternalId")
     SELECT id,$2,$3,'one-external-id' FROM unnest($1::uuid[]) item(id)`,
    [extraIds, s.eventId, channelId],
  );
  const beforeRecording = await recordingValues();
  const client = await f.pool.connect();
  const original = client.query.bind(client);
  const sourcePageSizes: number[] = [];
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string; values?: unknown[] },
    values?: unknown[],
  ) => {
    const sql = typeof statement === 'string' ? statement : statement.text;
    const boundValues =
      typeof statement === 'string' ? values : statement.values;
    const result = await original(statement as string, values);
    if (
      sql.includes('SELECT id,"calendarEventId" FROM ' + table(ASSOC)) &&
      sql.includes('"eventExternalId"=ANY($2::text[])') &&
      sql.includes('LIMIT 500') &&
      !sql.includes('FOR UPDATE')
    ) {
      expect(boundValues?.[1]).toEqual(['one-external-id']);
      if (result.rows.length) sourcePageSizes.push(result.rows.length);
    }
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));

  expect(await clean(['one-external-id'])).toBe(true);
  expect(sourcePageSizes).toEqual([500, 1]);
  expect(await ids(ASSOC)).toEqual([]);
  expect(await ids(EVENT)).toEqual([s.otherEventId]);
  expect(await recordingValues()).toEqual(beforeRecording);
  const entries = await audits();
  expect(entries).toHaveLength(506);
  expect(
    new Set(entries.map((row: { operationId: string }) => row.operationId))
      .size,
  ).toBe(1);
  const associationIds = new Set<string>([
    ...extraIds,
    s.associationId,
    s.trashedAssociationId,
  ]);
  expect(
    entries
      .filter((row: { resourceId: string }) =>
        associationIds.has(row.resourceId),
      )
      .map((row: { resourceId: string; action: string }) => ({
        id: row.resourceId,
        action: row.action,
      })),
  ).toEqual([...associationIds].sort().map((id) => ({ id, action: 'delete' })));
}, 30000);

it('audits a matching tombstoned source exactly once when the verified Event cascade removes it', async () => {
  const s = await seed();
  await f.owner.query(
    `UPDATE ${table(ASSOC)} SET "eventExternalId"='selected' WHERE id=$1`,
    [s.trashedAssociationId],
  );
  const beforeRecording = await recordingValues();
  expect(await clean()).toBe(true);
  expect(await ids(ASSOC)).toEqual([]);
  expect(await ids(EVENT)).toEqual([s.otherEventId]);
  expect(await recordingValues()).toEqual(beforeRecording);
  const entries = await audits();
  expect(entries).toHaveLength(6);
  expect(
    entries.filter(
      (row: { resourceId: string }) =>
        row.resourceId === s.trashedAssociationId,
    ),
  ).toEqual([
    expect.objectContaining({ action: 'delete', resourceKind: 'crmRecord' }),
  ]);
  expect(
    entries.filter(
      (row: { resourceId: string }) => row.resourceId === s.associationId,
    ),
  ).toEqual([
    expect.objectContaining({ action: 'delete', resourceKind: 'crmRecord' }),
  ]);
  expect(
    new Set(entries.map((row: { operationId: string }) => row.operationId))
      .size,
  ).toBe(1);
});

it('rejects a matching tombstoned source change before the orphan cascade can mask it', async () => {
  const s = await seed();
  await f.owner.query(
    `UPDATE ${table(ASSOC)} SET "eventExternalId"='selected' WHERE id=$1`,
    [s.trashedAssociationId],
  );
  const before = await graph();
  await nativeTrigger(
    ASSOC,
    `IF OLD.id='${s.associationId}'::uuid THEN
       UPDATE ${table(ASSOC)} SET "eventExternalId"='changed-before-orphan'
       WHERE id='${s.trashedAssociationId}';
     END IF;
     RETURN OLD;`,
  );
  await expect(clean()).rejects.toThrow('effects mismatch');
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});
