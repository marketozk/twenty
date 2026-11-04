import { randomUUID } from 'node:crypto';
import { MatchParticipantService } from 'src/modules/match-participant/match-participant.service';
import { ParticipantTargetReconciliationService } from 'src/modules/match-participant/participant-target-reconciliation.service';
import { type MessageParticipantWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-participant.workspace-entity';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { createOmniNativeCleanupFixture } from 'test/fork-migration/omni-native-cleanup.fixture';

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

const f = createOmniNativeCleanupFixture();
const targets = new ParticipantTargetReconciliationService(f.manager, f.owner);
const matcher = new MatchParticipantService<MessageParticipantWorkspaceEntity>(
  f.manager,
  targets,
  {} as never,
  f.owner,
);
const PARTICIPANT = 'messageParticipant',
  TARGET = 'messageThreadTarget';
const table = (name: string) => `"${f.schemaName}"."${name}"`;
const operation = () => ({
  workspaceId: f.workspaceId,
  operationId: randomUUID(),
  correlationId: randomUUID(),
  actor: { kind: 'system' as const, id: 'MessageRematchTest' },
});
const people = async (personEmails: string[], afterParticipantId?: string) =>
  matcher.rematchMessageParticipantsWithAudit({
    workspaceId: f.workspaceId,
    operation: operation(),
    selector: { kind: 'personOnly', personEmails },
    afterParticipantId,
  });
const members = async (
  workspaceMemberIds: string[],
  afterParticipantId?: string,
) =>
  matcher.rematchMessageParticipantsWithAudit({
    workspaceId: f.workspaceId,
    operation: operation(),
    selector: { kind: 'workspaceMemberOnly', workspaceMemberIds },
    afterParticipantId,
  });
const rows = (name: string) =>
  f.owner.query(
    `SELECT to_jsonb(row)::text AS row FROM ${table(name)} row ORDER BY id`,
  );
const audit = () =>
  f.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "resourceId"',
  );
const graph = () =>
  Promise.all(
    [
      'messageThread',
      'message',
      PARTICIPANT,
      TARGET,
      'person',
      'workspaceMember',
      'company',
      'opportunity',
      'messageChannelMessageAssociation',
    ].map(rows),
  );
const insert = async (name: string, fields: Record<string, unknown>) => {
  const id = randomUUID();
  await f.seedNative((scope) =>
    scope.getRepository(name, { shouldBypassPermissionChecks: true }).insert({
      id,
      ...(name === 'workspaceMember' ? { userId: randomUUID() } : {}),
      ...fields,
    }),
  );
  f.eventEmitter.mockClear();
  return id;
};
const participant = async (id: string) =>
  (
    await f.owner.query(`SELECT * FROM ${table(PARTICIPANT)} WHERE id=$1`, [id])
  )[0];
const seed = async (marker: 'binding' | 'link' | 'conversation' = 'link') => {
  const s = await f.seed(marker);
  const oldMemberId = await insert('workspaceMember', {
    userEmail: 'old@example.test',
    name: { firstName: 'Old' },
  });
  await f.owner.query(
    `UPDATE ${table(PARTICIPANT)} SET "workspaceMemberId"=$1`,
    [oldMemberId],
  );
  const newPersonId = await insert('person', {
    name: { firstName: 'Matched' },
    emails: { primaryEmail: 'client@example.test', additionalEmails: [] },
  });
  return { ...s, oldMemberId, newPersonId };
};
const capture = <T>(work: Promise<T>) =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
const causes = (error: unknown) => {
  const messages: string[] = [],
    seen = new Set<object>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const current = error as { message?: unknown; cause?: unknown };
    if (typeof current.message === 'string') messages.push(current.message);
    error = current.cause;
  }
  return messages.join(' | ');
};
const rollback = async (
  work: Promise<unknown>,
  before: unknown,
  cause: string,
) => {
  const result = await capture(work);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(causes(result.error)).toContain(cause);
  expect(await graph()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
};
const trigger = async (
  body: string,
  source: 'audit' | 'participant' = 'audit',
  deferred = false,
) => {
  const relation =
    source === 'audit' ? 'crm_audit."crmAuditEntry"' : table(PARTICIPANT);
  await f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".rematch_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN ${body} RETURN NEW; END $$; CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER rematch_test AFTER ${source === 'audit' ? 'INSERT' : 'UPDATE'} ON ${relation} ${deferred ? 'DEFERRABLE INITIALLY DEFERRED ' : ''}FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".rematch_test()`,
  );
};
const intercept = async (observe: (sql: string) => Promise<void>) => {
  const client = await f.pool.connect(),
    original = client.query.bind(client);
  const spy = jest.spyOn(client, 'query').mockImplementation((async (
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
  return () => spy.mockRestore();
};
const discovery = (sql: string) =>
  sql.includes(table(PARTICIPANT)) &&
  /LIMIT\s+200/i.test(sql) &&
  !/FOR UPDATE/i.test(sql);

beforeAll(async () => {
  await f.initialize();
  await f.owner.query(
    `GRANT UPDATE ON core."messageChannel" TO "${f.roleName}"`,
  );
});
beforeEach(async () => {
  await f.owner.query(
    'DROP TRIGGER IF EXISTS rematch_test ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query(
    `DROP TRIGGER IF EXISTS rematch_test ON ${table(PARTICIPANT)}`,
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".rematch_test()`,
  );
  await f.reset();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it('member rematch clears a stale actual link and preserves person and every target', async () => {
  const s = await seed(),
    beforeTargets = await rows(TARGET);
  await members([s.oldMemberId]);
  expect(await participant(s.email.participantId)).toMatchObject({
    workspaceMemberId: null,
    personId: s.personId,
  });
  expect(await participant(s.omni.participantId)).toMatchObject({
    workspaceMemberId: s.oldMemberId,
  });
  expect(await rows(TARGET)).toEqual(beforeTargets);
  expect(await audit()).toHaveLength(1);
});

it('member rematch leaves an actual equal match unchanged and does not audit a no-op', async () => {
  const s = await seed();
  await f.owner.query(
    `UPDATE ${table('workspaceMember')} SET "userEmail"='client@example.test' WHERE id=$1`,
    [s.oldMemberId],
  );
  const before = await graph();
  await members([s.oldMemberId]);
  expect(await graph()).toEqual(before);
  expect(await audit()).toEqual([]);
});

it.each(['exact', 'case', 'deleted'] as const)(
  'member replacement preserves exact-case/live selection (%s)',
  async (kind) => {
    const s = await seed();
    const memberId = await insert('workspaceMember', {
      name: { firstName: 'New' },
      userEmail:
        kind === 'case' ? 'Client@example.test' : 'client@example.test',
      ...(kind === 'deleted' ? { deletedAt: new Date() } : {}),
    });
    await members([s.oldMemberId]);
    expect(await participant(s.email.participantId)).toMatchObject({
      workspaceMemberId: kind === 'exact' ? memberId : null,
      personId: s.personId,
    });
  },
);

it('person primary match wins over older additional match and preserves member linkage', async () => {
  const s = await seed();
  await insert('person', {
    name: { firstName: 'Older' },
    emails: {
      primaryEmail: 'different@example.test',
      additionalEmails: ['client@example.test'],
    },
    createdAt: new Date('2020-01-01'),
  });
  await people(['CLIENT@example.test']);
  expect(await participant(s.email.participantId)).toMatchObject({
    personId: s.newPersonId,
    workspaceMemberId: s.oldMemberId,
  });
  const targetRows = await f.owner.query(
    `SELECT * FROM ${table(TARGET)} WHERE "messageThreadId"=$1`,
    [s.email.threadId],
  );
  expect(targetRows).toEqual([
    expect.objectContaining({ targetPersonId: s.newPersonId }),
  ]);
});

it('person duplicate primary matches use createdAt precedence', async () => {
  const s = await seed();
  const older = await insert('person', {
    name: { firstName: 'Older' },
    emails: { primaryEmail: 'CLIENT@example.test', additionalEmails: [] },
    createdAt: new Date('2020-01-01'),
  });
  await people(['client@example.test']);
  expect(await participant(s.email.participantId)).toMatchObject({
    personId: older,
  });
});

it.each(['client@example.test', 'CLIENT@example.test'])(
  'additional email SQL candidate containment retains existing behavior for %s',
  async (email) => {
    const s = await seed();
    await f.owner.query(
      `UPDATE ${table('person')} SET "emailsPrimaryEmail"='different@example.test',"emailsAdditionalEmails"=$1 WHERE id=$2`,
      [JSON.stringify([email]), s.newPersonId],
    );
    await people(['client@example.test']);
    expect(await participant(s.email.participantId)).toMatchObject({
      personId: email === 'client@example.test' ? s.newPersonId : null,
    });
  },
);

it('deleted Person can match while automatic targets use live people only', async () => {
  const s = await seed();
  await f.owner.query(
    `UPDATE ${table('person')} SET "deletedAt"=CURRENT_TIMESTAMP WHERE id=$1`,
    [s.newPersonId],
  );
  await people(['client@example.test']);
  expect(await participant(s.email.participantId)).toMatchObject({
    personId: s.newPersonId,
  });
  expect(
    await f.owner.query(
      `SELECT * FROM ${table(TARGET)} WHERE "messageThreadId"=$1`,
      [s.email.threadId],
    ),
  ).toEqual([]);
});

it('ordinary APP skips person rematch but remains eligible for member rematch', async () => {
  const s = await seed();
  await f.owner.query(
    'UPDATE core."messageChannel" SET type=\'APP\' WHERE id=$1',
    [s.channelId],
  );
  const before = await graph();
  await people(['client@example.test']);
  expect(await graph()).toEqual(before);
  expect(await audit()).toEqual([]);
  await members([s.oldMemberId]);
  expect(await participant(s.email.participantId)).toMatchObject({
    workspaceMemberId: null,
    personId: s.personId,
  });
});

it.each(['binding', 'link', 'conversation'] as const)(
  'rematch preserves actual %s-owned rows in both modes',
  async (marker) => {
    const s = await seed(marker),
      original = await participant(s.omni.participantId);
    await people(['client@example.test']);
    await members([s.oldMemberId]);
    expect(await participant(s.omni.participantId)).toEqual(original);
    expect(await participant(s.email.participantId)).toMatchObject({
      personId: s.newPersonId,
      workspaceMemberId: null,
    });
  },
);

it('all-skipped full member page still advances to the next discovered candidate', async () => {
  const s = await seed();
  await f.owner.query(
    `UPDATE ${table(PARTICIPANT)} SET "workspaceMemberId"=NULL`,
  );
  const ids = Array.from(
    { length: 201 },
    (_, index) =>
      `60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  );
  await f.seedNative((scope) =>
    scope
      .getRepository(PARTICIPANT, { shouldBypassPermissionChecks: true })
      .insert(
        ids.map((id) => ({
          id,
          messageId: s.email.messageId,
          workspaceMemberId: s.oldMemberId,
          personId: s.personId,
          role: 'TO',
          handle: 'client@example.test',
        })),
      ),
  );
  let changed = false;
  const restore = await intercept(async (sql) => {
    if (!changed && discovery(sql)) {
      changed = true;
      await f.owner.query(
        `UPDATE ${table(PARTICIPANT)} SET "workspaceMemberId"=NULL WHERE id=ANY($1::uuid[])`,
        [ids.slice(0, 200)],
      );
    }
  });
  let cursor: string | null;
  try {
    cursor = (await members([s.oldMemberId])).nextCursor;
  } finally {
    restore();
  }
  expect(changed).toBe(true);
  expect(cursor!).toBe(ids[199]);
  expect(await audit()).toEqual([]);
  expect(await members([s.oldMemberId], cursor!)).toEqual({ nextCursor: null });
  expect(await audit()).toHaveLength(1);
});

it.each(['source', 'target'] as const)(
  'participant %s trigger cannot become a fresh target-stage baseline',
  async (kind) => {
    const s = await seed(),
      before = await graph();
    await trigger(
      kind === 'source'
        ? `INSERT INTO ${table('opportunity')}(id,"pointOfContactId") VALUES(uuid_generate_v4(),'${s.newPersonId}');`
        : `UPDATE ${table(TARGET)} SET "isManuallyAssigned"=true WHERE id='${s.email.targetId}';`,
      'participant',
    );
    await rollback(
      people(['client@example.test']),
      before,
      'Native message rematch proof changed',
    );
  },
);

it.each([false, true])(
  'member target immutability is checked after audit and deferred effects (%s)',
  async (deferred) => {
    const s = await seed(),
      before = await graph();
    await trigger(
      `UPDATE ${table(TARGET)} SET "isManuallyAssigned"=true WHERE id='${s.email.targetId}';`,
      'audit',
      deferred,
    );
    await rollback(
      members([s.oldMemberId]),
      before,
      'Native message rematch proof changed',
    );
  },
);

it('audit failure rolls back participant and target effects together', async () => {
  const s = await seed(),
    before = await graph();
  await trigger("RAISE EXCEPTION 'rematch audit refused';");
  await rollback(
    people(['client@example.test']),
    before,
    'rematch audit refused',
  );
  expect(await participant(s.email.participantId)).toMatchObject({
    personId: s.personId,
  });
});

it('late APP channel policy mutation rolls back matching and target changes', async () => {
  const s = await seed(),
    before = await graph();
  await trigger(
    `UPDATE core."messageChannel" SET type='APP' WHERE id='${s.channelId}';`,
    'audit',
    true,
  );
  await rollback(
    people(['client@example.test']),
    before,
    'Native message rematch channel policy changed',
  );
  expect(
    (
      await f.owner.query(
        'SELECT type FROM core."messageChannel" WHERE id=$1',
        [s.channelId],
      )
    )[0].type,
  ).toBe('EMAIL');
});

it('retains committed rematch and audit after real COMMIT acknowledgement loss', async () => {
  const s = await seed();
  let committed = false;
  const restore = await intercept(async (sql) => {
    if (sql === 'COMMIT') {
      committed = true;
      throw new Error('rematch ACK lost');
    }
  });
  try {
    await expect(members([s.oldMemberId])).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
  } finally {
    restore();
  }
  expect(committed).toBe(true);
  expect(await participant(s.email.participantId)).toMatchObject({
    workspaceMemberId: null,
  });
  expect(await audit()).toHaveLength(1);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('skipped participant updates retain old links and emit no false mutation audit', async () => {
  const s = await seed(),
    before = await graph();
  await f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".rematch_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER rematch_test BEFORE UPDATE ON ${table(PARTICIPANT)} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".rematch_test()`,
  );
  await members([s.oldMemberId]);
  expect(await graph()).toEqual(before);
  expect(await audit()).toEqual([]);
});

it('skipped original Message remains in proof after moving outside admitted roots', async () => {
  const s = await seed();
  const outsideThread = await insert('messageThread', { subject: 'Outside' });
  const admittedThread = await insert('messageThread', { subject: 'Admitted' });
  const admittedMessage = await insert('message', {
    messageThreadId: admittedThread,
    headerMessageId: randomUUID(),
  });
  await insert(PARTICIPANT, {
    messageId: admittedMessage,
    workspaceMemberId: s.oldMemberId,
    personId: s.personId,
    handle: 'client@example.test',
    role: 'TO',
  });
  let moved = false,
    before: unknown;
  const restore = await intercept(async (sql) => {
    if (!moved && discovery(sql)) {
      moved = true;
      await f.owner.query(
        `UPDATE ${table('message')} SET "messageThreadId"=$1 WHERE id=$2`,
        [outsideThread, s.email.messageId],
      );
      before = await graph();
    }
  });
  await trigger(
    `UPDATE ${table('message')} SET "headerMessageId"='deferred-original' WHERE id='${s.email.messageId}';`,
    'audit',
    true,
  );
  try {
    const result = await capture(members([s.oldMemberId]));
    expect(moved).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(causes(result.error)).toContain(
        'Native message rematch proof changed',
      );
    expect(await graph()).toEqual(before);
    expect(await audit()).toEqual([]);
  } finally {
    restore();
  }
});

it.each(['member', 'channel'] as const)(
  'raw %s writer is fenced until rematch commit',
  async (kind) => {
    const s = await seed();
    let release!: () => void, entered!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const relation =
      kind === 'member' ? table('workspaceMember') : 'core."messageChannel"';
    let held = false;
    const restore = await intercept(async (sql) => {
      if (
        !held &&
        sql.includes('LOCK TABLE') &&
        sql.includes(relation) &&
        sql.includes('IN SHARE MODE')
      ) {
        held = true;
        entered();
        await resume;
      }
    });
    const writer = f.owner.createQueryRunner();
    await writer.connect();
    const [{ pid: writerPid }] = await writer.query(
      'SELECT pg_backend_pid() AS pid',
    );
    const work = capture(
      kind === 'member'
        ? members([s.oldMemberId])
        : people(['client@example.test']),
    );
    let mutation: ReturnType<typeof capture> | undefined;
    try {
      await Promise.race([
        reached,
        work.then(() => {
          throw new Error('Rematch settled before source lock');
        }),
      ]);
      const [{ pid: nativePid }] = await f.owner.query(
        "SELECT pid FROM pg_locks WHERE relation=$1::regclass AND mode='ShareLock' AND granted",
        [relation],
      );
      mutation = capture(
        kind === 'member'
          ? writer.query(
              `INSERT INTO ${table('workspaceMember')}(id,"userId","userEmail") VALUES($1,$2,'client@example.test')`,
              [randomUUID(), randomUUID()],
            )
          : writer.query(
              'UPDATE core."messageChannel" SET type=\'APP\' WHERE id=$1',
              [s.channelId],
            ),
      );
      let blocked = false;
      for (let index = 0; index < 150; index++) {
        const [row] = await f.owner.query(
          'SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',
          [writerPid, nativePid],
        );
        if (row.blocked) {
          blocked = true;
          break;
        }
        await f.owner.query('SELECT pg_sleep(0.01)');
      }
      expect(blocked).toBe(true);
      release();
      const result = await work;
      if (!result.ok) throw result.error;
      const changed = await mutation;
      if (!changed.ok) throw changed.error;
      expect(await participant(s.email.participantId)).toMatchObject(
        kind === 'member'
          ? { workspaceMemberId: null }
          : { personId: s.newPersonId },
      );
      expect((await audit()).length).toBeGreaterThan(0);
    } finally {
      release();
      await work;
      await mutation;
      restore();
      await writer.release();
    }
  },
);

const withGeneratedParticipant = async (work: () => Promise<void>) => {
  const [original] = await f.owner.query(
    `SELECT format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required,a.attgenerated AS generated,pg_get_expr(d.adbin,d.adrelid) AS expression FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::regclass AND a.attname='searchVector' AND NOT a.attisdropped`,
    [table(PARTICIPANT)],
  );
  expect(original).toBeDefined();
  await f.owner.query(
    `ALTER TABLE ${table(PARTICIPANT)} DROP COLUMN "searchVector"`,
  );
  try {
    await f.owner.query(
      `ALTER TABLE ${table(PARTICIPANT)} ADD COLUMN "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig,COALESCE("personId"::text,''))) STORED`,
    );
    await work();
  } finally {
    await f.owner.query(`DROP TABLE IF EXISTS ${table('rematch_child')}`);
    await f.owner.query(
      `DROP INDEX IF EXISTS "${f.schemaName}".rematch_generated_pair`,
    );
    await f.owner.query(
      `ALTER TABLE ${table(PARTICIPANT)} DROP COLUMN IF EXISTS "searchVector"`,
    );
    await f.owner.query(
      `ALTER TABLE ${table(PARTICIPANT)} ADD COLUMN "searchVector" ${original.type}${original.generated ? ` GENERATED ALWAYS AS (${original.expression}) STORED` : original.expression ? ` DEFAULT ${original.expression}` : ''}${original.required ? ' NOT NULL' : ''}`,
    );
  }
};

it('matching validates generated Participant postimages against the actual selected Person', async () => {
  await withGeneratedParticipant(async () => {
    const s = await seed(),
      before = await participant(s.email.participantId);
    await people(['client@example.test']);
    const [row] = await f.owner.query(
      `SELECT "personId","searchVector"::text AS vector,"searchVector"=to_tsvector('simple'::regconfig,COALESCE("personId"::text,'')) AS correct FROM ${table(PARTICIPANT)} WHERE id=$1`,
      [s.email.participantId],
    );
    expect(row.personId).toBe(s.newPersonId);
    expect(row.correct).toBe(true);
    expect(row.vector).not.toBe(before.searchVector);
    expect(
      (await audit()).filter(
        (entry: { resourceId: string }) =>
          entry.resourceId === s.email.participantId,
      ),
    ).toHaveLength(1);
  });
});

it('generated incoming UPDATE cascade is proved physically then refused by the audited rematch', async () => {
  await withGeneratedParticipant(async () => {
    const s = await seed();
    await f.owner.query(
      `CREATE UNIQUE INDEX rematch_generated_pair ON ${table(PARTICIPANT)}(id,"searchVector")`,
    );
    await f.owner.query(
      `CREATE TABLE ${table('rematch_child')}(id uuid PRIMARY KEY,"participantId" uuid,vector tsvector,FOREIGN KEY("participantId",vector) REFERENCES ${table(PARTICIPANT)}(id,"searchVector") ON UPDATE CASCADE)`,
    );
    await f.owner.query(
      `GRANT SELECT ON ${table('rematch_child')} TO "${f.roleName}"`,
    );
    await f.owner.query(
      `INSERT INTO ${table('rematch_child')}(id,"participantId",vector) SELECT $1,id,"searchVector" FROM ${table(PARTICIPANT)} WHERE id=$2`,
      [randomUUID(), s.email.participantId],
    );
    const childBefore = await rows('rematch_child');
    const probe = f.owner.createQueryRunner();
    await probe.connect();
    await probe.startTransaction();
    try {
      await probe.query(
        `UPDATE ${table(PARTICIPANT)} SET "personId"=$1 WHERE id=$2`,
        [s.newPersonId, s.email.participantId],
      );
      expect(
        await probe.query(
          `SELECT vector=to_tsvector('simple'::regconfig,$1::text) AS cascaded FROM ${table('rematch_child')}`,
          [s.newPersonId],
        ),
      ).toEqual([{ cascaded: true }]);
    } finally {
      await probe.rollbackTransaction();
      await probe.release();
    }
    const before = await graph();
    await rollback(
      people(['client@example.test']),
      before,
      'Native audit excludes referential UPDATE effects',
    );
    expect(await rows('rematch_child')).toEqual(childBefore);
  });
});

it('unrequested thread participant targets survive rematch and its late new Opportunity is refused before target derivation', async () => {
  const s = await seed();
  const otherPersonId = await insert('person', {
    name: { firstName: 'Unrequested' },
    emails: { primaryEmail: 'other@example.test', additionalEmails: [] },
  });
  const otherParticipantId = await insert(PARTICIPANT, {
    messageId: s.email.messageId,
    personId: otherPersonId,
    role: 'TO',
    handle: 'other@example.test',
  });
  await insert(TARGET, {
    messageThreadId: s.email.threadId,
    targetPersonId: otherPersonId,
    isAutomaticallyAssigned: true,
    isManuallyAssigned: false,
  });
  await people(['client@example.test']);
  expect(await participant(otherParticipantId)).toMatchObject({
    personId: otherPersonId,
  });
  expect(
    await f.owner.query(
      `SELECT "targetPersonId" FROM ${table(TARGET)} WHERE "messageThreadId"=$1 ORDER BY "targetPersonId"`,
      [s.email.threadId],
    ),
  ).toEqual(
    [otherPersonId, s.newPersonId]
      .sort()
      .map((targetPersonId) => ({ targetPersonId })),
  );
  await f.owner.query('TRUNCATE crm_audit."crmAuditEntry"');
  await f.owner.query(
    `UPDATE ${table(PARTICIPANT)} SET "personId"=$1 WHERE id=$2`,
    [s.personId, s.email.participantId],
  );
  f.eventEmitter.mockClear();
  const before = await graph();
  await trigger(
    `INSERT INTO ${table('opportunity')}(id,"pointOfContactId") VALUES(uuid_generate_v4(),'${otherPersonId}');`,
    'participant',
  );
  await rollback(
    people(['client@example.test']),
    before,
    'Native message rematch proof changed',
  );
});

it('member rematch reads no Person Company or Opportunity matching sources', async () => {
  const s = await seed(),
    beforeTargets = await rows(TARGET);
  const matchingSourceReads: string[] = [];
  const restore = await intercept(async (sql) => {
    if (
      ['person', 'company', 'opportunity'].some(
        (name) =>
          sql.includes('FROM ' + table(name)) ||
          sql.includes('JOIN ' + table(name)),
      )
    )
      matchingSourceReads.push(sql);
  });
  try {
    await members([s.oldMemberId]);
  } finally {
    restore();
  }
  expect(matchingSourceReads).toEqual([]);
  expect(await participant(s.email.participantId)).toMatchObject({
    workspaceMemberId: null,
    personId: s.personId,
  });
  expect(await rows(TARGET)).toEqual(beforeTargets);
  expect(await audit()).toHaveLength(1);
});

it('deferred insertion of an APP association invalidates captured matching policy', async () => {
  const s = await seed();
  const channelId = randomUUID();
  await f.owner.query(
    'INSERT INTO core."messageChannel"(id,"workspaceId",type) VALUES($1,$2,\'APP\')',
    [channelId, f.workspaceId],
  );
  const before = await graph();
  await trigger(
    `IF NOT EXISTS(SELECT 1 FROM ${table('messageChannelMessageAssociation')} WHERE "messageChannelId"='${channelId}' AND "messageId"='${s.email.messageId}') THEN INSERT INTO ${table('messageChannelMessageAssociation')}(id,"messageId","messageChannelId","messageExternalId","messageThreadExternalId",direction) VALUES(uuid_generate_v4(),'${s.email.messageId}','${channelId}','late-app','late-app-thread','INCOMING'); END IF;`,
    'audit',
    true,
  );
  await rollback(
    people(['client@example.test']),
    before,
    'Native message rematch proof changed',
  );
});

it('excluded APP handles cannot expand Person candidates for an eligible message', async () => {
  const s = await seed();
  await f.owner.query(
    `UPDATE ${table('person')} SET "emailsPrimaryEmail"='app-only@example.test',"emailsAdditionalEmails"='["CLIENT@example.test"]'::jsonb WHERE id=$1`,
    [s.newPersonId],
  );
  const channelId = randomUUID();
  await f.owner.query(
    'INSERT INTO core."messageChannel"(id,"workspaceId",type) VALUES($1,$2,\'APP\')',
    [channelId, f.workspaceId],
  );
  const appThreadId = await insert('messageThread', {
    subject: 'Ordinary APP',
  });
  const appMessageId = await insert('message', {
    messageThreadId: appThreadId,
    headerMessageId: randomUUID(),
  });
  const appParticipantId = await insert(PARTICIPANT, {
    messageId: appMessageId,
    personId: s.personId,
    role: 'FROM',
    handle: 'app-only@example.test',
  });
  await insert('messageChannelMessageAssociation', {
    messageId: appMessageId,
    messageChannelId: channelId,
    messageExternalId: 'app-policy',
    messageThreadExternalId: 'app-policy-thread',
    direction: 'INCOMING',
  });
  const appBefore = await participant(appParticipantId);
  await people(['client@example.test', 'app-only@example.test']);
  expect(await participant(s.email.participantId)).toMatchObject({
    personId: null,
    workspaceMemberId: s.oldMemberId,
  });
  expect(await participant(appParticipantId)).toEqual(appBefore);
});

it('member rematch derives candidates from the locked handle after discovery changes it', async () => {
  const s = await seed();
  const newMemberId = await insert('workspaceMember', {
    name: { firstName: 'Current handle' },
    userEmail: 'changed@example.test',
  });
  const beforeTargets = await rows(TARGET);
  let changed = false;
  const restore = await intercept(async (sql) => {
    if (!changed && discovery(sql)) {
      changed = true;
      await f.owner.query(
        `UPDATE ${table(PARTICIPANT)} SET handle='changed@example.test' WHERE id=$1`,
        [s.email.participantId],
      );
    }
  });
  try {
    await members([s.oldMemberId]);
  } finally {
    restore();
  }
  expect(changed).toBe(true);
  expect(await participant(s.email.participantId)).toMatchObject({
    handle: 'changed@example.test',
    workspaceMemberId: newMemberId,
    personId: s.personId,
  });
  expect(await rows(TARGET)).toEqual(beforeTargets);
  expect(await audit()).toEqual([
    expect.objectContaining({
      resourceId: s.email.participantId,
      action: 'update',
    }),
  ]);
});
