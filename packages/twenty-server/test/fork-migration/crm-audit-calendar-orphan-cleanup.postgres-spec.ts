import { randomUUID } from 'node:crypto';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
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
const ROOT = 'calendarEvent',
  ASSOC = 'calendarChannelEventAssociation',
  PART = 'calendarEventParticipant',
  TARGET = 'calendarEventTarget',
  RECORD = 'callRecording';
const names = [ROOT, ASSOC, PART, TARGET, RECORD, 'person', 'company'];
const table = (name: string) => `"${f.schemaName}"."${name}"`;
const operation = (): CrmAuditOperation => ({
  workspaceId: f.workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'system', id: 'calendar-orphan-cleanup-test' },
});
const remove = async (candidateEventIds: string[], op = operation()) =>
  f.withContext(() =>
    f.dataSource.transaction(
      (scope) =>
        deleteOrphanNativeCalendarEventsWithAudit({
          scope,
          operation: op,
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
const audits = async () =>
  f.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "resourceId"',
  );
const ids = async (name: string) =>
  (await f.owner.query(`SELECT id FROM ${table(name)} ORDER BY id`)).map(
    (row: { id: string }) => row.id,
  );
const causeText = (error: unknown) => {
  const messages: string[] = [];
  for (let n = 0; n < 6 && error instanceof Error; n++) {
    messages.push(error.message);
    error = error.cause;
  }
  return messages.join(' | ');
};
const seed = async (association: 'none' | 'live' | 'trashed' = 'trashed') => {
  const s = {
    eventId: randomUUID(),
    otherEventId: randomUUID(),
    personId: randomUUID(),
    companyId: randomUUID(),
    participantId: randomUUID(),
    trashedParticipantId: randomUUID(),
    manualTargetId: randomUUID(),
    autoTargetId: randomUUID(),
    recordingId: randomUUID(),
    associationId: randomUUID(),
  };
  await f.owner.query(
    `INSERT INTO ${table('person')}(id,"nameFirstName") VALUES($1,'Calendar person')`,
    [s.personId],
  );
  await f.owner.query(
    `INSERT INTO ${table('company')}(id,name) VALUES($1,'Calendar company')`,
    [s.companyId],
  );
  await f.owner.query(
    `INSERT INTO ${table(ROOT)}(id,title,"iCalUid") VALUES($1,'secret meeting',$3),($2,'Unrelated orphan',$4)`,
    [s.eventId, s.otherEventId, randomUUID(), randomUUID()],
  );
  await f.owner.query(
    `INSERT INTO ${table(PART)}(id,"calendarEventId","personId",handle,"responseStatus","deletedAt") VALUES($1,$3,$4,'secret-attendee@example.test','ACCEPTED',NULL),($2,$3,$4,'trashed@example.test','ACCEPTED',clock_timestamp())`,
    [s.participantId, s.trashedParticipantId, s.eventId, s.personId],
  );
  await f.owner.query(
    `INSERT INTO ${table(TARGET)}(id,"calendarEventId","targetPersonId","targetCompanyId","isManuallyAssigned","isAutomaticallyAssigned") VALUES($1,$3,$4,NULL,true,false),($2,$3,NULL,$5,false,true)`,
    [s.manualTargetId, s.autoTargetId, s.eventId, s.personId, s.companyId],
  );
  await f.owner.query(
    `INSERT INTO ${table(RECORD)}(id,"calendarEventId",title,video,audio,transcript,"externalRecordingId","createdAt","updatedAt") VALUES($1,$2,'secret recording',$3::jsonb,$4::jsonb,'{"secret":"transcript-secret","n":900719925474099312345}'::jsonb,'secret-provider-id','2026-01-02T03:04:05.000123Z','2026-01-02T03:04:05.000789Z')`,
    [
      s.recordingId,
      s.eventId,
      JSON.stringify([{ fileId: randomUUID(), name: 'private-video.mp4' }]),
      JSON.stringify([{ fileId: randomUUID(), name: 'private-audio.mp3' }]),
    ],
  );
  if (association !== 'none')
    await f.owner.query(
      `INSERT INTO ${table(ASSOC)}(id,"calendarEventId","calendarChannelId","eventExternalId","deletedAt") VALUES($1,$2,$3,'old-event',${association === 'trashed' ? 'clock_timestamp()' : 'NULL'})`,
      [s.associationId, s.eventId, randomUUID()],
    );
  f.eventEmitter.mockClear();
  return s;
};
const recordingWithoutRelation = async () =>
  f.owner.query(
    `SELECT (to_jsonb(row)-'calendarEventId')::text AS row FROM ${table(RECORD)} row ORDER BY id`,
  );
const auditTrigger = async (body: string) =>
  f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".calendar_orphan_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN ${body} RETURN NEW; END $$; CREATE TRIGGER calendar_orphan_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".calendar_orphan_test()`,
  );
const nativeTrigger = async (
  name: string,
  timing: string,
  event: string,
  body: string,
  deferred = false,
) =>
  f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".calendar_orphan_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$; CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER calendar_orphan_test ${timing} ${event} ON ${table(name)} ${deferred ? 'DEFERRABLE INITIALLY DEFERRED ' : ''}FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".calendar_orphan_test()`,
  );
const waitForLock = async (fragment: string) => {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    if (
      (
        await f.owner.query(
          "SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1",
          ['%' + fragment + '%'],
        )
      ).length
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected PostgreSQL Lock wait: ' + fragment);
};

beforeAll(async () => {
  await f.initialize();
  await f.owner.query(`GRANT UPDATE ON core.workspace TO "${f.roleName}"`);
});
beforeEach(async () => {
  await f.owner.query(
    'DROP TRIGGER IF EXISTS calendar_orphan_audit ON crm_audit."crmAuditEntry"',
  );
  for (const name of [ROOT, ASSOC, PART, TARGET, RECORD])
    await f.owner.query(
      `DROP TRIGGER IF EXISTS calendar_orphan_test ON ${table(name)}`,
    );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".calendar_orphan_test()`,
  );
  await f.owner.query(`DROP TABLE IF EXISTS ${table('calendar_orphan_extra')}`);
  await f.owner.query(
    `DROP INDEX IF EXISTS "${f.schemaName}".calendar_recording_pair`,
  );
  await f.reset();
  await f.owner.query('TRUNCATE core.workspace CASCADE');
  await f.owner.query('INSERT INTO core.workspace(id) VALUES($1)', [
    f.workspaceId,
  ]);
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it('audits every actual cascade and exact SET NULL while preserving recording FILES, JSON precision and timestamps', async () => {
  const s = await seed(),
    recording = await recordingWithoutRelation(),
    parents = await Promise.all(['person', 'company'].map(read));
  const result = await remove([s.eventId]);
  expect(result).toEqual({
    deletedEventIds: [s.eventId],
    deletedAssociationIds: [s.associationId],
    deletedParticipantIds: [s.participantId, s.trashedParticipantId].sort(),
    deletedTargetIds: [s.manualTargetId, s.autoTargetId].sort(),
    updatedCallRecordingIds: [s.recordingId],
  });
  expect(await ids(ROOT)).toEqual([s.otherEventId]);
  for (const name of [ASSOC, PART, TARGET]) expect(await ids(name)).toEqual([]);
  expect(await recordingWithoutRelation()).toEqual(recording);
  expect(
    await f.owner.query(
      `SELECT "calendarEventId" FROM ${table(RECORD)} WHERE id=$1`,
      [s.recordingId],
    ),
  ).toEqual([{ calendarEventId: null }]);
  expect(await Promise.all(['person', 'company'].map(read))).toEqual(parents);
  const entries = await audits();
  expect(entries).toHaveLength(7);
  expect(
    entries
      .filter((row: { action: string }) => row.action === 'delete')
      .map((row: { resourceId: string }) => row.resourceId)
      .sort(),
  ).toEqual(
    [
      s.eventId,
      s.associationId,
      s.participantId,
      s.trashedParticipantId,
      s.manualTargetId,
      s.autoTargetId,
    ].sort(),
  );
  expect(
    entries.filter((row: { action: string }) => row.action === 'update'),
  ).toEqual([
    expect.objectContaining({
      resourceId: s.recordingId,
      resourceKind: 'crmRecord',
    }),
  ]);
  expect(
    new Set(entries.map((row: { operationId: string }) => row.operationId))
      .size,
  ).toBe(1);
  for (const secret of [
    'secret meeting',
    'secret-attendee',
    'transcript-secret',
    '900719925474099312345',
    'private-video',
    'secret-provider-id',
  ])
    expect(JSON.stringify(entries)).not.toContain(secret);
  expect(await remove([s.eventId])).toMatchObject({ deletedEventIds: [] });
  expect(await audits()).toEqual(entries);
});

it('retains the complete graph while a live association from any channel exists', async () => {
  const s = await seed('live'),
    before = await graph();
  expect(await remove([s.eventId])).toMatchObject({ deletedEventIds: [] });
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('allows an explicitly supplied tombstoned Event but preserves an unrelated tombstoned Event', async () => {
  const s = await seed();
  await f.owner.query(
    `UPDATE ${table(ROOT)} SET "deletedAt"=clock_timestamp()`,
  );
  const [other] = await f.owner.query(
    `SELECT to_jsonb(row)::text AS row FROM ${table(ROOT)} row WHERE id=$1`,
    [s.otherEventId],
  );
  expect(await remove([s.eventId])).toMatchObject({
    deletedEventIds: [s.eventId],
  });
  expect(await read(ROOT)).toEqual([other]);
});

it('uses actual RETURNING when a parent trigger skips the selected Event', async () => {
  const s = await seed(),
    before = await graph();
  await nativeTrigger(ROOT, 'BEFORE', 'DELETE', 'RETURN NULL;');
  expect(await remove([s.eventId])).toMatchObject({ deletedEventIds: [] });
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('attributes mixed parent deletions only to the actual returned Event and its effects', async () => {
  const skipped = await seed(),
    deleted = await seed();
  const beforeRecording = await f.owner.query(
    `SELECT to_jsonb(row)::text AS row FROM ${table(RECORD)} row WHERE id=$1`,
    [skipped.recordingId],
  );
  await nativeTrigger(
    ROOT,
    'BEFORE',
    'DELETE',
    `IF OLD.id='${skipped.eventId}'::uuid THEN RETURN NULL; END IF; RETURN OLD;`,
  );
  expect(await remove([skipped.eventId, deleted.eventId])).toEqual({
    deletedEventIds: [deleted.eventId],
    deletedAssociationIds: [deleted.associationId],
    deletedParticipantIds: [
      deleted.participantId,
      deleted.trashedParticipantId,
    ].sort(),
    deletedTargetIds: [deleted.manualTargetId, deleted.autoTargetId].sort(),
    updatedCallRecordingIds: [deleted.recordingId],
  });
  expect(await ids(ROOT)).toEqual(
    [skipped.eventId, skipped.otherEventId, deleted.otherEventId].sort(),
  );
  expect(await ids(ASSOC)).toEqual([skipped.associationId]);
  expect(await ids(PART)).toEqual(
    [skipped.participantId, skipped.trashedParticipantId].sort(),
  );
  expect(await ids(TARGET)).toEqual(
    [skipped.manualTargetId, skipped.autoTargetId].sort(),
  );
  expect(
    await f.owner.query(
      `SELECT to_jsonb(row)::text AS row FROM ${table(RECORD)} row WHERE id=$1`,
      [skipped.recordingId],
    ),
  ).toEqual(beforeRecording);
  expect(await audits()).toHaveLength(7);
  expect(
    (await audits()).some((row: { resourceId: string }) =>
      [
        skipped.eventId,
        skipped.associationId,
        skipped.participantId,
        skipped.trashedParticipantId,
        skipped.manualTargetId,
        skipped.autoTargetId,
        skipped.recordingId,
      ].some((id) => id === row.resourceId),
    ),
  ).toBe(false);
});

it.each(['shared', 'copied', 'foreign-operation', 'over-limit'] as const)(
  'rejects %s before graph changes',
  async (kind) => {
    const s = await seed(),
      before = await graph(),
      op = operation();
    if (kind === 'foreign-operation') op.workspaceId = randomUUID();
    await expect(
      f.withContext(() =>
        f.dataSource.transaction(
          (scope) =>
            deleteOrphanNativeCalendarEventsWithAudit({
              scope: kind === 'copied' ? { ...scope } : scope,
              operation: op,
              candidateEventIds:
                kind === 'over-limit'
                  ? Array.from({ length: 501 }, () => randomUUID())
                  : [s.eventId],
            }),
          kind === 'shared'
            ? { commitOutcome: 'strict' }
            : { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
        ),
      ),
    ).rejects.toThrow();
    expect(await graph()).toEqual(before);
    expect(await audits()).toEqual([]);
  },
);

it('captures candidate IDs and actor before the first executor await', async () => {
  const s = await seed(),
    candidates = [s.eventId],
    op = operation(),
    client = await f.pool.connect(),
    original = client.query.bind(client);
  let mutated = false;
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const sql = typeof statement === 'string' ? statement : statement.text;
    if (!mutated && sql.startsWith('SET LOCAL')) {
      mutated = true;
      candidates[0] = s.otherEventId;
      op.actor = { kind: 'system', id: 'changed-after-await' };
    }
    return original(statement as string, values);
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  expect(await remove(candidates, op)).toMatchObject({
    deletedEventIds: [s.eventId],
  });
  expect(mutated).toBe(true);
  expect(await ids(ROOT)).toEqual([s.otherEventId]);
  expect(
    (await audits()).every(
      (row: { actor: { id: string } }) =>
        row.actor.id === 'calendar-orphan-cleanup-test',
    ),
  ).toBe(true);
});

it('accepts 500 candidate UUIDs, duplicates and absent IDs without inventing effects', async () => {
  const s = await seed();
  const candidates = [
    s.eventId,
    s.eventId,
    ...Array.from({ length: 498 }, () => randomUUID()),
  ];
  expect(await remove(candidates)).toMatchObject({
    deletedEventIds: [s.eventId],
  });
  expect(await audits()).toHaveLength(7);
});

it.each([ASSOC, RECORD])(
  'refuses a missing required %s FK even when that child has no rows',
  async (name) => {
    const s = await seed('none');
    await f.owner.query(`DELETE FROM ${table(RECORD)}`);
    const [fk] = await f.owner.query(
      "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE contype='f' AND conrelid=$1::regclass AND confrelid=$2::regclass",
      [table(name), table(ROOT)],
    );
    expect(fk).toBeDefined();
    const before = await graph();
    await f.owner.query(
      `ALTER TABLE ${table(name)} DROP CONSTRAINT "${fk.conname}"`,
    );
    try {
      await expect(remove([s.eventId])).rejects.toThrow(
        'requires expected foreign keys',
      );
      expect(await graph()).toEqual(before);
      expect(await audits()).toEqual([]);
    } finally {
      await f.owner.query(
        `ALTER TABLE ${table(name)} ADD CONSTRAINT "${fk.conname}" ${fk.definition}`,
      );
    }
  },
);

it('refuses populated unsupported incoming cascade effects on a child', async () => {
  const s = await seed();
  await f.owner.query(
    `CREATE TABLE ${table('calendar_orphan_extra')}(id uuid PRIMARY KEY,"participantId" uuid REFERENCES ${table(PART)}(id) ON DELETE CASCADE)`,
  );
  await f.owner.query(
    `GRANT SELECT ON ${table('calendar_orphan_extra')} TO "${f.roleName}"`,
  );
  await f.owner.query(
    `INSERT INTO ${table('calendar_orphan_extra')} VALUES($1,$2)`,
    [randomUUID(), s.participantId],
  );
  const before = await graph(),
    extra = await read('calendar_orphan_extra');
  await expect(remove([s.eventId])).rejects.toThrow(
    'excludes unsupported cascade effects',
  );
  expect(await graph()).toEqual(before);
  expect(await read('calendar_orphan_extra')).toEqual(extra);
  expect(await audits()).toEqual([]);
});

it('refuses actual composite ON UPDATE CASCADE effects from recording SET NULL', async () => {
  const s = await seed();
  await f.owner.query(
    `CREATE UNIQUE INDEX calendar_recording_pair ON ${table(RECORD)}(id,"calendarEventId")`,
  );
  await f.owner.query(
    `CREATE TABLE ${table('calendar_orphan_extra')}(id uuid PRIMARY KEY,"recordingId" uuid,"eventId" uuid,FOREIGN KEY("recordingId","eventId") REFERENCES ${table(RECORD)}(id,"calendarEventId") ON UPDATE CASCADE)`,
  );
  await f.owner.query(
    `GRANT SELECT ON ${table('calendar_orphan_extra')} TO "${f.roleName}"`,
  );
  await f.owner.query(
    `INSERT INTO ${table('calendar_orphan_extra')} VALUES($1,$2,$3)`,
    [randomUUID(), s.recordingId, s.eventId],
  );
  const probe = f.owner.createQueryRunner();
  await probe.connect();
  await probe.startTransaction();
  try {
    await probe.query(`DELETE FROM ${table(ROOT)} WHERE id=$1`, [s.eventId]);
    expect(
      await probe.query(
        `SELECT "eventId" FROM ${table('calendar_orphan_extra')}`,
      ),
    ).toEqual([{ eventId: null }]);
  } finally {
    await probe.rollbackTransaction();
    await probe.release();
  }
  const before = await graph(),
    extra = await read('calendar_orphan_extra');
  await expect(remove([s.eventId])).rejects.toThrow(
    'referential UPDATE effects',
  );
  expect(await graph()).toEqual(before);
  expect(await read('calendar_orphan_extra')).toEqual(extra);
  expect(await audits()).toEqual([]);
});

it.each([false, true])(
  'handles unchanged recording-id references with key-rewriting trigger=%s',
  async (rewrite) => {
    const s = await seed();
    await f.owner.query(
      `CREATE TABLE ${table('calendar_orphan_extra')}(id uuid PRIMARY KEY,"recordingId" uuid REFERENCES ${table(RECORD)}(id) ON UPDATE CASCADE)`,
    );
    await f.owner.query(
      `GRANT SELECT ON ${table('calendar_orphan_extra')} TO "${f.roleName}"`,
    );
    await f.owner.query(
      `INSERT INTO ${table('calendar_orphan_extra')} VALUES($1,$2)`,
      [randomUUID(), s.recordingId],
    );
    if (rewrite)
      await nativeTrigger(
        RECORD,
        'BEFORE',
        'UPDATE',
        `NEW.id='${randomUUID()}'::uuid; RETURN NEW;`,
      );
    const before = await graph(),
      extra = await read('calendar_orphan_extra');
    if (rewrite) {
      await expect(remove([s.eventId])).rejects.toThrow(
        'referential UPDATE effects',
      );
      expect(await graph()).toEqual(before);
      expect(await audits()).toEqual([]);
    } else {
      expect(await remove([s.eventId])).toMatchObject({
        deletedEventIds: [s.eventId],
      });
    }
    expect(await read('calendar_orphan_extra')).toEqual(extra);
  },
);

it.each(['updatedAt', 'transcript'] as const)(
  'rejects an FK update trigger changing recording %s beyond the relation',
  async (field) => {
    const s = await seed(),
      before = await graph();
    await nativeTrigger(
      RECORD,
      'BEFORE',
      'UPDATE',
      field === 'updatedAt'
        ? `NEW."updatedAt"=OLD."updatedAt"+interval '1 microsecond'; RETURN NEW;`
        : `NEW.transcript='{"n":900719925474099312346}'::jsonb; RETURN NEW;`,
    );
    await expect(remove([s.eventId])).rejects.toThrow('effects mismatch');
    expect(await graph()).toEqual(before);
    expect(await audits()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it('rolls back the entire graph when audit append fails', async () => {
  const s = await seed(),
    before = await graph();
  await auditTrigger("RAISE EXCEPTION 'calendar orphan audit fault';");
  const failure = await remove([s.eventId]).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(causeText(failure)).toContain('calendar orphan audit fault');
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it.each(['recording-change', 'retained-association-change'] as const)(
  'rejects late audit %s and restores all earlier effects',
  async (kind) => {
    const s = await seed(),
      beforeRecording = await recordingWithoutRelation();
    if (kind === 'retained-association-change') {
      // The second candidate is initially protected by a live association. The
      // audit trigger changes that retained source while the first candidate dies.
      await f.owner.query(
        `INSERT INTO ${table(ASSOC)}(id,"calendarEventId","calendarChannelId","eventExternalId") VALUES($1,$2,$3,'retained')`,
        [randomUUID(), s.otherEventId, randomUUID()],
      );
      await auditTrigger(
        `UPDATE ${table(ASSOC)} SET "eventExternalId"='changed-after-audit' WHERE "calendarEventId"='${s.otherEventId}';`,
      );
    } else
      await auditTrigger(
        `UPDATE ${table(RECORD)} SET transcript='{"n":900719925474099312346}'::jsonb WHERE id='${s.recordingId}';`,
      );
    const before = await graph();
    await expect(remove([s.eventId, s.otherEventId])).rejects.toThrow(
      'effects mismatch',
    );
    expect(await graph()).toEqual(before);
    expect(await recordingWithoutRelation()).toEqual(beforeRecording);
    expect(await audits()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it('drains actual deferred Event resurrection and rolls back graph/audit', async () => {
  const s = await seed(),
    before = await graph();
  await nativeTrigger(
    ROOT,
    'AFTER',
    'DELETE',
    `INSERT INTO ${table(ROOT)} SELECT OLD.*; RETURN OLD;`,
    true,
  );
  expect(
    await f.owner.query(
      "SELECT tgdeferrable,tginitdeferred FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname='calendar_orphan_test'",
      [table(ROOT)],
    ),
  ).toEqual([{ tgdeferrable: true, tginitdeferred: true }]);
  await expect(remove([s.eventId])).rejects.toThrow('effects mismatch');
  expect(await graph()).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('reports real COMMIT ACK loss without duplicate audit on the idempotent later candidate', async () => {
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
      throw new Error('calendar orphan ACK lost');
    }
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await expect(remove([s.eventId])).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(await ids(ROOT)).toEqual([s.otherEventId]);
  const entries = await audits();
  expect(entries).toHaveLength(7);
  expect(f.eventEmitter).not.toHaveBeenCalled();
  expect(await remove([s.eventId])).toMatchObject({ deletedEventIds: [] });
  expect(await audits()).toEqual(entries);
});

it.each([ASSOC, RECORD])(
  'rereads %s reparenting committed while waiting for its source row lock',
  async (name) => {
    const s = await seed(name === ASSOC ? 'live' : 'trashed');
    const childId = name === ASSOC ? s.associationId : s.recordingId;
    const writer = f.owner.createQueryRunner();
    await writer.connect();
    await writer.startTransaction();
    let work: ReturnType<typeof remove> | undefined;
    try {
      await writer.query(
        `UPDATE ${table(name)} SET "calendarEventId"=$1 WHERE id=$2`,
        [s.otherEventId, childId],
      );
      work = remove([s.eventId]);
      // It is the actual owner's source SELECT waiting on the independently held
      // row lock, not an artificial pause or an elapsed-time assertion.
      await waitForLock(table(name));
      await writer.commitTransaction();
      expect(await work).toMatchObject({ deletedEventIds: [s.eventId] });
      expect(
        await f.owner.query(
          `SELECT "calendarEventId" FROM ${table(name)} WHERE id=$1`,
          [childId],
        ),
      ).toEqual([{ calendarEventId: s.otherEventId }]);
      expect(
        (await audits()).some(
          (row: { resourceId: string }) => row.resourceId === childId,
        ),
      ).toBe(false);
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await writer.release();
      if (work) await Promise.allSettled([work]);
    }
  },
);

it.each([ASSOC, RECORD])(
  'holds %s source lock until commit before allowing a later reparent',
  async (name) => {
    const s = await seed(name === ASSOC ? 'live' : 'trashed');
    const childId = name === ASSOC ? s.associationId : s.recordingId;
    const client = await f.pool.connect(),
      original = client.query.bind(client);
    let held = false,
      reached!: () => void,
      release!: () => void;
    const locked = new Promise<void>((resolve) => {
        reached = resolve;
      }),
      resume = new Promise<void>((resolve) => {
        release = resolve;
      });
    jest.spyOn(client, 'query').mockImplementation((async (
      statement: string | { text: string },
      values?: unknown[],
    ) => {
      const sql = typeof statement === 'string' ? statement : statement.text,
        result = await original(statement as string, values);
      if (!held && sql.includes(table(name)) && sql.includes('FOR UPDATE')) {
        held = true;
        reached();
        await resume;
      }
      return result;
    }) as typeof client.query);
    jest
      .spyOn(f.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    const work = remove([s.eventId]);
    let reparent: Promise<unknown> | undefined;
    try {
      await Promise.race([
        locked,
        work.then(() => {
          throw new Error('Expected source FOR UPDATE before completion');
        }),
      ]);
      const marker = 'calendar-child-reparent-' + randomUUID();
      reparent = f.owner.query(
        `/* ${marker} */ UPDATE ${table(name)} SET "calendarEventId"=$1 WHERE id=$2`,
        [s.otherEventId, childId],
      );
      await waitForLock(marker);
      expect(await audits()).toEqual([]);
    } finally {
      release();
      await Promise.allSettled([work, ...(reparent ? [reparent] : [])]);
    }
    expect(await work).toMatchObject({
      deletedEventIds: name === ASSOC ? [] : [s.eventId],
    });
    await reparent;
    expect(
      await f.owner.query(
        `SELECT "calendarEventId" FROM ${table(name)} WHERE id=$1`,
        [childId],
      ),
    ).toEqual([{ calendarEventId: s.otherEventId }]);
    if (name === ASSOC) {
      expect(await audits()).toEqual([]);
      expect(await remove([s.eventId])).toMatchObject({
        deletedEventIds: [s.eventId],
      });
    } else
      expect(
        (await audits()).filter(
          (row: { resourceId: string }) => row.resourceId === childId,
        ),
      ).toEqual([expect.objectContaining({ action: 'update' })]);
  },
);

it('waits for an earlier live Association insert then retains the event and all its children', async () => {
  const s = await seed('none'),
    writer = f.owner.createQueryRunner();
  await writer.connect();
  await writer.startTransaction();
  let work: ReturnType<typeof remove> | undefined;
  try {
    await writer.query(
      `INSERT INTO ${table(ASSOC)}(id,"calendarEventId","calendarChannelId","eventExternalId") VALUES($1,$2,$3,'concurrent')`,
      [s.associationId, s.eventId, randomUUID()],
    );
    work = remove([s.eventId]);
    await waitForLock(table(ROOT));
    await writer.commitTransaction();
    expect(await work).toMatchObject({ deletedEventIds: [] });
    expect(await ids(ROOT)).toEqual([s.eventId, s.otherEventId].sort());
    expect(await ids(PART)).toHaveLength(2);
    expect(await ids(TARGET)).toHaveLength(2);
    expect(await audits()).toEqual([]);
  } finally {
    if (writer.isTransactionActive) await writer.rollbackTransaction();
    await writer.release();
    if (work) await Promise.allSettled([work]);
  }
});

it('makes a later live Association insert wait on the Event lock and fail after actual deletion', async () => {
  const s = await seed('none'),
    client = await f.pool.connect(),
    original = client.query.bind(client);
  let held = false,
    reached!: () => void,
    release!: () => void;
  const locked = new Promise<void>((resolve) => {
      reached = resolve;
    }),
    resume = new Promise<void>((resolve) => {
      release = resolve;
    });
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const sql = typeof statement === 'string' ? statement : statement.text,
      result = await original(statement as string, values);
    if (!held && sql.includes(table(ROOT)) && sql.includes('FOR UPDATE')) {
      held = true;
      reached();
      await resume;
    }
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  const work = remove([s.eventId]);
  let inserted: Promise<unknown> | undefined;
  try {
    await Promise.race([
      locked,
      work.then(() => {
        throw new Error('Expected Event lock');
      }),
    ]);
    const marker = 'calendar-association-insert-' + randomUUID();
    inserted = f.owner
      .query(
        `/* ${marker} */ INSERT INTO ${table(ASSOC)}(id,"calendarEventId","calendarChannelId","eventExternalId") VALUES($1,$2,$3,'too-late')`,
        [s.associationId, s.eventId, randomUUID()],
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await waitForLock(marker);
  } finally {
    release();
    await Promise.allSettled([work, ...(inserted ? [inserted] : [])]);
  }
  expect(await work).toMatchObject({ deletedEventIds: [s.eventId] });
  expect(await inserted).toMatchObject({ code: '23503' });
  expect(await ids(ASSOC)).toEqual([]);
  expect(await audits()).toHaveLength(6);
});
