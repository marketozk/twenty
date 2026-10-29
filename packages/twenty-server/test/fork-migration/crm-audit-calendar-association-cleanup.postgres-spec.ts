import { randomUUID } from 'node:crypto';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { deleteNativeCalendarChannelAssociationsWithAudit } from 'src/engine/core-modules/crm-audit/delete-native-calendar-channel-associations-with-audit';
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
    'company',
    'opportunity',
    'workspaceMember',
  ],
});
const ROOT = 'calendarChannelEventAssociation';
const table = (name: string) => `"${f.schemaName}"."${name}"`;
const options = { shouldBypassPermissionChecks: true } as const;
const operation = (): CrmAuditOperation => ({
  workspaceId: f.workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'system', id: 'CalendarChannelDeletionCleanupJob' },
});
const remove = async (calendarChannelId: string, op = operation()) =>
  f.withContext(() =>
    f.dataSource.transaction(
      (scope) =>
        deleteNativeCalendarChannelAssociationsWithAudit({
          scope,
          operation: op,
          calendarChannelId,
        }),
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
const audit = () =>
  f.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "resourceId"',
  );
const read = (name: string) =>
  f.owner.query(
    `SELECT to_jsonb(row)::text AS row FROM ${table(name)} row ORDER BY id`,
  );
const graph = async () =>
  Promise.all(
    [
      'calendarEvent',
      'calendarEventParticipant',
      'calendarEventTarget',
      'person',
    ].map(read),
  );
const all = async () => [await read(ROOT), await graph()];
const seed = async () => {
  const accountId = randomUUID(),
    channelId = randomUUID();
  await f.owner.query('INSERT INTO core."connectedAccount"(id) VALUES($1)', [
    accountId,
  ]);
  await f.owner.query(
    'INSERT INTO core."calendarChannel"(id,"workspaceId","connectedAccountId") VALUES($1,$2,$3)',
    [channelId, f.workspaceId, accountId],
  );
  const ids = {
    eventId: randomUUID(),
    participantId: randomUUID(),
    targetId: randomUUID(),
    personId: randomUUID(),
    associationId: randomUUID(),
    unrelatedEventId: randomUUID(),
  };
  await f.withContext(() =>
    f.dataSource.transaction(
      async (scope) => {
        await scope.getRepository('person', options).insert({
          id: ids.personId,
          name: { firstName: 'Calendar', lastName: 'Person' },
        });
        await scope.getRepository('calendarEvent', options).insert([
          { id: ids.eventId, title: 'Keep meeting', iCalUid: randomUUID() },
          {
            id: ids.unrelatedEventId,
            title: 'Unrelated existing orphan',
            iCalUid: randomUUID(),
          },
        ]);
        await scope.getRepository('calendarEventParticipant', options).insert({
          id: ids.participantId,
          calendarEventId: ids.eventId,
          personId: ids.personId,
          handle: 'attendee@example.test',
          displayName: 'Attendee',
          isOrganizer: false,
          responseStatus: 'ACCEPTED',
        });
        await scope.getRepository('calendarEventTarget', options).insert({
          id: ids.targetId,
          calendarEventId: ids.eventId,
          targetPersonId: ids.personId,
          isManuallyAssigned: true,
          isAutomaticallyAssigned: false,
        });
        await scope.getRepository(ROOT, options).insert({
          id: ids.associationId,
          calendarEventId: ids.eventId,
          calendarChannelId: channelId,
          eventExternalId: 'selected-event',
          recurringEventExternalId: null,
        });
      },
      { commitOutcome: 'strict' },
    ),
  );
  await f.owner.query('DELETE FROM core."calendarChannel" WHERE id=$1', [
    channelId,
  ]);
  f.eventEmitter.mockClear();
  return { ...ids, accountId, channelId };
};
type Seed = Awaited<ReturnType<typeof seed>>;
const recreate = (
  s: Seed,
  query: (
    sql: string,
    values: unknown[],
  ) => Promise<unknown> = f.owner.query.bind(f.owner),
  workspaceId = f.workspaceId,
) =>
  query(
    'INSERT INTO core."calendarChannel"(id,"workspaceId","connectedAccountId") VALUES($1,$2,$3)',
    [s.channelId, workspaceId, s.accountId],
  );
const triggerAudit = (body: string) =>
  f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".calendar_cleanup_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN ${body} RETURN NEW; END $$; CREATE TRIGGER calendar_cleanup_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".calendar_cleanup_test()`,
  );
const causeMessages = (error: unknown) => {
  const result: string[] = [];
  for (let i = 0; i < 6 && error instanceof Error; i++) {
    result.push(error.message);
    error = error.cause;
  }
  return result.join(' | ');
};

beforeAll(async () => {
  await f.initialize();
  // Native graph/FKs are generated from actual standard metadata. Core channel
  // projection keeps the actual account CASCADE and workspace identity fields.
  await f.owner.query(
    'CREATE TABLE core."calendarChannel"(id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL REFERENCES core.workspace(id),"connectedAccountId" uuid NOT NULL REFERENCES core."connectedAccount"(id) ON DELETE CASCADE)',
  );
  await f.owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON core."calendarChannel" TO "${f.roleName}"`,
  );
  await f.owner.query(`GRANT UPDATE ON core.workspace TO "${f.roleName}"`);
});
beforeEach(async () => {
  await f.owner.query(
    'DROP TRIGGER IF EXISTS calendar_cleanup_audit ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query(
    `DROP TRIGGER IF EXISTS calendar_cleanup_test ON ${table(ROOT)}`,
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".calendar_cleanup_test()`,
  );
  await f.owner.query(
    `DROP TABLE IF EXISTS ${table('calendar_cleanup_extra')}`,
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

it('audits actual association deletion while keeping Event, Participant, manual Target and unrelated orphan unchanged', async () => {
  const s = await seed(),
    before = await graph();
  expect(await remove(s.channelId)).toBe(1);
  expect(await read(ROOT)).toEqual([]);
  expect(await graph()).toEqual(before);
  expect(await audit()).toEqual([
    expect.objectContaining({
      resourceKind: 'crmRecord',
      resourceId: s.associationId,
      action: 'delete',
      actor: { kind: 'system', id: 'CalendarChannelDeletionCleanupJob' },
    }),
  ]);
  expect(
    f.eventEmitter.mock.calls.flatMap(([batch]) =>
      batch.events.map((event: { recordId: string }) => event.recordId),
    ),
  ).toEqual([s.associationId]);
});

it.each(['same-workspace', 'foreign-workspace'] as const)(
  'refuses a live channel UUID in %s and changes no native record',
  async (kind) => {
    const s = await seed();
    const workspaceId =
      kind === 'same-workspace' ? f.workspaceId : randomUUID();
    if (workspaceId !== f.workspaceId)
      await f.owner.query('INSERT INTO core.workspace(id) VALUES($1)', [
        workspaceId,
      ]);
    await recreate(s, undefined, workspaceId);
    const before = await all();
    await expect(remove(s.channelId)).rejects.toThrow(
      'requires a deleted channel',
    );
    expect(await all()).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it('preserves tombstoned selected associations and all associations of other channels', async () => {
  const s = await seed();
  await f.owner.query(
    `UPDATE ${table(ROOT)} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
    [s.associationId],
  );
  await f.owner.query(
    `INSERT INTO ${table(ROOT)}(id,"calendarEventId","calendarChannelId","eventExternalId") VALUES($1,$2,$3,$4)`,
    [randomUUID(), s.eventId, randomUUID(), 'other-channel'],
  );
  const before = await all();
  expect(await remove(s.channelId)).toBe(0);
  expect(await all()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('advances beyond 500 skipped rows and audits only the actual later deletion', async () => {
  const s = await seed();
  await f.owner.query(`DELETE FROM ${table(ROOT)} WHERE id=$1`, [
    s.associationId,
  ]);
  const ids = Array.from({ length: 501 }, () => randomUUID()).sort();
  await f.owner.query(
    `INSERT INTO ${table(ROOT)}(id,"calendarEventId","calendarChannelId","eventExternalId") SELECT id,$2,$3,'page-'||id FROM unnest($1::uuid[]) item(id)`,
    [ids, s.eventId, s.channelId],
  );
  await f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".calendar_cleanup_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id<>'${ids[500]}'::uuid THEN RETURN NULL; END IF; RETURN OLD; END $$; CREATE TRIGGER calendar_cleanup_test BEFORE DELETE ON ${table(ROOT)} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".calendar_cleanup_test()`,
  );
  const before = await graph();
  expect(await remove(s.channelId)).toBe(1);
  expect(
    (await f.owner.query(`SELECT id FROM ${table(ROOT)} ORDER BY id`)).map(
      (row: { id: string }) => row.id,
    ),
  ).toEqual(ids.slice(0, 500));
  expect(
    (await audit()).map((row: { resourceId: string }) => row.resourceId),
  ).toEqual([ids[500]]);
  expect(await graph()).toEqual(before);
  expect(
    f.eventEmitter.mock.calls.flatMap(([batch]) =>
      batch.events.map((event: { recordId: string }) => event.recordId),
    ),
  ).toEqual([ids[500]]);
}, 30000);

it('rolls back earlier actual page deletions when the second page fails', async () => {
  const s = await seed();
  await f.owner.query(`DELETE FROM ${table(ROOT)} WHERE id=$1`, [
    s.associationId,
  ]);
  const ids = Array.from({ length: 501 }, () => randomUUID()).sort();
  await f.owner.query(
    `INSERT INTO ${table(ROOT)}(id,"calendarEventId","calendarChannelId","eventExternalId") SELECT id,$2,$3,'failure-page-'||id FROM unnest($1::uuid[]) item(id)`,
    [ids, s.eventId, s.channelId],
  );
  await f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".calendar_cleanup_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='${ids[500]}'::uuid THEN RAISE EXCEPTION 'calendar second page failure'; END IF; RETURN OLD; END $$; CREATE TRIGGER calendar_cleanup_test BEFORE DELETE ON ${table(ROOT)} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".calendar_cleanup_test()`,
  );
  const before = await all();
  const failure = await remove(s.channelId).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(causeMessages(failure)).toContain('calendar second page failure');
  expect(await all()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
}, 30000);

it('refuses populated unhandled incoming FK effects instead of changing an unaudited child', async () => {
  const s = await seed();
  await f.owner.query(
    `CREATE TABLE ${table('calendar_cleanup_extra')}(id uuid PRIMARY KEY,"associationId" uuid REFERENCES ${table(ROOT)}(id) ON DELETE SET NULL)`,
  );
  await f.owner.query(
    `INSERT INTO ${table('calendar_cleanup_extra')}(id,"associationId") VALUES($1,$2)`,
    [randomUUID(), s.associationId],
  );
  await f.owner.query(
    `GRANT SELECT ON ${table('calendar_cleanup_extra')} TO "${f.roleName}"`,
  );
  const before = await all(),
    extra = await read('calendar_cleanup_extra');
  await expect(remove(s.channelId)).rejects.toThrow(
    'excludes unsupported cascade effects',
  );
  expect(await all()).toEqual(before);
  expect(await read('calendar_cleanup_extra')).toEqual(extra);
  expect(await audit()).toEqual([]);
});

it('rolls back association deletion if audit append fails', async () => {
  const s = await seed(),
    before = await all();
  await triggerAudit("RAISE EXCEPTION 'calendar audit append failed';");
  const failure = await remove(s.channelId).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(causeMessages(failure)).toContain('calendar audit append failed');
  expect(await all()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it.each([
  'association-resurrection',
  'channel-recreation',
  'trashed-row-change',
] as const)('rolls back late audit-trigger %s', async (kind) => {
  const s = await seed(),
    trashedId = randomUUID();
  if (kind === 'trashed-row-change')
    await f.owner.query(
      `INSERT INTO ${table(ROOT)}(id,"calendarEventId","calendarChannelId","eventExternalId","deletedAt") VALUES($1,$2,$3,$4,clock_timestamp())`,
      [trashedId, s.eventId, s.channelId, 'trashed'],
    );
  const before = await all();
  const body =
    kind === 'channel-recreation'
      ? `INSERT INTO core."calendarChannel"(id,"workspaceId","connectedAccountId") VALUES('${s.channelId}','${f.workspaceId}','${s.accountId}') ON CONFLICT(id) DO NOTHING;`
      : kind === 'trashed-row-change'
        ? `UPDATE ${table(ROOT)} SET "eventExternalId"='changed-late' WHERE id='${trashedId}';`
        : `INSERT INTO ${table(ROOT)}(id,"calendarEventId","calendarChannelId","eventExternalId") VALUES('${s.associationId}','${s.eventId}','${s.channelId}','resurrected') ON CONFLICT(id) DO NOTHING;`;
  await triggerAudit(body);
  await expect(remove(s.channelId)).rejects.toThrow(
    kind === 'channel-recreation'
      ? 'requires a deleted channel'
      : 'effects mismatch',
  );
  expect(await all()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
  expect(
    await f.owner.query('SELECT id FROM core."calendarChannel" WHERE id=$1', [
      s.channelId,
    ]),
  ).toEqual([]);
});

it('drains a real deferred constraint trigger and rejects association resurrection before commit', async () => {
  const s = await seed(),
    before = await all();
  await f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".calendar_cleanup_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ${table(ROOT)} SELECT OLD.*; RETURN OLD; END $$; CREATE CONSTRAINT TRIGGER calendar_cleanup_test AFTER DELETE ON ${table(ROOT)} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".calendar_cleanup_test()`,
  );
  expect(
    await f.owner.query(
      "SELECT tgdeferrable AS deferrable,tginitdeferred AS deferred FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname='calendar_cleanup_test'",
      [table(ROOT)],
    ),
  ).toEqual([{ deferrable: true, deferred: true }]);
  await expect(remove(s.channelId)).rejects.toThrow('effects mismatch');
  expect(await all()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('refuses a deleted workspace before native effects', async () => {
  const s = await seed(),
    before = await all();
  await f.owner.query(
    'UPDATE core.workspace SET "deletedAt"=clock_timestamp() WHERE id=$1',
    [f.workspaceId],
  );
  await expect(remove(s.channelId)).rejects.toThrow(
    'requires active workspace',
  );
  expect(await all()).toEqual(before);
  expect(await audit()).toEqual([]);
});

it.each(['shared-scope', 'copied-scope', 'foreign-operation'] as const)(
  'rejects %s before any deletion or audit',
  async (kind) => {
    const s = await seed(),
      before = await all();
    const op = operation();
    if (kind === 'foreign-operation') op.workspaceId = randomUUID();
    await expect(
      f.withContext(() =>
        f.dataSource.transaction(
          (scope) =>
            deleteNativeCalendarChannelAssociationsWithAudit({
              scope: kind === 'copied-scope' ? { ...scope } : scope,
              operation: op,
              calendarChannelId: s.channelId,
            }),
          kind === 'shared-scope'
            ? { commitOutcome: 'strict' }
            : { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
        ),
      ),
    ).rejects.toThrow();
    expect(await all()).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it('reports actual lost COMMIT ACK and a later repeat does not create another audit mutation', async () => {
  const s = await seed(),
    before = await graph();
  const client = await f.pool.connect(),
    original = client.query.bind(client);
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const result = await original(statement as string, values);
    if (
      (typeof statement === 'string' ? statement : statement.text) === 'COMMIT'
    )
      throw new Error('calendar cleanup COMMIT ACK lost');
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await expect(remove(s.channelId)).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(await read(ROOT)).toEqual([]);
  expect(await graph()).toEqual(before);
  expect(await audit()).toHaveLength(1);
  expect(await remove(s.channelId)).toBe(0);
  expect(await audit()).toHaveLength(1);
});

const waitForLock = async (fragment: string) => {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const rows = await f.owner.query(
      "SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1",
      ['%' + fragment + '%'],
    );
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected actual PostgreSQL lock wait: ' + fragment);
};

it('waits for an earlier channel INSERT and refuses the committed channel without native deletion', async () => {
  const s = await seed(),
    before = await all();
  const writer = f.owner.createQueryRunner();
  await writer.connect();
  await writer.startTransaction();
  let work: Promise<unknown> | undefined;
  try {
    await recreate(s, writer.query.bind(writer));
    work = remove(s.channelId).then(
      () => undefined,
      (error: unknown) => error,
    );
    await waitForLock('LOCK TABLE core."calendarChannel"');
    await writer.commitTransaction();
    expect(await work).toBeInstanceOf(Error);
    expect(causeMessages(await work)).toContain('requires a deleted channel');
    expect(await all()).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
    expect(
      await f.owner.query('SELECT id FROM core."calendarChannel" WHERE id=$1', [
        s.channelId,
      ]),
    ).toEqual([{ id: s.channelId }]);
  } finally {
    if (writer.isTransactionActive) await writer.rollbackTransaction();
    await writer.release();
    if (work) await Promise.allSettled([work]);
  }
});

it('holds the core table SHARE lock until commit so a later INSERT cannot invalidate the absence proof', async () => {
  const s = await seed();
  const client = await f.pool.connect(),
    original = client.query.bind(client);
  let reached!: () => void,
    release!: () => void,
    held = false;
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
    const sql = typeof statement === 'string' ? statement : statement.text;
    const result = await original(statement as string, values);
    if (
      !held &&
      sql.includes('LOCK TABLE core."calendarChannel"') &&
      sql.includes('SHARE')
    ) {
      held = true;
      reached();
      await resume;
    }
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  const work = remove(s.channelId);
  let inserting: Promise<unknown> | undefined;
  try {
    await Promise.race([
      locked,
      work.then(() => {
        throw new Error('Missing calendar table lock');
      }),
    ]);
    const marker = 'calendar-recreate-' + randomUUID();
    inserting = f.owner.query(
      `/* ${marker} */ INSERT INTO core."calendarChannel"(id,"workspaceId","connectedAccountId") VALUES($1,$2,$3)`,
      [s.channelId, f.workspaceId, s.accountId],
    );
    await waitForLock(marker);
    expect(await audit()).toEqual([]);
  } finally {
    release();
    await Promise.allSettled([work, ...(inserting ? [inserting] : [])]);
  }
  expect(await work).toBe(1);
  await inserting;
  expect(await read(ROOT)).toEqual([]);
  expect(await audit()).toHaveLength(1);
  // Creation after cleanup commits is permitted; no claim of permanent absence.
  expect(
    await f.owner.query('SELECT id FROM core."calendarChannel" WHERE id=$1', [
      s.channelId,
    ]),
  ).toEqual([{ id: s.channelId }]);
});
