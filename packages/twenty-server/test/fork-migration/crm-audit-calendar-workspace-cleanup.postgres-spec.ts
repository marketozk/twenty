import { randomUUID } from 'node:crypto';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { cleanWorkspaceNativeCalendarEventsWithAudit } from 'src/engine/core-modules/crm-audit/clean-workspace-native-calendar-events-with-audit';
import { deleteOrphanNativeCalendarEventsWithAudit } from 'src/engine/core-modules/crm-audit/delete-orphan-native-calendar-events-with-audit';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
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
const EVENT = 'calendarEvent',
  ASSOC = 'calendarChannelEventAssociation',
  PART = 'calendarEventParticipant',
  TARGET = 'calendarEventTarget',
  RECORD = 'callRecording';
const table = (name: string) => `"${f.schemaName}"."${name}"`;
const names = [EVENT, ASSOC, PART, TARGET, RECORD, 'person'];
const operation = (): CrmAuditOperation => ({
  workspaceId: f.workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'system', id: 'calendar-workspace-cleanup-test' },
});
const sweep = async () =>
  f.withContext(() =>
    f.dataSource.transaction(
      (scope) =>
        cleanWorkspaceNativeCalendarEventsWithAudit({
          scope,
          operation: operation(),
        }),
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
const candidate = async (candidateEventIds: string[]) =>
  f.withContext(() =>
    f.dataSource.transaction(
      (scope) =>
        deleteOrphanNativeCalendarEventsWithAudit({
          scope,
          operation: operation(),
          candidateEventIds,
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
const emptyResult = () => ({
  deletedEventIds: [],
  deletedAssociationIds: [],
  deletedParticipantIds: [],
  deletedTargetIds: [],
  updatedCallRecordingIds: [],
});
const eventIds = (count: number) =>
  Array.from({ length: count }, () => randomUUID()).sort();
const insertEvents = async (selected: string[]) =>
  f.owner.query(
    `INSERT INTO ${table(EVENT)}(id,title,"iCalUid") SELECT id,'calendar-sweep-'||id,id::text FROM unnest($1::uuid[]) item(id)`,
    [selected],
  );
const recordingValues = async () =>
  f.owner.query(
    `SELECT (to_jsonb(row)-'calendarEventId')::text AS row FROM ${table(RECORD)} row ORDER BY id`,
  );
const attachGraph = async (eventId: string) => {
  const s = {
    personId: randomUUID(),
    associationId: randomUUID(),
    participantId: randomUUID(),
    targetId: randomUUID(),
    recordingId: randomUUID(),
  };
  await f.owner.query(
    `INSERT INTO ${table('person')}(id,"nameFirstName") VALUES($1,'Calendar sweep person')`,
    [s.personId],
  );
  await f.owner.query(
    `INSERT INTO ${table(ASSOC)}(id,"calendarEventId","calendarChannelId","eventExternalId","deletedAt") VALUES($1,$2,$3,'trashed association',clock_timestamp())`,
    [s.associationId, eventId, randomUUID()],
  );
  await f.owner.query(
    `INSERT INTO ${table(PART)}(id,"calendarEventId","personId",handle,"responseStatus") VALUES($1,$2,$3,'private-sweep@example.test','ACCEPTED')`,
    [s.participantId, eventId, s.personId],
  );
  await f.owner.query(
    `INSERT INTO ${table(TARGET)}(id,"calendarEventId","targetPersonId","isManuallyAssigned","isAutomaticallyAssigned") VALUES($1,$2,$3,true,false)`,
    [s.targetId, eventId, s.personId],
  );
  await f.owner.query(
    `INSERT INTO ${table(RECORD)}(id,"calendarEventId",title,video,audio,transcript,"createdAt","updatedAt") VALUES($1,$2,'private sweep recording',$3::jsonb,$4::jsonb,'{"n":900719925474099312345,"secret":"private-transcript"}'::jsonb,'2026-02-03T04:05:06.000123Z','2026-02-03T04:05:06.000789Z')`,
    [
      s.recordingId,
      eventId,
      JSON.stringify([{ fileId: randomUUID(), name: 'private-video.mp4' }]),
      JSON.stringify([{ fileId: randomUUID(), name: 'private-audio.mp3' }]),
    ],
  );
  return s;
};
const nativeTrigger = async (body: string, deferred = false) =>
  f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".calendar_sweep_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$; CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER calendar_sweep_test ${deferred ? 'AFTER' : 'BEFORE'} DELETE ON ${table(EVENT)} ${deferred ? 'DEFERRABLE INITIALLY DEFERRED ' : ''}FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".calendar_sweep_test()`,
  );
const auditTrigger = async (body: string) =>
  f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".calendar_sweep_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN ${body} RETURN NEW; END $$; CREATE TRIGGER calendar_sweep_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".calendar_sweep_test()`,
  );
const isDiscovery = (sql: string) =>
  sql.includes(table(EVENT)) &&
  sql.includes('"deletedAt" IS NULL') &&
  sql.includes('LIMIT 500') &&
  sql.includes('FOR UPDATE');
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
  await f.owner.query(`GRANT UPDATE ON core.workspace TO "${f.roleName}"`);
});
beforeEach(async () => {
  await f.owner.query(
    'DROP TRIGGER IF EXISTS calendar_sweep_audit ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query(
    `DROP TRIGGER IF EXISTS calendar_sweep_test ON ${table(EVENT)}`,
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".calendar_sweep_test()`,
  );
  await f.reset();
  await f.owner.query('TRUNCATE core.workspace CASCADE');
  await f.owner.query('INSERT INTO core.workspace(id) VALUES($1)', [
    f.workspaceId,
  ]);
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it('keeps global discovery live-only while preserving explicit tombstoned candidate behavior', async () => {
  const [live, trashed, protectedId] = eventIds(3);
  await insertEvents([live, trashed, protectedId]);
  await attachGraph(live);
  const trashedGraph = await attachGraph(trashed);
  await f.owner.query(
    `UPDATE ${table(EVENT)} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
    [trashed],
  );
  await f.owner.query(
    `INSERT INTO ${table(ASSOC)}(id,"calendarEventId","calendarChannelId","eventExternalId") VALUES($1,$2,$3,'live other-channel')`,
    [randomUUID(), protectedId, randomUUID()],
  );
  const recording = await f.owner.query(
    `SELECT to_jsonb(row)::text AS row FROM ${table(RECORD)} row WHERE id=$1`,
    [trashedGraph.recordingId],
  );
  expect(await sweep()).toMatchObject({ deletedEventIds: [live] });
  expect(await ids(EVENT)).toEqual([trashed, protectedId].sort());
  expect(
    await f.owner.query(
      `SELECT to_jsonb(row)::text AS row FROM ${table(RECORD)} row WHERE id=$1`,
      [trashedGraph.recordingId],
    ),
  ).toEqual(recording);
  expect(
    (await audits()).some((row: { resourceId: string }) =>
      [
        trashed,
        trashedGraph.associationId,
        trashedGraph.participantId,
        trashedGraph.targetId,
        trashedGraph.recordingId,
      ].some((id) => id === row.resourceId),
    ),
  ).toBe(false);
  expect(await candidate([trashed])).toMatchObject({
    deletedEventIds: [trashed],
  });
  expect(await ids(EVENT)).toEqual([protectedId]);
});

it('deletes 501 roots with rich graphs across pages, one final flush and one audit operation', async () => {
  const selected = eventIds(501);
  await insertEvents(selected);
  const first = await attachGraph(selected[0]),
    last = await attachGraph(selected[500]),
    beforeRecording = await recordingValues(),
    beforePeople = await read('person');
  const client = await f.pool.connect(),
    original = client.query.bind(client);
  let discoveries = 0,
    observedPendingAuditCount: number | undefined,
    observedFirstPageDeletion = false;
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const sql = typeof statement === 'string' ? statement : statement.text,
      result = await original(statement as string, values);
    if (isDiscovery(sql) && ++discoveries === 2) {
      // Same transaction/executor: an independent connection would hide even
      // an incorrect earlier flush and therefore could not prove this property.
      const entries = await original(
        'SELECT count(*)::int AS count FROM crm_audit."crmAuditEntry"',
      );
      observedPendingAuditCount = entries.rows[0].count;
      observedFirstPageDeletion =
        (
          await original(`SELECT id FROM ${table(EVENT)} WHERE id=$1`, [
            selected[0],
          ])
        ).rows.length === 0;
    }
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  const result = await sweep();
  expect(observedPendingAuditCount).toBe(0);
  expect(observedFirstPageDeletion).toBe(true);
  expect(discoveries).toBeGreaterThanOrEqual(2);
  expect(result).toEqual({
    deletedEventIds: selected,
    deletedAssociationIds: [first.associationId, last.associationId].sort(),
    deletedParticipantIds: [first.participantId, last.participantId].sort(),
    deletedTargetIds: [first.targetId, last.targetId].sort(),
    updatedCallRecordingIds: [first.recordingId, last.recordingId].sort(),
  });
  for (const name of [EVENT, ASSOC, PART, TARGET])
    expect(await ids(name)).toEqual([]);
  expect(await recordingValues()).toEqual(beforeRecording);
  expect(await read('person')).toEqual(beforePeople);
  expect(
    await f.owner.query(`SELECT "calendarEventId" FROM ${table(RECORD)}`),
  ).toEqual([{ calendarEventId: null }, { calendarEventId: null }]);
  const entries = await audits();
  expect(entries).toHaveLength(509);
  expect(
    new Set(entries.map((row: { operationId: string }) => row.operationId))
      .size,
  ).toBe(1);
  expect(JSON.stringify(entries)).not.toContain('private-transcript');
  expect(JSON.stringify(entries)).not.toContain('900719925474099312345');
  expect(await sweep()).toEqual(emptyResult());
  expect(await audits()).toEqual(entries);
}, 30000);

it('advances past a protected first page of 500 live-associated Events', async () => {
  const selected = eventIds(501);
  await insertEvents(selected);
  await f.owner.query(
    `INSERT INTO ${table(ASSOC)}(id,"calendarEventId","calendarChannelId","eventExternalId") SELECT uuid_generate_v4(),id,$2,'protected-'||id FROM unnest($1::uuid[]) item(id)`,
    [selected.slice(0, 500), randomUUID()],
  );
  const associations = await read(ASSOC);
  expect(await sweep()).toEqual({
    ...emptyResult(),
    deletedEventIds: [selected[500]],
  });
  expect(await ids(EVENT)).toEqual(selected.slice(0, 500));
  expect(await read(ASSOC)).toEqual(associations);
  expect(
    (await audits()).map((row: { resourceId: string }) => row.resourceId),
  ).toEqual([selected[500]]);
}, 30000);

it('advances past 500 trigger-skipped roots and returns only the actual last graph deletion', async () => {
  const selected = eventIds(501);
  await insertEvents(selected);
  const skipped = await attachGraph(selected[0]),
    last = await attachGraph(selected[500]);
  const skippedRecording = await f.owner.query(
    `SELECT to_jsonb(row)::text AS row FROM ${table(RECORD)} row WHERE id=$1`,
    [skipped.recordingId],
  );
  await nativeTrigger(
    `IF OLD.id<>'${selected[500]}'::uuid THEN RETURN NULL; END IF; RETURN OLD;`,
  );
  expect(await sweep()).toEqual({
    deletedEventIds: [selected[500]],
    deletedAssociationIds: [last.associationId],
    deletedParticipantIds: [last.participantId],
    deletedTargetIds: [last.targetId],
    updatedCallRecordingIds: [last.recordingId],
  });
  expect(await ids(EVENT)).toEqual(selected.slice(0, 500));
  expect(await ids(ASSOC)).toEqual([skipped.associationId]);
  expect(await ids(PART)).toEqual([skipped.participantId]);
  expect(await ids(TARGET)).toEqual([skipped.targetId]);
  expect(
    await f.owner.query(
      `SELECT to_jsonb(row)::text AS row FROM ${table(RECORD)} row WHERE id=$1`,
      [skipped.recordingId],
    ),
  ).toEqual(skippedRecording);
  expect(await audits()).toHaveLength(5);
  expect(
    f.eventEmitter.mock.calls.flatMap(([batch]) =>
      batch.events.map((event: { recordId: string }) => event.recordId),
    ),
  ).toEqual([selected[500]]);
}, 30000);

it('rolls back 500 earlier actual root deletes and recording nulls when the second page fails', async () => {
  const selected = eventIds(501);
  await insertEvents(selected);
  await attachGraph(selected[0]);
  await attachGraph(selected[500]);
  const before = await graph();
  await nativeTrigger(
    `IF OLD.id='${selected[500]}'::uuid THEN RAISE EXCEPTION 'calendar sweep second page failure'; END IF; RETURN OLD;`,
  );
  const failure = await sweep().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(causeText(failure)).toContain('calendar sweep second page failure');
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
}, 30000);

it.each(['recording', 'protected-association'] as const)(
  'rejects prior-page %s drift before later-page before-image capture',
  async (kind) => {
    const selected = eventIds(501);
    await insertEvents(selected);
    const first = await attachGraph(selected[0]);
    if (kind === 'protected-association')
      await f.owner.query(
        `UPDATE ${table(ASSOC)} SET "deletedAt"=NULL WHERE id=$1`,
        [first.associationId],
      );
    const before = await graph(),
      client = await f.pool.connect(),
      original = client.query.bind(client);
    let discoveries = 0,
      changed = false;
    jest.spyOn(client, 'query').mockImplementation((async (
      statement: string | { text: string },
      values?: unknown[],
    ) => {
      const sql = typeof statement === 'string' ? statement : statement.text,
        result = await original(statement as string, values);
      if (isDiscovery(sql) && ++discoveries === 2) {
        if (kind === 'recording')
          await original(
            `UPDATE ${table(RECORD)} SET "calendarEventId"=$1,transcript='{"n":900719925474099312346}'::jsonb WHERE id=$2`,
            [selected[500], first.recordingId],
          );
        else
          await original(
            `UPDATE ${table(ASSOC)} SET "calendarEventId"=$1,"deletedAt"=clock_timestamp() WHERE id=$2`,
            [selected[500], first.associationId],
          );
        changed = true;
      }
      return result;
    }) as typeof client.query);
    jest
      .spyOn(f.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await expect(sweep()).rejects.toThrow('effects mismatch');
    expect(changed).toBe(true);
    expect(await graph()).toEqual(before);
    expect(await audits()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
  30000,
);

it('retains first-page recording validators through the final cross-page audit flush', async () => {
  const selected = eventIds(501);
  await insertEvents(selected);
  const first = await attachGraph(selected[0]);
  await attachGraph(selected[500]);
  const before = await graph();
  await auditTrigger(
    `UPDATE ${table(RECORD)} SET "updatedAt"="updatedAt"+interval '1 microsecond' WHERE id='${first.recordingId}';`,
  );
  await expect(sweep()).rejects.toThrow('effects mismatch');
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
}, 30000);

it('drains first-page deferred resurrection only at the final boundary and rolls back both pages', async () => {
  const selected = eventIds(501);
  await insertEvents(selected);
  await attachGraph(selected[0]);
  const before = await graph();
  await nativeTrigger(
    `IF OLD.id='${selected[0]}'::uuid THEN INSERT INTO ${table(EVENT)} SELECT OLD.*; END IF; RETURN OLD;`,
    true,
  );
  expect(
    await f.owner.query(
      "SELECT tgdeferrable,tginitdeferred FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname='calendar_sweep_test'",
      [table(EVENT)],
    ),
  ).toEqual([{ tgdeferrable: true, tginitdeferred: true }]);
  await expect(sweep()).rejects.toThrow('effects mismatch');
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
}, 30000);

it('reports actual COMMIT ACK loss after all pages and does not duplicate audit on the later empty sweep', async () => {
  const selected = eventIds(501);
  await insertEvents(selected);
  const first = await attachGraph(selected[0]),
    beforeRecording = await recordingValues(),
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
      throw new Error('calendar sweep ACK lost');
    }
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await expect(sweep()).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(await ids(EVENT)).toEqual([]);
  expect(await ids(RECORD)).toEqual([first.recordingId]);
  expect(await recordingValues()).toEqual(beforeRecording);
  const entries = await audits();
  expect(entries).toHaveLength(505);
  expect(
    new Set(entries.map((row: { operationId: string }) => row.operationId))
      .size,
  ).toBe(1);
  expect(f.eventEmitter).not.toHaveBeenCalled();
  expect(await sweep()).toEqual(emptyResult());
  expect(await audits()).toEqual(entries);
}, 30000);

it('rechecks live discovery after waiting for a concurrent committed Event soft-delete', async () => {
  const [eventId] = eventIds(1);
  await insertEvents([eventId]);
  await attachGraph(eventId);
  const expected = await graph(),
    writer = f.owner.createQueryRunner();
  await writer.connect();
  await writer.startTransaction();
  let work: ReturnType<typeof sweep> | undefined;
  try {
    await writer.query(
      `UPDATE ${table(EVENT)} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
      [eventId],
    );
    // The external transaction's tombstone is the only permitted difference;
    // retain exact native graph and recording snapshots from before cleanup.
    expected[0] = await writer.query(
      `SELECT to_jsonb(row)::text AS row FROM ${table(EVENT)} row ORDER BY id`,
    );
    work = sweep();
    const deadline = Date.now() + 4000;
    let observedLock = false;
    while (Date.now() < deadline) {
      const waiting = await f.owner.query(
        "SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1 AND query LIKE '%FOR UPDATE%' AND query LIKE '%\"deletedAt\" IS NULL%'",
        ['%' + table(EVENT) + '%'],
      );
      if (waiting.length) {
        observedLock = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(observedLock).toBe(true);
    await writer.commitTransaction();
    expect(await work).toEqual(emptyResult());
    expect(await graph()).toEqual(expected);
    expect(await ids(EVENT)).toEqual([eventId]);
    expect(await audits()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  } finally {
    if (writer.isTransactionActive) await writer.rollbackTransaction();
    await writer.release();
    if (work) await Promise.allSettled([work]);
  }
});
