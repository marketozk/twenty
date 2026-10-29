import { randomUUID } from 'node:crypto';
import { type QueryRunner } from 'typeorm';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import {
  type WorkspaceTransactionOptions,
  type WorkspaceTransactionScope,
} from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { MatchParticipantService } from 'src/modules/match-participant/match-participant.service';
import { ParticipantTargetReconciliationService } from 'src/modules/match-participant/participant-target-reconciliation.service';
import { type CalendarEventParticipantWorkspaceEntity } from 'src/modules/calendar/common/standard-objects/calendar-event-participant.workspace-entity';
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

// Same real metadata, schema and repository foundation as omni-native-reconciliation;
// extend its calendar graph with Association/CallRecording and preserve real FK actions.
const f = createOmniNativeMessageFixture({
  useStandardForeignKeyActions: true,
  additionalTables: [
    'workspaceMember',
    'company',
    'opportunity',
    'calendarEvent',
    'calendarEventParticipant',
    'calendarEventTarget',
    'calendarChannelEventAssociation',
    'callRecording',
  ],
});
const EVENT = 'calendarEvent',
  PART = 'calendarEventParticipant',
  TARGET = 'calendarEventTarget';
const SOURCES = ['person', 'workspaceMember', 'company', 'opportunity'];
const NAMES = [
  EVENT,
  PART,
  TARGET,
  'calendarChannelEventAssociation',
  'callRecording',
  ...SOURCES,
];
const table = (name: string) => `"${f.schemaName}"."${name}"`;
const permissions = { shouldBypassPermissionChecks: true } as const;
const manager = {
  getWorkspaceId: () => f.workspaceId,
  executeInWorkspaceContext: async <T>(work: () => Promise<T>) =>
    f.withContext(work),
  runInWorkspaceTransaction: async <T>(
    work: (scope: WorkspaceTransactionScope) => Promise<T>,
    options?: WorkspaceTransactionOptions,
  ) => f.dataSource.transaction(work, options),
  getRepository: () => {
    throw new Error('MATCHING_READ_ESCAPED_TRANSACTION');
  },
} as unknown as WorkspaceOrmManager;
const targets = new ParticipantTargetReconciliationService(manager, f.owner);
const matcher =
  new MatchParticipantService<CalendarEventParticipantWorkspaceEntity>(
    manager,
    targets,
    {} as never,
    f.owner,
  );
const operation = (): CrmAuditOperation => ({
  workspaceId: f.workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'system', id: 'CalendarImportMatchingTest' },
  correlationId: randomUUID(),
});
const match = (
  participantIds: string[],
  eventIds: string[],
  op = operation(),
) =>
  matcher.matchCalendarImportParticipantsWithAudit({
    workspaceId: f.workspaceId,
    participantIds,
    eventIds,
    operation: op,
  });
const insert = async (name: string, fields: Record<string, unknown>) => {
  const id = randomUUID();
  await f.withContext(() =>
    f.dataSource.transaction(
      async (scope) => {
        await scope.getRepository(name, permissions).insert({ id, ...fields });
      },
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
  return id;
};
const newEvent = () =>
  insert(EVENT, {
    title: 'Unchanged private title',
    startsAt: '2030-01-01T10:00:00Z',
    endsAt: '2030-01-01T11:00:00Z',
  });
const newPerson = (email: string, extra: Record<string, unknown> = {}) =>
  insert('person', {
    name: { firstName: 'Private', lastName: 'Person' },
    emails: { primaryEmail: email, additionalEmails: [] },
    ...extra,
  });
const newParticipant = (eventId: string, extra: Record<string, unknown> = {}) =>
  insert(PART, {
    calendarEventId: eventId,
    handle: 'client@example.test',
    displayName: 'Private attendee',
    responseStatus: 'ACCEPTED',
    isOrganizer: false,
    personId: null,
    workspaceMemberId: null,
    ...extra,
  });
const newTarget = (
  eventId: string,
  personId: string,
  extra: Record<string, unknown> = {},
) =>
  insert(TARGET, {
    calendarEventId: eventId,
    targetPersonId: personId,
    targetCompanyId: null,
    targetOpportunityId: null,
    isAutomaticallyAssigned: true,
    isManuallyAssigned: false,
    ...extra,
  });
const rows = (name: string) =>
  f.read(name) as Promise<Record<string, unknown>[]>;
const readExact = (name: string) =>
  f.owner.query(
    `SELECT to_jsonb(row)::text AS row FROM ${table(name)} row ORDER BY id`,
  );
const graph = () => Promise.all(NAMES.map(readExact));
const audit = () =>
  f.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "resourceId",id',
  ) as Promise<Record<string, unknown>[]>;
const seed = async () => {
  const companyId = await insert('company', { name: 'Private company' });
  const personId = await newPerson('client@example.test', { companyId });
  const memberId = await insert('workspaceMember', {
    name: { firstName: 'Private', lastName: 'Member' },
    userId: randomUUID(),
    userEmail: 'client@example.test',
  });
  const opportunityId = await insert('opportunity', {
    name: 'Private opportunity',
    companyId,
    pointOfContactId: personId,
  });
  const eventId = await newEvent();
  const participantId = await newParticipant(eventId);
  const associationId = await insert('calendarChannelEventAssociation', {
    calendarEventId: eventId,
    calendarChannelId: randomUUID(),
    eventExternalId: 'private-external-id',
  });
  const recordingId = await insert('callRecording', {
    calendarEventId: eventId,
  });
  f.eventEmitter.mockClear();
  return {
    companyId,
    personId,
    memberId,
    opportunityId,
    eventId,
    participantId,
    associationId,
    recordingId,
  };
};
const nativeTrigger = async (
  name: string,
  timing: string,
  action: string,
  body: string,
  deferred = false,
) =>
  f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".calendar_match_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$; CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER calendar_match_test ${timing} ${action} ON ${table(name)} ${deferred ? 'DEFERRABLE INITIALLY DEFERRED ' : ''}FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".calendar_match_test()`,
  );
const auditTrigger = async (body: string) =>
  f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".calendar_match_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN ${body} RETURN NEW; END $$; CREATE TRIGGER calendar_match_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".calendar_match_test()`,
  );
const causeMessages = (error: unknown): string[] => {
  const messages: string[] = [],
    seen = new Set<object>();
  for (
    let depth = 0;
    depth < 8 &&
    typeof error === 'object' &&
    error !== null &&
    !seen.has(error);
    depth++
  ) {
    seen.add(error);
    const current = error as { message?: unknown; cause?: unknown };
    if (typeof current.message === 'string') messages.push(current.message);
    error = current.cause;
  }
  return messages;
};
const rollbackProof = async (
  work: Promise<unknown>,
  before: unknown,
  expectedCause: string,
) => {
  f.eventEmitter.mockClear();
  const outcome = await work.then(
    () => ({ rejected: false as const, error: undefined }),
    (error: unknown) => ({ rejected: true as const, error }),
  );
  expect(outcome.rejected).toBe(true);
  // The precise owner/trigger cause must survive ORM/core wrappers; a fixture
  // permission, missing column or unrelated earlier failure must fail this test.
  expect(causeMessages(outcome.error).join(' | ')).toContain(expectedCause);
  expect(await graph()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
};

beforeAll(async () => {
  await f.initialize();
  await f.owner.query(`GRANT UPDATE ON core.workspace TO "${f.roleName}"`);
});
beforeEach(async () => {
  await f.owner.query(
    'DROP TRIGGER IF EXISTS calendar_match_audit ON crm_audit."crmAuditEntry"',
  );
  for (const name of NAMES)
    await f.owner.query(
      `DROP TRIGGER IF EXISTS calendar_match_test ON ${table(name)}`,
    );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".calendar_match_test()`,
  );
  await f.owner.query(`DROP TABLE IF EXISTS ${table('calendar_match_child')}`);
  await f.owner.query(
    `ALTER TABLE ${table(PART)} DROP CONSTRAINT IF EXISTS calendar_match_part_pair`,
  );
  await f.reset();
  await f.owner.query('TRUNCATE core.workspace CASCADE');
  await f.owner.query('INSERT INTO core.workspace(id) VALUES($1)', [
    f.workspaceId,
  ]);
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it('audits actual Participant links and three target kinds in one operation while retaining the other graph', async () => {
  const s = await seed(),
    op = operation();
  const retained = await Promise.all(
    NAMES.filter((name) => name !== PART && name !== TARGET).map(readExact),
  );
  await match([s.participantId], [s.eventId], op);
  expect(await rows(PART)).toEqual([
    expect.objectContaining({
      id: s.participantId,
      personId: s.personId,
      workspaceMemberId: s.memberId,
      responseStatus: 'ACCEPTED',
      isOrganizer: false,
      handle: 'client@example.test',
    }),
  ]);
  expect(await rows(TARGET)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ targetPersonId: s.personId }),
      expect.objectContaining({ targetCompanyId: s.companyId }),
      expect.objectContaining({ targetOpportunityId: s.opportunityId }),
    ]),
  );
  expect(await rows(TARGET)).toHaveLength(3);
  const entries = await audit();
  expect(entries).toHaveLength(4);
  expect(new Set(entries.map((entry) => entry.operationId)).size).toBe(1);
  for (const entry of entries)
    expect(entry).toMatchObject({
      actor: op.actor,
      correlationId: op.correlationId,
      resourceKind: 'crmRecord',
    });
  expect(
    entries.filter((entry) => entry.resourceId === s.participantId),
  ).toEqual([expect.objectContaining({ action: 'update' })]);
  expect(JSON.stringify(entries)).not.toContain('client@example.test');
  expect(
    await Promise.all(
      NAMES.filter((name) => name !== PART && name !== TARGET).map(readExact),
    ),
  ).toEqual(retained);
  await match([s.participantId], [s.eventId]);
  expect(await audit()).toEqual(entries);
});

it('prefers a newer primary-email match over an older additional-email match without changing original helper semantics', async () => {
  const older = await newPerson('different@example.test', {
    emails: {
      primaryEmail: 'different@example.test',
      additionalEmails: ['client@example.test'],
    },
  });
  const primary = await newPerson('CLIENT@example.test');
  await f.owner.query(
    `UPDATE ${table('person')} SET "createdAt"=CASE WHEN id=$1 THEN '2000-01-01'::timestamptz ELSE '2001-01-01'::timestamptz END`,
    [older],
  );
  const eventId = await newEvent(),
    participantId = await newParticipant(eventId);
  await match([participantId], [eventId]);
  expect((await rows(PART))[0].personId).toBe(primary);
  expect((await rows(TARGET))[0].targetPersonId).toBe(primary);
});

it('uses normalized JSONB additional-email candidate containment, not a broader lowercase stored-email search', async () => {
  await newPerson('other@example.test', {
    emails: {
      primaryEmail: 'other@example.test',
      additionalEmails: ['CLIENT@example.test'],
    },
  });
  const eventId = await newEvent(),
    participantId = await newParticipant(eventId);
  await match([participantId], [eventId]);
  expect((await rows(PART))[0].personId).toBeNull();
  expect(await audit()).toEqual([]);
  expect(await rows(TARGET)).toEqual([]);
});

it('matches an additional-only email selected by the existing JSONB query', async () => {
  const personId = await newPerson('different@example.test', {
    emails: {
      primaryEmail: 'different@example.test',
      additionalEmails: ['client@example.test'],
    },
  });
  const eventId = await newEvent(),
    participantId = await newParticipant(eventId, {
      handle: 'CLIENT@example.test',
    });
  await match([participantId], [eventId]);
  expect((await rows(PART))[0].personId).toBe(personId);
  expect(await rows(TARGET)).toEqual([
    expect.objectContaining({ targetPersonId: personId }),
  ]);
  expect(await audit()).toHaveLength(2);
});

it('handles a null-only handle batch without inventing an empty email selector or retaining obsolete links', async () => {
  const personId = await newPerson('old@example.test'),
    eventId = await newEvent();
  const participantId = await newParticipant(eventId, {
    handle: null,
    personId,
  });
  await match([participantId], [eventId]);
  expect((await rows(PART))[0]).toMatchObject({
    handle: null,
    personId: null,
    workspaceMemberId: null,
  });
  expect(await rows(TARGET)).toEqual([]);
  expect(await audit()).toEqual([
    expect.objectContaining({ action: 'update', resourceId: participantId }),
  ]);
});

it('preserves the existing Company target policy even when the linked Company is soft deleted', async () => {
  const s = await seed();
  await f.owner.query(
    `UPDATE ${table('company')} SET "deletedAt"='2029-01-01' WHERE id=$1`,
    [s.companyId],
  );
  await match([s.participantId], [s.eventId]);
  expect(await rows(TARGET)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ targetCompanyId: s.companyId }),
    ]),
  );
  expect(await audit()).toHaveLength(4);
});

it('matches a trashed Person but derives no targets from that Person', async () => {
  const personId = await newPerson('client@example.test', {
    deletedAt: new Date('2029-01-01'),
  });
  const eventId = await newEvent(),
    participantId = await newParticipant(eventId);
  await match([participantId], [eventId]);
  expect((await rows(PART))[0].personId).toBe(personId);
  expect(await rows(TARGET)).toEqual([]);
  expect(await audit()).toEqual([
    expect.objectContaining({ resourceId: participantId, action: 'update' }),
  ]);
});

it('matches live workspace members with exact handle case while Person matching remains case insensitive', async () => {
  const personId = await newPerson('CLIENT@example.test');
  await insert('workspaceMember', {
    userId: randomUUID(),
    userEmail: 'CLIENT@example.test',
  });
  await insert('workspaceMember', {
    userId: randomUUID(),
    userEmail: 'client@example.test',
    deletedAt: new Date('2029-01-01'),
  });
  const eventId = await newEvent(),
    participantId = await newParticipant(eventId);
  await match([participantId], [eventId]);
  expect((await rows(PART))[0]).toMatchObject({
    personId,
    workspaceMemberId: null,
  });
});

it('derives targets from unrequested live participants and linked events without rematching their links', async () => {
  const s = await seed(),
    linkedEvent = await newEvent(),
    unrelatedPerson = await newPerson('linked@example.test');
  const retainedParticipant = await newParticipant(linkedEvent, {
    personId: unrelatedPerson,
    handle: 'client@example.test',
  });
  const retained = (await readExact(PART)).find(
    (row: { row: string }) => JSON.parse(row.row).id === retainedParticipant,
  );
  await match([s.participantId], [s.eventId, linkedEvent]);
  expect(
    (await readExact(PART)).find(
      (row: { row: string }) => JSON.parse(row.row).id === retainedParticipant,
    ),
  ).toEqual(retained);
  expect(await rows(TARGET)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        calendarEventId: linkedEvent,
        targetPersonId: unrelatedPerson,
      }),
    ]),
  );
  expect(
    (await audit()).some((entry) => entry.resourceId === retainedParticipant),
  ).toBe(false);
});

it('reconciles supplied events with no saved participant IDs and retains manual/tombstone policy', async () => {
  const s = await seed();
  await f.owner.query(`UPDATE ${table(PART)} SET "personId"=$1 WHERE id=$2`, [
    s.personId,
    s.participantId,
  ]);
  const tombstone = await newTarget(s.eventId, s.personId, {
    deletedAt: new Date('2029-01-01'),
  });
  const oldPerson = await newPerson('old@example.test');
  const manual = await newTarget(s.eventId, oldPerson, {
    isManuallyAssigned: true,
  });
  const obsoletePerson = await newPerson('obsolete@example.test');
  const obsolete = await newTarget(s.eventId, obsoletePerson);
  f.eventEmitter.mockClear();
  await match([], [s.eventId]);
  const current = await rows(TARGET);
  expect(current.find((row) => row.id === tombstone)?.deletedAt).not.toBeNull();
  expect(current.find((row) => row.id === manual)).toMatchObject({
    isManuallyAssigned: true,
    isAutomaticallyAssigned: false,
  });
  expect(current.some((row) => row.id === obsolete)).toBe(false);
  expect(
    current.filter((row) => row.targetPersonId === s.personId),
  ).toHaveLength(1);
  const entries = await audit();
  expect(entries).toHaveLength(4);
  expect(
    entries.some(
      (entry) =>
        entry.resourceId === s.participantId || entry.resourceId === tombstone,
    ),
  ).toBe(false);
});

it('uses actual links after a skipped Participant UPDATE instead of proposed match targets', async () => {
  const s = await seed(),
    oldPerson = await newPerson('old@example.test');
  await f.owner.query(`UPDATE ${table(PART)} SET "personId"=$1 WHERE id=$2`, [
    oldPerson,
    s.participantId,
  ]);
  const before = await readExact(PART);
  await nativeTrigger(PART, 'BEFORE', 'UPDATE', 'RETURN NULL;');
  await match([s.participantId], [s.eventId]);
  expect(await readExact(PART)).toEqual(before);
  expect(await rows(TARGET)).toEqual([
    expect.objectContaining({ targetPersonId: oldPerson }),
  ]);
  expect(await audit()).toEqual([
    expect.objectContaining({ action: 'create' }),
  ]);
});

it.each(['INSERT', 'UPDATE', 'DELETE'])(
  'audits no target effect when the real target %s is skipped',
  async (action) => {
    const s = await seed();
    await f.owner.query(
      `UPDATE ${table(PART)} SET "personId"=$1,"workspaceMemberId"=$2 WHERE id=$3`,
      [s.personId, s.memberId, s.participantId],
    );
    if (action !== 'INSERT') {
      await match([], [s.eventId]);
      if (action === 'UPDATE')
        await f.owner.query(
          `UPDATE ${table(TARGET)} SET "isAutomaticallyAssigned"=false`,
        );
      else await f.owner.query(`UPDATE ${table(PART)} SET "personId"=NULL`);
      await f.owner.query('TRUNCATE crm_audit."crmAuditEntry"');
    }
    const before = await graph();
    await nativeTrigger(TARGET, 'BEFORE', action, 'RETURN NULL;');
    await match([], [s.eventId]);
    expect(await graph()).toEqual(before);
    expect(await audit()).toEqual([]);
  },
);

it('rolls back earlier Participant changes when later target writing fails', async () => {
  const s = await seed(),
    before = await graph();
  await nativeTrigger(
    TARGET,
    'BEFORE',
    'INSERT',
    "RAISE EXCEPTION 'target write refused';",
  );
  await rollbackProof(
    match([s.participantId], [s.eventId]),
    before,
    'target write refused',
  );
});

it('rolls back both link and target changes when audit insertion fails', async () => {
  const s = await seed(),
    before = await graph();
  await auditTrigger("RAISE EXCEPTION 'audit insert refused';");
  await rollbackProof(
    match([s.participantId], [s.eventId]),
    before,
    'audit insert refused',
  );
});

it('rejects a Person source change caused by Participant UPDATE before the target stage adopts new snapshots', async () => {
  const s = await seed(),
    before = await graph();
  await nativeTrigger(
    PART,
    'AFTER',
    'UPDATE',
    `UPDATE ${table('person')} SET "nameFirstName"='unexpected source' WHERE id='${s.personId}'; RETURN NEW;`,
  );
  await rollbackProof(
    match([s.participantId], [s.eventId]),
    before,
    'Calendar matching sources changed',
  );
});

it('rejects a new matching Person introduced by its own Participant trigger despite held source SHARE locks', async () => {
  const oldPerson = await newPerson('old@example.test'),
    eventId = await newEvent();
  const participantId = await newParticipant(eventId, { personId: oldPerson });
  const before = await graph();
  f.eventEmitter.mockClear();
  await nativeTrigger(
    PART,
    'AFTER',
    'UPDATE',
    `INSERT INTO ${table('person')}(id,"emailsPrimaryEmail") VALUES('${randomUUID()}','client@example.test'); RETURN NEW;`,
  );
  await rollbackProof(
    match([participantId], [eventId]),
    before,
    'Calendar matching sources changed',
  );
});

it('drains deferred trigger changes and rejects an unexplained link rewrite before COMMIT', async () => {
  const s = await seed(),
    before = await graph();
  await nativeTrigger(
    PART,
    'AFTER',
    'UPDATE',
    `IF NEW."personId" IS NOT NULL THEN UPDATE ${table(PART)} SET "personId"=NULL WHERE id=NEW.id; END IF; RETURN NEW;`,
    true,
  );
  await rollbackProof(
    match([s.participantId], [s.eventId]),
    before,
    'Calendar matching graph effects mismatch',
  );
});

it('retains a requested Participant already moved outside the supplied event IDs without widening target parents', async () => {
  const s = await seed(),
    otherEvent = await newEvent();
  await f.owner.query(
    `UPDATE ${table(PART)} SET "calendarEventId"=$1 WHERE id=$2`,
    [otherEvent, s.participantId],
  );
  const before = await graph();
  await match([s.participantId], [s.eventId]);
  expect(await graph()).toEqual(before);
  expect(await audit()).toEqual([]);
});

it('rolls back a late Participant reparent introduced by the audit trigger', async () => {
  const s = await seed(),
    otherEvent = await newEvent(),
    before = await graph();
  await auditTrigger(
    `UPDATE ${table(PART)} SET "calendarEventId"='${otherEvent}' WHERE id='${s.participantId}';`,
  );
  await rollbackProof(
    match([s.participantId], [s.eventId]),
    before,
    'Calendar matching graph effects mismatch',
  );
});

it('keeps committed matching and audit on lost COMMIT acknowledgement and does not emit misleading success events', async () => {
  const s = await seed(),
    client = await f.pool.connect(),
    original = client.query.bind(client),
    statements: string[] = [];
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const text = typeof statement === 'string' ? statement : statement.text;
    statements.push(text);
    const result = await original(statement as string, values);
    if (text === 'COMMIT')
      throw new Error('matching COMMIT acknowledgement lost');
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await expect(match([s.participantId], [s.eventId])).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(statements).not.toContain('ROLLBACK');
  expect((await rows(PART))[0]).toMatchObject({
    personId: s.personId,
    workspaceMemberId: s.memberId,
  });
  expect(await rows(TARGET)).toHaveLength(3);
  expect(await audit()).toHaveLength(4);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const capture = <T>(pending: Promise<T>) =>
  pending.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
const waitForBlocker = async (waiting: number, blocking: number) => {
  for (let i = 0; i < 150; i++) {
    const [row] = await f.owner.query(
      'SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',
      [waiting, blocking],
    );
    if (row.blocked) return;
    await f.owner.query('SELECT pg_sleep(0.01)');
  }
  throw new Error('Expected PostgreSQL source-table blocker was not observed');
};
const closeWriter = async (writer: QueryRunner) => {
  if (writer.isTransactionActive) await writer.rollbackTransaction();
  await writer.release();
};

it('holds Person SHARE through finalization so a previously absent matching email cannot be inserted concurrently', async () => {
  const eventId = await newEvent(),
    participantId = await newParticipant(eventId);
  const writer = f.owner.createQueryRunner();
  await writer.connect();
  const [{ pid: writerPid }] = await writer.query(
    'SELECT pg_backend_pid() AS pid',
  );
  const client = await f.pool.connect(),
    original = client.query.bind(client);
  const nativePid = (await client.query('SELECT pg_backend_pid() AS pid'))
    .rows[0].pid as number;
  const reached = barrier(),
    resume = barrier();
  let held = false;
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const text = typeof statement === 'string' ? statement : statement.text;
    const result = await original(statement as string, values);
    if (
      !held &&
      text.includes('LOCK TABLE') &&
      text.includes(table('person')) &&
      text.includes('SHARE')
    ) {
      held = true;
      reached.release();
      await resume.promise;
    }
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  const work = capture(match([participantId], [eventId]));
  let mutation: ReturnType<typeof capture> | undefined;
  try {
    await Promise.race([
      reached.promise,
      work.then(() => {
        throw new Error('Matching settled before Person SHARE lock');
      }),
    ]);
    mutation = capture(
      writer.query(
        `INSERT INTO ${table('person')}(id,"emailsPrimaryEmail") VALUES($1,'client@example.test')`,
        [randomUUID()],
      ),
    );
    await waitForBlocker(writerPid, nativePid);
    resume.release();
    const outcome = await work;
    if (!outcome.ok) throw outcome.error;
    const changed = await mutation;
    if (!changed.ok) throw changed.error;
    expect((await rows(PART))[0].personId).toBeNull();
    expect(await audit()).toEqual([]);
    await match([participantId], [eventId]);
    expect((await rows(PART))[0].personId).toBe((await rows('person'))[0].id);
    expect(await audit()).toHaveLength(2);
  } finally {
    resume.release();
    await work;
    if (mutation) await mutation;
    await closeWriter(writer);
  }
});

it('waits for an earlier Person writer and then matches its committed email', async () => {
  const eventId = await newEvent(),
    participantId = await newParticipant(eventId),
    personId = randomUUID();
  const writer = f.owner.createQueryRunner();
  await writer.connect();
  await writer.startTransaction();
  const [{ pid: writerPid }] = await writer.query(
    'SELECT pg_backend_pid() AS pid',
  );
  await writer.query(
    `INSERT INTO ${table('person')}(id,"emailsPrimaryEmail") VALUES($1,'client@example.test')`,
    [personId],
  );
  const client = await f.pool.connect(),
    nativePid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0]
      .pid as number;
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  const work = capture(match([participantId], [eventId]));
  try {
    await waitForBlocker(nativePid, writerPid);
    await writer.commitTransaction();
    const outcome = await work;
    if (!outcome.ok) throw outcome.error;
    expect((await rows(PART))[0].personId).toBe(personId);
    expect(await rows(TARGET)).toEqual([
      expect.objectContaining({ targetPersonId: personId }),
    ]);
    expect(await audit()).toHaveLength(2);
  } finally {
    await closeWriter(writer);
    await work;
  }
});

it('rejects a missing actual Event-to-Participant FK before matching mutates anything', async () => {
  const s = await seed(),
    before = await graph();
  const [reference] = await f.owner.query(
    `SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND confrelid=$2::regclass AND contype='f'`,
    [table(PART), table(EVENT)],
  );
  expect(reference).toBeDefined();
  const constraint = String(reference.conname).replaceAll('"', '""');
  await f.owner.query(
    `ALTER TABLE ${table(PART)} DROP CONSTRAINT "${constraint}"`,
  );
  try {
    await rollbackProof(
      match([s.participantId], [s.eventId]),
      before,
      'Calendar matching requires event foreign keys',
    );
  } finally {
    await f.owner.query(
      `ALTER TABLE ${table(PART)} ADD CONSTRAINT "${constraint}" ${reference.definition}`,
    );
  }
});

it('refuses a populated unknown incoming target CASCADE rather than deleting an unaudited child', async () => {
  const s = await seed(),
    oldPerson = await newPerson('obsolete@example.test');
  const obsolete = await newTarget(s.eventId, oldPerson);
  await f.owner.query(
    `CREATE TABLE ${table('calendar_match_child')}(id uuid PRIMARY KEY,"targetId" uuid REFERENCES ${table(TARGET)}(id) ON DELETE CASCADE)`,
  );
  await f.owner.query(
    `INSERT INTO ${table('calendar_match_child')} VALUES($1,$2)`,
    [randomUUID(), obsolete],
  );
  await f.owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ${table('calendar_match_child')} TO "${f.roleName}"`,
  );
  const before = await graph(),
    child = await readExact('calendar_match_child');
  await rollbackProof(
    match([s.participantId], [s.eventId]),
    before,
    'Calendar matching excludes unsupported target cascade effects',
  );
  expect(await readExact('calendar_match_child')).toEqual(child);
});

it('refuses incoming ON UPDATE effects on Participant.personId while preserving the actual dependent', async () => {
  const s = await seed(),
    oldPerson = await newPerson('old@example.test');
  await f.owner.query(`UPDATE ${table(PART)} SET "personId"=$1 WHERE id=$2`, [
    oldPerson,
    s.participantId,
  ]);
  await f.owner.query(
    `ALTER TABLE ${table(PART)} ADD CONSTRAINT calendar_match_part_pair UNIQUE(id,"personId")`,
  );
  await f.owner.query(
    `CREATE TABLE ${table('calendar_match_child')}(id uuid PRIMARY KEY,"participantId" uuid,"personId" uuid,FOREIGN KEY("participantId","personId") REFERENCES ${table(PART)}(id,"personId") ON UPDATE CASCADE)`,
  );
  await f.owner.query(
    `INSERT INTO ${table('calendar_match_child')} VALUES($1,$2,$3)`,
    [randomUUID(), s.participantId, oldPerson],
  );
  await f.owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ${table('calendar_match_child')} TO "${f.roleName}"`,
  );
  const before = await graph(),
    child = await readExact('calendar_match_child');
  await rollbackProof(
    match([s.participantId], [s.eventId]),
    before,
    'Native audit excludes referential UPDATE effects',
  );
  expect(await readExact('calendar_match_child')).toEqual(child);
});

it('does not adopt an alternate target inserted by a trigger that skips the proposed INSERT', async () => {
  const s = await seed(),
    before = await graph();
  await nativeTrigger(
    TARGET,
    'BEFORE',
    'INSERT',
    `IF pg_trigger_depth()=1 THEN INSERT INTO ${table(TARGET)}(id,"calendarEventId","targetPersonId","targetCompanyId","targetOpportunityId","isAutomaticallyAssigned","isManuallyAssigned") VALUES(uuid_generate_v4(),NEW."calendarEventId",NEW."targetPersonId",NEW."targetCompanyId",NEW."targetOpportunityId",true,false); RETURN NULL; END IF; RETURN NEW;`,
  );
  await rollbackProof(
    match([s.participantId], [s.eventId]),
    before,
    'Calendar matching graph effects mismatch',
  );
});

it.each(['person', 'workspaceMember', 'company', 'opportunity'])(
  'refuses late %s source changes made by the audit trigger',
  async (source) => {
    const s = await seed(),
      before = await graph();
    const sourceIds: Record<string, string> = {
      person: s.personId,
      workspaceMember: s.memberId,
      company: s.companyId,
      opportunity: s.opportunityId,
    };
    const id = sourceIds[source];
    await auditTrigger(
      `UPDATE ${table(source)} SET "deletedAt"=CURRENT_TIMESTAMP WHERE id='${id}';`,
    );
    await rollbackProof(
      match([s.participantId], [s.eventId]),
      before,
      'Calendar matching sources changed',
    );
  },
);

it('captures arrays and audit identity before awaiting the native transaction', async () => {
  const s = await seed(),
    op = operation(),
    originalActor = { ...op.actor },
    originalCorrelation = op.correlationId;
  const participantIds = [s.participantId],
    eventIds = [s.eventId];
  const client = await f.pool.connect(),
    original = client.query.bind(client);
  let changed = false;
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const text = typeof statement === 'string' ? statement : statement.text;
    if (!changed && text === 'BEGIN') {
      changed = true;
      participantIds.splice(0);
      eventIds.splice(0);
      op.actor.id = 'UntrustedMutation';
      op.correlationId = randomUUID();
    }
    return original(statement as string, values);
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await match(participantIds, eventIds, op);
  expect(changed).toBe(true);
  expect((await rows(PART))[0].personId).toBe(s.personId);
  const entries = await audit();
  expect(entries).toHaveLength(4);
  for (const entry of entries)
    expect(entry).toMatchObject({
      actor: originalActor,
      correlationId: originalCorrelation,
    });
});

it('refuses another workspace operation before graph mutation', async () => {
  const s = await seed(),
    before = await graph();
  await rollbackProof(
    match([s.participantId], [s.eventId], {
      ...operation(),
      workspaceId: randomUUID(),
    }),
    before,
    'Calendar matching requires scoped input and audit identity',
  );
});

it('holds all four source tables in SHARE mode before graph rows are locked', async () => {
  const s = await seed(),
    client = await f.pool.connect(),
    original = client.query.bind(client);
  let checked = false;
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const text = typeof statement === 'string' ? statement : statement.text;
    if (
      !checked &&
      text.includes(table(EVENT)) &&
      text.includes('FOR UPDATE')
    ) {
      checked = true;
      const held = await original(
        `SELECT c.relname FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=pg_backend_pid() AND l.granted AND l.mode='ShareLock' AND n.nspname=$1`,
        [f.schemaName],
      );
      expect(held.rows.map((row) => row.relname)).toEqual(
        expect.arrayContaining(SOURCES),
      );
    }
    return original(statement as string, values);
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await match([s.participantId], [s.eventId]);
  expect(checked).toBe(true);
});

// This exercises real PostgreSQL generated postimages on a column derived from
// the exact personId field changed by the new matching owner.
const withGeneratedParticipantSearch = async (work: () => Promise<void>) => {
  const [original] = await f.owner.query(
    `SELECT format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS required, a.attgenerated AS generated, pg_get_expr(d.adbin,d.adrelid) AS expression FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::regclass AND a.attname='searchVector' AND NOT a.attisdropped`,
    [table(PART)],
  );
  expect(original).toBeDefined();
  await f.owner.query(`ALTER TABLE ${table(PART)} DROP COLUMN "searchVector"`);
  try {
    await f.owner.query(
      `ALTER TABLE ${table(PART)} ADD COLUMN "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig,COALESCE("personId"::text,''))) STORED`,
    );
    await work();
  } finally {
    await f.owner.query(
      `DROP TABLE IF EXISTS ${table('calendar_match_child')}`,
    );
    await f.owner.query(
      `DROP INDEX IF EXISTS "${f.schemaName}".calendar_match_generated_pair`,
    );
    await f.owner.query(
      `ALTER TABLE ${table(PART)} DROP COLUMN IF EXISTS "searchVector"`,
    );
    await f.owner.query(
      `ALTER TABLE ${table(PART)} ADD COLUMN "searchVector" ${original.type}${original.generated ? ` GENERATED ALWAYS AS (${original.expression}) STORED` : original.expression ? ` DEFAULT ${original.expression}` : ''}${original.required ? ' NOT NULL' : ''}`,
    );
  }
};

it('recomputes the actual generated Participant searchVector when matching changes personId', async () => {
  await withGeneratedParticipantSearch(async () => {
    const s = await seed();
    const [before] = await f.owner.query(
      `SELECT id,"searchVector"::text AS vector FROM ${table(PART)} WHERE id=$1`,
      [s.participantId],
    );
    await match([s.participantId], [s.eventId]);
    const [after] = await f.owner.query(
      `SELECT id,"personId","searchVector"::text AS vector,"searchVector"=to_tsvector('simple'::regconfig,COALESCE("personId"::text,'')) AS correct FROM ${table(PART)} WHERE id=$1`,
      [s.participantId],
    );
    expect(after.id).toBe(before.id);
    expect(after.personId).toBe(s.personId);
    expect(after.correct).toBe(true);
    expect(after.vector).not.toBe(before.vector);
    const entries = await audit();
    expect(entries).toHaveLength(4);
    expect(
      entries.filter((entry) => entry.resourceId === s.participantId),
    ).toEqual([
      expect.objectContaining({
        resourceId: s.participantId,
        action: 'update',
      }),
    ]);
    expect(await rows(TARGET)).toHaveLength(3);
  });
});

it('refuses an incoming generated Participant searchVector ON UPDATE cascade before modifying the unaudited child', async () => {
  await withGeneratedParticipantSearch(async () => {
    const s = await seed();
    await f.owner.query(
      `CREATE UNIQUE INDEX calendar_match_generated_pair ON ${table(PART)}(id,"searchVector")`,
    );
    await f.owner.query(
      `CREATE TABLE ${table('calendar_match_child')}(id uuid PRIMARY KEY,"participantId" uuid,vector tsvector,FOREIGN KEY("participantId",vector) REFERENCES ${table(PART)}(id,"searchVector") ON UPDATE CASCADE)`,
    );
    await f.owner.query(
      `GRANT SELECT ON ${table('calendar_match_child')} TO "${f.roleName}"`,
    );
    await f.owner.query(
      `INSERT INTO ${table('calendar_match_child')}(id,"participantId",vector) SELECT $1,id,"searchVector" FROM ${table(PART)} WHERE id=$2`,
      [randomUUID(), s.participantId],
    );
    const childBefore = await readExact('calendar_match_child');
    // Prove this physical FK would actually cascade; roll back the independent
    // raw-writer probe before exercising the real audited owner.
    const probe = f.owner.createQueryRunner();
    await probe.connect();
    await probe.startTransaction();
    try {
      await probe.query(`UPDATE ${table(PART)} SET "personId"=$1 WHERE id=$2`, [
        s.personId,
        s.participantId,
      ]);
      expect(
        await probe.query(
          `SELECT vector=to_tsvector('simple'::regconfig,$1::text) AS cascaded FROM ${table('calendar_match_child')}`,
          [s.personId],
        ),
      ).toEqual([{ cascaded: true }]);
    } finally {
      await probe.rollbackTransaction();
      await probe.release();
    }
    const before = await graph();
    await rollbackProof(
      match([s.participantId], [s.eventId]),
      before,
      'Native audit excludes referential UPDATE effects',
    );
    expect(await readExact('calendar_match_child')).toEqual(childBefore);
  });
});

type RematchSelector =
  | { kind: 'personOnly'; personEmails: string[] }
  | { kind: 'workspaceMemberOnly'; workspaceMemberIds: string[] };
const rematch = (
  selector: RematchSelector,
  afterParticipantId?: string,
  op = operation(),
) =>
  matcher.rematchCalendarParticipantsWithAudit({
    workspaceId: f.workspaceId,
    operation: op,
    selector,
    afterParticipantId,
  });
const personRematch = () =>
  rematch({ kind: 'personOnly', personEmails: ['CLIENT@example.test'] });

it('calendar member rematch fixes the demonstrated legacy synthetic-null stale-link bug', async () => {
  const s = await seed();
  await f.owner.query(
    `UPDATE ${table(PART)} SET "workspaceMemberId"=$1,"personId"=$2 WHERE id=$3`,
    [s.memberId, s.personId, s.participantId],
  );
  await f.owner.query(
    `UPDATE ${table('workspaceMember')} SET "userEmail"='changed@example.test' WHERE id=$1`,
    [s.memberId],
  );
  await newTarget(s.eventId, s.personId);
  const targetBefore = await readExact(TARGET);
  await matcher.matchParticipantsForWorkspaceMembers({
    workspaceId: f.workspaceId,
    objectMetadataName: 'calendarEventParticipant',
    participantMatching: { workspaceMemberIds: [s.memberId] },
  });
  expect((await rows(PART))[0].workspaceMemberId).toBe(s.memberId);
  expect(await audit()).toEqual([]);
  await rematch({
    kind: 'workspaceMemberOnly',
    workspaceMemberIds: [s.memberId],
  });
  expect((await rows(PART))[0]).toMatchObject({
    workspaceMemberId: null,
    personId: s.personId,
  });
  expect(await readExact(TARGET)).toEqual(targetBefore);
  expect(await audit()).toEqual([
    expect.objectContaining({ resourceId: s.participantId, action: 'update' }),
  ]);
});

it('calendar member rematch keeps equal actual links and does not discover unlinked same-email participants', async () => {
  const s = await seed();
  await f.owner.query(
    `UPDATE ${table(PART)} SET "workspaceMemberId"=$1 WHERE id=$2`,
    [s.memberId, s.participantId],
  );
  const unlinked = await newParticipant(s.eventId);
  const before = await graph();
  expect(
    await rematch({
      kind: 'workspaceMemberOnly',
      workspaceMemberIds: [s.memberId],
    }),
  ).toEqual({ nextCursor: null });
  expect(await graph()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(
    (await rows(PART)).find((row) => row.id === unlinked)?.workspaceMemberId,
  ).toBeNull();
});

it('calendar person rematch preserves the opposite member link and targets all live event participants', async () => {
  const s = await seed(),
    otherPerson = await newPerson('other@example.test');
  const oppositeMember = await insert('workspaceMember', {
    userId: randomUUID(),
    userEmail: 'not-current@example.test',
  });
  await f.owner.query(
    `UPDATE ${table(PART)} SET "workspaceMemberId"=$1 WHERE id=$2`,
    [oppositeMember, s.participantId],
  );
  const untouched = await newParticipant(s.eventId, {
    handle: 'other@example.test',
    personId: otherPerson,
  });
  await personRematch();
  expect(
    (await rows(PART)).find((row) => row.id === s.participantId),
  ).toMatchObject({ personId: s.personId, workspaceMemberId: oppositeMember });
  expect((await rows(PART)).find((row) => row.id === untouched)).toMatchObject({
    personId: otherPerson,
    workspaceMemberId: null,
  });
  expect(await rows(TARGET)).toHaveLength(4);
  expect((await audit()).some((row) => row.resourceId === untouched)).toBe(
    false,
  );
});

it('calendar person rematch selects old and new email handles without selecting by old personId', async () => {
  const s = await seed();
  await f.owner.query(`UPDATE ${table(PART)} SET "personId"=$1 WHERE id=$2`, [
    s.personId,
    s.participantId,
  ]);
  const retained = await newParticipant(s.eventId, {
    handle: 'manual@example.test',
    personId: s.personId,
  });
  await f.owner.query(
    `UPDATE ${table('person')} SET "emailsPrimaryEmail"='new@example.test' WHERE id=$1`,
    [s.personId],
  );
  const newlyMatching = await newParticipant(s.eventId, {
    handle: 'NEW@example.test',
  });
  await rematch({
    kind: 'personOnly',
    personEmails: ['client@example.test', 'new@example.test'],
  });
  const actual = await rows(PART);
  expect(actual.find((row) => row.id === s.participantId)?.personId).toBeNull();
  expect(actual.find((row) => row.id === newlyMatching)?.personId).toBe(
    s.personId,
  );
  expect(actual.find((row) => row.id === retained)?.personId).toBe(s.personId);
});

const seedRematchPage = async (
  count: number,
  memberId: string,
  eventId: string,
) => {
  const ids = Array.from(
    { length: count },
    (_, index) =>
      `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  );
  await f.withContext(() =>
    f.dataSource.transaction(
      async (scope) => {
        await scope.getRepository(PART, permissions).insert(
          ids.map((id) => ({
            id,
            calendarEventId: eventId,
            handle: 'client@example.test',
            workspaceMemberId: memberId,
            personId: null,
          })),
        );
      },
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
  return ids;
};

it('calendar rematch advances a full unchanged 200-row page and reaches the 201st participant', async () => {
  const s = await seed();
  await f.owner.query(`DELETE FROM ${table(PART)}`);
  const ids = await seedRematchPage(201, s.memberId, s.eventId);
  await f.owner.query(
    `UPDATE ${table(PART)} SET handle='unmatched@example.test' WHERE id=$1`,
    [ids[200]],
  );
  const selector: RematchSelector = {
    kind: 'workspaceMemberOnly',
    workspaceMemberIds: [s.memberId],
  };
  const first = await rematch(selector);
  expect(first).toEqual({ nextCursor: ids[199] });
  expect(await audit()).toEqual([]);
  expect(await rematch(selector, first.nextCursor!)).toEqual({
    nextCursor: null,
  });
  expect(
    (await rows(PART)).find((row) => row.id === ids[200])?.workspaceMemberId,
  ).toBeNull();
  expect(await audit()).toEqual([
    expect.objectContaining({ resourceId: ids[200], action: 'update' }),
  ]);
});

it('calendar rematch retains a committed first page when a later page audit fails', async () => {
  const s = await seed();
  await f.owner.query(`DELETE FROM ${table(PART)}`);
  const ids = await seedRematchPage(201, s.memberId, s.eventId);
  await f.owner.query(
    `UPDATE ${table('workspaceMember')} SET "userEmail"='changed@example.test' WHERE id=$1`,
    [s.memberId],
  );
  const selector: RematchSelector = {
    kind: 'workspaceMemberOnly',
    workspaceMemberIds: [s.memberId],
  };
  const first = await rematch(selector);
  expect(first.nextCursor).toBe(ids[199]);
  const before = await graph(),
    auditBefore = await audit();
  expect(auditBefore).toHaveLength(200);
  await auditTrigger("RAISE EXCEPTION 'rematch second page audit refused';");
  f.eventEmitter.mockClear();
  const outcome = await capture(rematch(selector, first.nextCursor!));
  expect(outcome.ok).toBe(false);
  if (!outcome.ok)
    expect(causeMessages(outcome.error).join(' | ')).toContain(
      'rematch second page audit refused',
    );
  expect(await graph()).toEqual(before);
  expect(await audit()).toEqual(auditBefore);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

const afterRematchDiscovery = async (work: () => Promise<void>) => {
  const client = await f.pool.connect(),
    original = client.query.bind(client);
  let observed = false;
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const text = typeof statement === 'string' ? statement : statement.text;
    const result = await original(statement as string, values);
    if (
      !observed &&
      text.includes(table(PART)) &&
      /LIMIT\s+200/i.test(text) &&
      !/FOR UPDATE/i.test(text)
    ) {
      observed = true;
      await work();
    }
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  return () => expect(observed).toBe(true);
};

it.each(['parent', 'selector'] as const)(
  'calendar rematch skips %s drift before parent locks without pruning old-parent targets',
  async (kind) => {
    const s = await seed(),
      otherEvent = await newEvent();
    await newTarget(s.eventId, s.personId);
    const targetBefore = await readExact(TARGET);
    const observed = await afterRematchDiscovery(async () => {
      await f.owner.query(
        kind === 'parent'
          ? `UPDATE ${table(PART)} SET "calendarEventId"=$1 WHERE id=$2`
          : `UPDATE ${table(PART)} SET handle=$1 WHERE id=$2`,
        [
          kind === 'parent' ? otherEvent : 'outside@example.test',
          s.participantId,
        ],
      );
    });
    expect(await personRematch()).toEqual({ nextCursor: null });
    observed();
    expect((await rows(PART))[0].personId).toBeNull();
    expect(await readExact(TARGET)).toEqual(targetBefore);
    expect(await audit()).toEqual([]);
  },
);

it('calendar rematch advances over a full page skipped after discovery', async () => {
  const s = await seed();
  await f.owner.query(`DELETE FROM ${table(PART)}`);
  const ids = await seedRematchPage(201, s.memberId, s.eventId);
  const observed = await afterRematchDiscovery(async () => {
    await f.owner.query(
      `UPDATE ${table(PART)} SET handle='outside@example.test' WHERE id=ANY($1::uuid[])`,
      [ids.slice(0, 200)],
    );
  });
  const first = await personRematch();
  observed();
  expect(first.nextCursor).toBe(ids[199]);
  expect(await audit()).toEqual([]);
  jest.restoreAllMocks();
  await rematch(
    { kind: 'personOnly', personEmails: ['client@example.test'] },
    first.nextCursor!,
  );
  expect((await rows(PART)).find((row) => row.id === ids[200])?.personId).toBe(
    s.personId,
  );
  expect((await audit()).filter((row) => row.action === 'update')).toHaveLength(
    1,
  );
});

it('calendar rematch refuses late selector rewrites after actual matching starts', async () => {
  const s = await seed(),
    before = await graph();
  await nativeTrigger(
    PART,
    'BEFORE',
    'UPDATE',
    "NEW.handle:='changed-by-trigger@example.test'; RETURN NEW;",
  );
  await rollbackProof(
    personRematch(),
    before,
    'Calendar matching graph effects mismatch',
  );
});

it('calendar rematch captures selector and audit identity before opening the transaction', async () => {
  const s = await seed(),
    selector: RematchSelector = {
      kind: 'personOnly',
      personEmails: ['client@example.test'],
    },
    op = operation(),
    actor = { ...op.actor };
  const client = await f.pool.connect(),
    original = client.query.bind(client);
  let changed = false;
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const text = typeof statement === 'string' ? statement : statement.text;
    if (!changed && text === 'BEGIN') {
      changed = true;
      selector.personEmails.splice(0);
      op.actor.id = 'Untrusted';
    }
    return original(statement as string, values);
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await rematch(selector, undefined, op);
  expect(changed).toBe(true);
  expect((await rows(PART))[0].personId).toBe(s.personId);
  for (const entry of await audit()) expect(entry.actor).toEqual(actor);
});

const reconcilePeopleTargets = (personIds: string[], op = operation()) =>
  targets.reconcileTargetsForPeople({
    workspaceId: f.workspaceId,
    personIds,
    operation: op,
  });
const linkTargetSeed = async () => {
  const s = await seed();
  await f.owner.query(
    `UPDATE ${table(PART)} SET "personId"=$1,"workspaceMemberId"=$2 WHERE id=$3`,
    [s.personId, s.memberId, s.participantId],
  );
  return s;
};
const onCalendarTargetQuery = (observe: (sql: string) => Promise<void>) => {
  const originalTransaction = manager.runInWorkspaceTransaction.bind(manager);
  jest.spyOn(manager, 'runInWorkspaceTransaction').mockImplementation((async (
    work: (scope: WorkspaceTransactionScope) => Promise<unknown>,
    options?: WorkspaceTransactionOptions,
  ) => {
    if (
      options?.commitOutcome === 'strict' &&
      options.nativeOwnershipLock === 'exclusive'
    ) {
      const client = await f.pool.connect(),
        original = client.query.bind(client);
      const querySpy = jest.spyOn(client, 'query').mockImplementation((async (
        statement: string | { text: string },
        values?: unknown[],
      ) => {
        const sql = typeof statement === 'string' ? statement : statement.text;
        const result = await original(statement as string, values);
        await observe(sql);
        return result;
      }) as typeof client.query);
      jest
        .spyOn(f.pool, 'connect')
        .mockImplementationOnce(() => Promise.resolve(client));
      try {
        return await originalTransaction(work, options);
      } finally {
        querySpy.mockRestore();
      }
    }
    return originalTransaction(work, options);
  }) as typeof manager.runInWorkspaceTransaction);
};

it('company enrichment creates three calendar target kinds without touching links or invoking the legacy calendar writer', async () => {
  const s = await linkTargetSeed(),
    retained = await Promise.all(
      NAMES.filter((name) => name !== TARGET).map(readExact),
    );
  const legacy = jest.spyOn(targets, 'reconcileParticipantTargets');
  await reconcilePeopleTargets([s.personId]);
  expect(await rows(TARGET)).toHaveLength(3);
  expect(await audit()).toHaveLength(3);
  expect(
    await Promise.all(NAMES.filter((name) => name !== TARGET).map(readExact)),
  ).toEqual(retained);
  expect(
    legacy.mock.calls.every(
      ([input]) => input.objectMetadataName === 'messageParticipant',
    ),
  ).toBe(true);
  const before = await graph(),
    entries = await audit();
  await reconcilePeopleTargets([s.personId]);
  expect(await graph()).toEqual(before);
  expect(await audit()).toEqual(entries);
});

it('company enrichment derives targets from unrequested live people while preserving manual and tombstone policy', async () => {
  const s = await linkTargetSeed(),
    other = await newPerson('other@example.test');
  await newParticipant(s.eventId, {
    personId: other,
    handle: 'unrequested@example.test',
  });
  const tombstone = await newTarget(s.eventId, s.personId, {
    deletedAt: new Date('2029-01-01'),
  });
  const old = await newPerson('old@example.test');
  const manual = await newTarget(s.eventId, old, { isManuallyAssigned: true });
  await f.owner.query(
    `UPDATE ${table('company')} SET "deletedAt"='2029-01-01' WHERE id=$1`,
    [s.companyId],
  );
  await reconcilePeopleTargets([s.personId]);
  const actual = await rows(TARGET);
  expect(actual).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: tombstone }),
      expect.objectContaining({
        id: manual,
        isManuallyAssigned: true,
        isAutomaticallyAssigned: false,
      }),
      expect.objectContaining({ targetPersonId: other }),
      expect.objectContaining({ targetCompanyId: s.companyId }),
      expect.objectContaining({ targetOpportunityId: s.opportunityId }),
    ]),
  );
  expect(
    actual.filter((row) => row.targetPersonId === s.personId),
  ).toHaveLength(1);
});

it.each(['INSERT', 'UPDATE', 'DELETE'])(
  'company enrichment audits no skipped target %s effect',
  async (action) => {
    const s = await linkTargetSeed();
    if (action === 'INSERT') {
      await nativeTrigger(TARGET, 'BEFORE', 'INSERT', 'RETURN NULL;');
    } else {
      await newTarget(s.eventId, s.personId, {
        isAutomaticallyAssigned: action === 'UPDATE' ? false : true,
        isManuallyAssigned: action === 'UPDATE',
      });
      if (action === 'DELETE')
        await f.owner.query(
          `UPDATE ${table('person')} SET "deletedAt"=CURRENT_TIMESTAMP WHERE id=$1`,
          [s.personId],
        );
      else {
        await f.owner.query(
          `UPDATE ${table('person')} SET "companyId"=NULL WHERE id=$1`,
          [s.personId],
        );
        await f.owner.query(`DELETE FROM ${table('opportunity')}`);
      }
      await nativeTrigger(TARGET, 'BEFORE', action, 'RETURN NULL;');
    }
    const before = await graph();
    await reconcilePeopleTargets([s.personId]);
    expect(await graph()).toEqual(before);
    expect(await audit()).toEqual([]);
  },
);

it('company enrichment rolls back target inserts when audit append fails', async () => {
  const s = await linkTargetSeed(),
    before = await graph();
  await auditTrigger("RAISE EXCEPTION 'target enrichment audit refused';");
  await rollbackProof(
    reconcilePeopleTargets([s.personId]),
    before,
    'target enrichment audit refused',
  );
});

it('company enrichment rejects deferred participant changes while retaining all links', async () => {
  const s = await linkTargetSeed(),
    before = await graph();
  await nativeTrigger(
    TARGET,
    'AFTER',
    'INSERT',
    `UPDATE ${table(PART)} SET handle='deferred@example.test' WHERE id='${s.participantId}'; RETURN NEW;`,
    true,
  );
  await rollbackProof(
    reconcilePeopleTargets([s.personId]),
    before,
    'Calendar targets graph effects mismatch',
  );
});

it('company enrichment rejects a new opportunity for an unrequested event participant introduced by its own audit trigger', async () => {
  const s = await linkTargetSeed(),
    other = await newPerson('other@example.test');
  await newParticipant(s.eventId, { personId: other });
  const before = await graph();
  await auditTrigger(
    `INSERT INTO ${table('opportunity')}(id,"pointOfContactId") VALUES(uuid_generate_v4(),'${other}');`,
  );
  await rollbackProof(
    reconcilePeopleTargets([s.personId]),
    before,
    'Calendar targets sources changed',
  );
});

it.each(['person', 'parent'] as const)(
  'company enrichment skips a %s change after discovery even when the replacement person is allowed',
  async (kind) => {
    const s = await linkTargetSeed(),
      other = await newPerson('other@example.test'),
      otherEvent = await newEvent();
    await newTarget(s.eventId, s.personId);
    const retained = await readExact(TARGET);
    let changed = false;
    onCalendarTargetQuery(async (sql) => {
      if (!changed && sql.includes(table(PART)) && /LIMIT\s+200/i.test(sql)) {
        changed = true;
        await f.owner.query(
          kind === 'person'
            ? `UPDATE ${table(PART)} SET "personId"=$1 WHERE id=$2`
            : `UPDATE ${table(PART)} SET "calendarEventId"=$1 WHERE id=$2`,
          [kind === 'person' ? other : otherEvent, s.participantId],
        );
      }
    });
    await reconcilePeopleTargets([s.personId, other]);
    expect(changed).toBe(true);
    expect(await readExact(TARGET)).toEqual(retained);
    expect(await audit()).toEqual([]);
  },
);

it('company enrichment advances past 200 skipped hints and reconciles the final event', async () => {
  const s = await linkTargetSeed();
  await f.owner.query(`DELETE FROM ${table(PART)}`);
  const lastEvent = await newEvent();
  const ids = await seedRematchPage(201, s.memberId, s.eventId);
  await f.owner.query(`UPDATE ${table(PART)} SET "personId"=$1`, [s.personId]);
  await f.owner.query(
    `UPDATE ${table(PART)} SET "calendarEventId"=$1 WHERE id=$2`,
    [lastEvent, ids[200]],
  );
  let changed = false;
  onCalendarTargetQuery(async (sql) => {
    if (!changed && sql.includes(table(PART)) && /LIMIT\s+200/i.test(sql)) {
      changed = true;
      await f.owner.query(
        `UPDATE ${table(PART)} SET "personId"=NULL WHERE id=ANY($1::uuid[])`,
        [ids.slice(0, 200)],
      );
    }
  });
  await reconcilePeopleTargets([s.personId]);
  expect(changed).toBe(true);
  expect(await rows(TARGET)).toHaveLength(3);
  expect(
    (await rows(TARGET)).every((row) => row.calendarEventId === lastEvent),
  ).toBe(true);
});

it('company enrichment retains earlier page commits after the next page fails', async () => {
  const s = await linkTargetSeed();
  await f.owner.query(`DELETE FROM ${table(PART)}`);
  const lastEvent = await newEvent();
  const ids = await seedRematchPage(201, s.memberId, s.eventId);
  await f.owner.query(`UPDATE ${table(PART)} SET "personId"=$1`, [s.personId]);
  await f.owner.query(
    `UPDATE ${table(PART)} SET "calendarEventId"=$1 WHERE id=$2`,
    [lastEvent, ids[200]],
  );
  await nativeTrigger(
    TARGET,
    'BEFORE',
    'INSERT',
    `IF NEW."calendarEventId"='${lastEvent}' THEN RAISE EXCEPTION 'later target page refused'; END IF; RETURN NEW;`,
  );
  const outcome = await capture(reconcilePeopleTargets([s.personId]));
  expect(outcome.ok).toBe(false);
  if (!outcome.ok)
    expect(causeMessages(outcome.error).join(' | ')).toContain(
      'later target page refused',
    );
  expect(await rows(TARGET)).toHaveLength(3);
  expect(
    (await rows(TARGET)).every((row) => row.calendarEventId === s.eventId),
  ).toBe(true);
  expect(await audit()).toHaveLength(3);
});

it('company enrichment preserves real committed calendar targets on lost COMMIT acknowledgement', async () => {
  const s = await linkTargetSeed();
  let commitSeen = false;
  onCalendarTargetQuery(async (sql) => {
    if (sql === 'COMMIT') {
      commitSeen = true;
      throw new Error('calendar targets ACK lost');
    }
  });
  await expect(reconcilePeopleTargets([s.personId])).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(commitSeen).toBe(true);
  expect(await rows(TARGET)).toHaveLength(3);
  expect(await audit()).toHaveLength(3);
});

it('company enrichment holds three source SHARE locks before participant discovery', async () => {
  const s = await linkTargetSeed();
  const queries: string[] = [];
  onCalendarTargetQuery(async (sql) => {
    queries.push(sql);
  });
  await reconcilePeopleTargets([s.personId]);
  const source = queries.findIndex(
    (sql) => sql.includes('LOCK TABLE') && sql.includes('IN SHARE MODE'),
  );
  const discovery = queries.findIndex(
    (sql) => sql.includes(table(PART)) && /LIMIT\s+200/i.test(sql),
  );
  expect(source).toBeGreaterThanOrEqual(0);
  expect(discovery).toBeGreaterThan(source);
  for (const name of ['person', 'company', 'opportunity'])
    expect(queries[source]).toContain(table(name));
});

it('company enrichment fences a concurrent new opportunity until the audited calendar page commits', async () => {
  const s = await linkTargetSeed(),
    reached = barrier(),
    resume = barrier();
  let held = false;
  onCalendarTargetQuery(async (sql) => {
    if (!held && sql.includes('LOCK TABLE') && sql.includes('IN SHARE MODE')) {
      held = true;
      reached.release();
      await resume.promise;
    }
  });
  const writer = f.owner.createQueryRunner();
  await writer.connect();
  const [{ pid: writerPid }] = await writer.query(
    'SELECT pg_backend_pid() AS pid',
  );
  const work = capture(reconcilePeopleTargets([s.personId]));
  let mutation: ReturnType<typeof capture> | undefined;
  try {
    await Promise.race([
      reached.promise,
      work.then(() => {
        throw new Error('Target page settled before source SHARE');
      }),
    ]);
    const [{ pid: nativePid }] = await f.owner.query(
      "SELECT pid FROM pg_locks WHERE relation=$1::regclass AND mode='ShareLock' AND granted",
      [table('opportunity')],
    );
    mutation = capture(
      writer.query(
        `INSERT INTO ${table('opportunity')}(id,"pointOfContactId") VALUES($1,$2)`,
        [randomUUID(), s.personId],
      ),
    );
    await waitForBlocker(writerPid, nativePid);
    resume.release();
    const outcome = await work;
    if (!outcome.ok) throw outcome.error;
    const inserted = await mutation;
    if (!inserted.ok) throw inserted.error;
    expect(await rows(TARGET)).toHaveLength(3);
    await reconcilePeopleTargets([s.personId]);
    expect(await rows(TARGET)).toHaveLength(4);
  } finally {
    resume.release();
    await work;
    await mutation;
    await closeWriter(writer);
  }
});

it('company enrichment refuses an incoming target cascade instead of deleting an unaudited child', async () => {
  const s = await linkTargetSeed(),
    targetId = await newTarget(s.eventId, s.personId);
  await f.owner.query(
    `UPDATE ${table('person')} SET "deletedAt"=CURRENT_TIMESTAMP WHERE id=$1`,
    [s.personId],
  );
  await f.owner.query(
    `CREATE TABLE ${table('calendar_match_child')}(id uuid PRIMARY KEY,"targetId" uuid REFERENCES ${table(TARGET)}(id) ON DELETE CASCADE)`,
  );
  await f.owner.query(
    `GRANT SELECT ON ${table('calendar_match_child')} TO "${f.roleName}"`,
  );
  await f.owner.query(
    `INSERT INTO ${table('calendar_match_child')}(id,"targetId") VALUES($1,$2)`,
    [randomUUID(), targetId],
  );
  const before = await graph(),
    child = await readExact('calendar_match_child');
  await rollbackProof(
    reconcilePeopleTargets([s.personId]),
    before,
    'Calendar targets excludes unsupported target cascade effects',
  );
  expect(await readExact('calendar_match_child')).toEqual(child);
});

it.each([
  [
    'actor',
    { actor: { kind: 'unknown', id: 'bad' } },
    'Audit principal kind is invalid',
  ],
  [
    'initiator',
    { initiator: { kind: 'coreUser', id: 'not-uuid' } },
    'Audit UUID is invalid',
  ],
  [
    'correlation',
    { correlationId: 'x'.repeat(257) },
    'Audit identifier is invalid',
  ],
  [
    'causation',
    { causationId: 'x'.repeat(257) },
    'Audit identifier is invalid',
  ],
  [
    'workspace',
    { workspaceId: randomUUID() },
    'Calendar targets require scoped person selection',
  ],
] as const)(
  'company enrichment refuses malformed %s before entering legacy messaging',
  async (_label, patch, cause) => {
    const s = await linkTargetSeed(),
      before = await graph();
    const transaction = jest.spyOn(manager, 'runInWorkspaceTransaction');
    await rollbackProof(
      reconcilePeopleTargets([s.personId], {
        ...operation(),
        ...patch,
      } as CrmAuditOperation),
      before,
      cause,
    );
    expect(transaction).not.toHaveBeenCalled();
  },
);

it('company enrichment captures person hints and full identity before the legacy messaging await', async () => {
  const s = await linkTargetSeed(),
    ids = [s.personId],
    op = operation(),
    actor = { ...op.actor };
  const context = manager.executeInWorkspaceContext.bind(manager);
  let changed = false;
  jest.spyOn(manager, 'executeInWorkspaceContext').mockImplementation((async (
    ...args: Parameters<WorkspaceOrmManager['executeInWorkspaceContext']>
  ) => {
    if (!changed) {
      changed = true;
      ids.splice(0);
      op.actor.id = 'Untrusted';
    }
    return context(...args);
  }) as typeof manager.executeInWorkspaceContext);
  await reconcilePeopleTargets(ids, op);
  expect(await audit()).toHaveLength(3);
  for (const row of await audit()) expect(row.actor).toEqual(actor);
});

const withGeneratedTargetSearch = async (work: () => Promise<void>) => {
  const [original] = await f.owner.query(
    `SELECT format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS required, a.attgenerated AS generated, pg_get_expr(d.adbin,d.adrelid) AS expression FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::regclass AND a.attname='searchVector' AND NOT a.attisdropped`,
    [table(TARGET)],
  );
  expect(original).toBeDefined();
  await f.owner.query(
    `ALTER TABLE ${table(TARGET)} DROP COLUMN "searchVector"`,
  );
  try {
    await f.owner.query(
      `ALTER TABLE ${table(TARGET)} ADD COLUMN "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig,CASE WHEN "isAutomaticallyAssigned" THEN 'automatic' ELSE 'manual' END)) STORED`,
    );
    await work();
  } finally {
    await f.owner.query(
      `DROP TABLE IF EXISTS ${table('calendar_match_child')}`,
    );
    await f.owner.query(
      `DROP INDEX IF EXISTS "${f.schemaName}".calendar_target_generated_pair`,
    );
    await f.owner.query(
      `ALTER TABLE ${table(TARGET)} DROP COLUMN IF EXISTS "searchVector"`,
    );
    await f.owner.query(
      `ALTER TABLE ${table(TARGET)} ADD COLUMN "searchVector" ${original.type}${original.generated ? ` GENERATED ALWAYS AS (${original.expression}) STORED` : original.expression ? ` DEFAULT ${original.expression}` : ''}${original.required ? ' NOT NULL' : ''}`,
    );
  }
};

const seedGeneratedTarget = async () => {
  const s = await linkTargetSeed();
  await f.owner.query(
    `UPDATE ${table('person')} SET "companyId"=NULL WHERE id=$1`,
    [s.personId],
  );
  await f.owner.query(`DELETE FROM ${table('opportunity')}`);
  const targetId = await newTarget(s.eventId, s.personId, {
    isAutomaticallyAssigned: false,
    isManuallyAssigned: true,
  });
  f.eventEmitter.mockClear();
  return { ...s, targetId };
};

it('company enrichment recomputes a real generated Target searchVector when the automatic flag changes', async () => {
  await withGeneratedTargetSearch(async () => {
    const s = await seedGeneratedTarget();
    const [before] = await f.owner.query(
      `SELECT "searchVector"::text AS vector FROM ${table(TARGET)} WHERE id=$1`,
      [s.targetId],
    );
    const retained = await Promise.all(
      NAMES.filter((name) => name !== TARGET).map(readExact),
    );
    await reconcilePeopleTargets([s.personId]);
    const [after] = await f.owner.query(
      `SELECT id,"isAutomaticallyAssigned","isManuallyAssigned","searchVector"::text AS vector,"searchVector"=to_tsvector('simple'::regconfig,'automatic') AS correct FROM ${table(TARGET)} WHERE id=$1`,
      [s.targetId],
    );
    expect(after).toMatchObject({
      id: s.targetId,
      isAutomaticallyAssigned: true,
      isManuallyAssigned: true,
      correct: true,
    });
    expect(after.vector).not.toBe(before.vector);
    expect(await rows(TARGET)).toHaveLength(1);
    expect(await audit()).toEqual([
      expect.objectContaining({ resourceId: s.targetId, action: 'update' }),
    ]);
    expect(
      await Promise.all(NAMES.filter((name) => name !== TARGET).map(readExact)),
    ).toEqual(retained);
  });
});

it('company enrichment refuses a generated Target ON UPDATE cascade before changing an unaudited child', async () => {
  await withGeneratedTargetSearch(async () => {
    const s = await seedGeneratedTarget();
    await f.owner.query(
      `CREATE UNIQUE INDEX calendar_target_generated_pair ON ${table(TARGET)}(id,"searchVector")`,
    );
    await f.owner.query(
      `CREATE TABLE ${table('calendar_match_child')}(id uuid PRIMARY KEY,"targetId" uuid,vector tsvector,FOREIGN KEY("targetId",vector) REFERENCES ${table(TARGET)}(id,"searchVector") ON UPDATE CASCADE)`,
    );
    await f.owner.query(
      `GRANT SELECT ON ${table('calendar_match_child')} TO "${f.roleName}"`,
    );
    await f.owner.query(
      `INSERT INTO ${table('calendar_match_child')}(id,"targetId",vector) SELECT $1,id,"searchVector" FROM ${table(TARGET)} WHERE id=$2`,
      [randomUUID(), s.targetId],
    );
    const childBefore = await readExact('calendar_match_child');
    const probe = f.owner.createQueryRunner();
    await probe.connect();
    await probe.startTransaction();
    try {
      await probe.query(
        `UPDATE ${table(TARGET)} SET "isAutomaticallyAssigned"=true WHERE id=$1`,
        [s.targetId],
      );
      expect(
        await probe.query(
          `SELECT vector=to_tsvector('simple'::regconfig,'automatic') AS cascaded FROM ${table('calendar_match_child')}`,
        ),
      ).toEqual([{ cascaded: true }]);
    } finally {
      await probe.rollbackTransaction();
      await probe.release();
    }
    const before = await graph();
    await rollbackProof(
      reconcilePeopleTargets([s.personId]),
      before,
      'Native audit excludes referential UPDATE effects',
    );
    expect(await readExact('calendar_match_child')).toEqual(childBefore);
  });
});
