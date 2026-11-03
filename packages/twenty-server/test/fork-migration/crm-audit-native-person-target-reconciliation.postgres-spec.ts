import { randomUUID } from 'node:crypto';
import { reconcileNativeMessageThreadTargetsForPeopleWithAudit } from 'src/engine/core-modules/crm-audit/reconcile-native-message-thread-targets-with-audit';
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
const f = createOmniNativeCleanupFixture(),
  TARGET = 'messageThreadTarget',
  PART = 'messageParticipant';
const table = (name: string) => `"${f.schemaName}"."${name}"`;
const op = () => ({
  workspaceId: f.workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'system' as const, id: 'PersonTargetsTest' },
  correlationId: randomUUID(),
});
const page = async (personIds: string[], afterParticipantId?: string) =>
  f.withContext(() =>
    f.dataSource.transaction(
      (scope) =>
        reconcileNativeMessageThreadTargetsForPeopleWithAudit({
          scope,
          personIds,
          afterParticipantId,
          operation: op(),
        }),
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
const rows = (name: string) =>
  f.owner.query(
    `SELECT to_jsonb(row)::text AS row FROM ${table(name)} row ORDER BY id`,
  );
const audit = () =>
  f.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "resourceId"',
  );
const sourceNames = [
  'messageThread',
  'message',
  PART,
  'person',
  'company',
  'opportunity',
];
const graph = () => Promise.all([...sourceNames, TARGET].map(rows));
const insert = async (name: string, fields: Record<string, unknown>) => {
  const id = randomUUID();
  await f.seedNative((scope) =>
    scope
      .getRepository(name, { shouldBypassPermissionChecks: true })
      .insert({ id, ...fields }),
  );
  f.eventEmitter.mockClear();
  return id;
};
const target = (
  threadId: string,
  personId: string,
  extra: Record<string, unknown> = {},
) =>
  insert(TARGET, {
    messageThreadId: threadId,
    targetPersonId: personId,
    isAutomaticallyAssigned: true,
    isManuallyAssigned: false,
    ...extra,
  });
const seed = async () => {
  const s = await f.seed('link');
  const companyId = await insert('company', { name: 'Company' });
  await f.owner.query(
    `UPDATE ${table('person')} SET "companyId"=$1 WHERE id=$2`,
    [companyId, s.personId],
  );
  const opportunityId = await insert('opportunity', {
    pointOfContactId: s.personId,
    companyId,
  });
  await f.owner.query(
    `DELETE FROM ${table(TARGET)} WHERE "messageThreadId"=$1`,
    [s.email.threadId],
  );
  return { ...s, companyId, opportunityId };
};
const extraThread = async (personId: string) => {
  const threadId = await insert('messageThread', { subject: 'Other' }),
    messageId = await insert('message', {
      messageThreadId: threadId,
      headerMessageId: randomUUID(),
    }),
    participantId = await insert(PART, {
      messageId,
      personId,
      role: 'FROM',
      handle: 'other@example.test',
    });
  return { threadId, messageId, participantId };
};
const capture = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
const causes = (error: unknown) => {
  const result: string[] = [],
    seen = new Set<object>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const next = error as { message?: unknown; cause?: unknown };
    if (typeof next.message === 'string') result.push(next.message);
    error = next.cause;
  }
  return result.join(' | ');
};
const rollback = async (
  work: Promise<unknown>,
  before: unknown,
  cause: string,
) => {
  f.eventEmitter.mockClear();
  const result = await capture(work);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(causes(result.error)).toContain(cause);
  expect(await graph()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
};
const trigger = async (body: string, deferred = false) =>
  f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".person_target_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN ${body} RETURN NEW; END $$; CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER person_target_test AFTER INSERT ON crm_audit."crmAuditEntry" ${deferred ? 'DEFERRABLE INITIALLY DEFERRED ' : ''}FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".person_target_test()`,
  );
const intercept = async (observe: (sql: string) => Promise<void>) => {
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
  return () => querySpy.mockRestore();
};
const discovery = (sql: string) =>
  sql.includes(table(PART)) &&
  /LIMIT\s+200/i.test(sql) &&
  !/FOR UPDATE/i.test(sql);
beforeAll(() => f.initialize());
beforeEach(async () => {
  await f.owner.query(
    'DROP TRIGGER IF EXISTS person_target_test ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query(
    `DROP TRIGGER IF EXISTS person_target_test ON ${table(TARGET)}`,
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".person_target_test()`,
  );
  await f.reset();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it('person selector derives all thread participants, audits targets and retains every source and owned thread', async () => {
  const s = await seed(),
    other = await insert('person', { name: { firstName: 'Other' } });
  await insert(PART, {
    messageId: s.email.messageId,
    personId: other,
    role: 'TO',
    handle: 'other@example.test',
  });
  const before = await Promise.all(sourceNames.map(rows));
  const owned = await f.owner.query(
    `SELECT * FROM ${table(TARGET)} WHERE "messageThreadId"=$1`,
    [s.omni.threadId],
  );
  expect(await page([s.personId])).toEqual({ nextCursor: null });
  expect(
    await f.owner.query(
      `SELECT * FROM ${table(TARGET)} WHERE "messageThreadId"=$1`,
      [s.email.threadId],
    ),
  ).toHaveLength(4);
  expect(
    await f.owner.query(
      `SELECT * FROM ${table(TARGET)} WHERE "messageThreadId"=$1`,
      [s.omni.threadId],
    ),
  ).toEqual(owned);
  expect(await Promise.all(sourceNames.map(rows))).toEqual(before);
  expect(await audit()).toHaveLength(4);
});

it('person selector admits ordinary APP but excludes actual omni ownership and deleted threads', async () => {
  const s = await seed();
  await f.owner.query(
    'UPDATE core."messageChannel" SET type=\'APP\' WHERE id=$1',
    [s.channelId],
  );
  await page([s.personId]);
  expect(await audit()).toHaveLength(3);
  await f.owner.query(
    `UPDATE ${table('messageThread')} SET "deletedAt"=CURRENT_TIMESTAMP WHERE id=$1`,
    [s.email.threadId],
  );
  const before = await graph(),
    entries = await audit();
  await page([s.personId]);
  expect(await graph()).toEqual(before);
  expect(await audit()).toEqual(entries);
});

it('person selector retains manual and tombstoned targets', async () => {
  const s = await seed(),
    old = await insert('person', { name: { firstName: 'Old' } }),
    tombstone = await target(s.email.threadId, s.personId, {
      deletedAt: new Date('2029-01-01'),
    }),
    manual = await target(s.email.threadId, old, { isManuallyAssigned: true });
  await page([s.personId]);
  const actual = await f.owner.query(
    `SELECT * FROM ${table(TARGET)} WHERE "messageThreadId"=$1`,
    [s.email.threadId],
  );
  expect(actual).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: tombstone }),
      expect.objectContaining({
        id: manual,
        isAutomaticallyAssigned: false,
        isManuallyAssigned: true,
      }),
    ]),
  );
  expect(
    actual.filter(
      (row: Record<string, unknown>) => row.targetPersonId === s.personId,
    ),
  ).toHaveLength(1);
});

it.each(['person', 'message', 'thread'] as const)(
  'person selector skips exact original %s drift without following the new chain or deleting old targets',
  async (kind) => {
    const s = await seed(),
      other = await insert('person', { name: { firstName: 'Other' } }),
      replacement = await extraThread(other);
    await target(s.email.threadId, s.personId);
    const before = await rows(TARGET);
    let changed = false;
    const restore = await intercept(async (sql) => {
      if (!changed && discovery(sql)) {
        changed = true;
        if (kind === 'person')
          await f.owner.query(
            `UPDATE ${table(PART)} SET "personId"=$1 WHERE id=$2`,
            [other, s.email.participantId],
          );
        else if (kind === 'message')
          await f.owner.query(
            `UPDATE ${table(PART)} SET "messageId"=$1 WHERE id=$2`,
            [replacement.messageId, s.email.participantId],
          );
        else
          await f.owner.query(
            `UPDATE ${table('message')} SET "messageThreadId"=$1 WHERE id=$2`,
            [replacement.threadId, s.email.messageId],
          );
      }
    });
    try {
      await page([s.personId]);
    } finally {
      restore();
    }
    expect(changed).toBe(true);
    expect(await rows(TARGET)).toEqual(before);
    expect(await audit()).toEqual([]);
  },
);

it('person selector cursor advances after an entire 200-row page is skipped', async () => {
  const s = await seed();
  await f.owner.query(`UPDATE ${table(PART)} SET "personId"=NULL`);
  const ids = Array.from(
    { length: 201 },
    (_, index) =>
      `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  );
  await f.seedNative((scope) =>
    scope.getRepository(PART, { shouldBypassPermissionChecks: true }).insert(
      ids.map((id) => ({
        id,
        messageId: s.email.messageId,
        personId: s.personId,
        role: 'TO',
      })),
    ),
  );
  let changed = false;
  const restore = await intercept(async (sql) => {
    if (!changed && discovery(sql)) {
      changed = true;
      await f.owner.query(
        `UPDATE ${table(PART)} SET "personId"=NULL WHERE id=ANY($1::uuid[])`,
        [ids.slice(0, 200)],
      );
    }
  });
  let first: { nextCursor: string | null };
  try {
    first = await page([s.personId]);
  } finally {
    restore();
  }
  expect(changed).toBe(true);
  expect(first!.nextCursor).toBe(ids[199]);
  expect(await audit()).toEqual([]);
  expect(await page([s.personId], first!.nextCursor!)).toEqual({
    nextCursor: null,
  });
  expect(await audit()).toHaveLength(3);
});

it('person selector rolls back target writes if audit append fails', async () => {
  const s = await seed(),
    before = await graph();
  await trigger("RAISE EXCEPTION 'person target audit refused';");
  await rollback(page([s.personId]), before, 'person target audit refused');
});

it.each([false, true])(
  'person selector rejects late participant edits after audit/deferred flush (%s)',
  async (deferred) => {
    const s = await seed(),
      before = await graph();
    await trigger(
      `UPDATE ${table(PART)} SET handle='tampered@example.test' WHERE id='${s.email.participantId}';`,
      deferred,
    );
    await rollback(
      page([s.personId]),
      before,
      'Native person target selection changed',
    );
  },
);

it.each(['moved', 'absent'] as const)(
  'person selector retains proof of an initially %s original through audit flush',
  async (kind) => {
    const s = await seed(),
      otherPerson = await insert('person', { name: { firstName: 'Other' } });
    await extraThread(s.personId);
    let changed = false,
      baseline: unknown;
    const restore = await intercept(async (sql) => {
      if (!changed && discovery(sql)) {
        changed = true;
        if (kind === 'moved')
          await f.owner.query(
            `UPDATE ${table(PART)} SET "personId"=$1 WHERE id=$2`,
            [otherPerson, s.email.participantId],
          );
        else
          await f.owner.query(`DELETE FROM ${table(PART)} WHERE id=$1`, [
            s.email.participantId,
          ]);
        baseline = await graph();
      }
    });
    await trigger(
      kind === 'moved'
        ? `UPDATE ${table(PART)} SET handle='late-original@example.test' WHERE id='${s.email.participantId}';`
        : `INSERT INTO ${table(PART)}(id,"messageId","personId",role) VALUES('${s.email.participantId}','${s.email.messageId}','${s.personId}','FROM') ON CONFLICT DO NOTHING;`,
    );
    let result: Awaited<ReturnType<typeof capture>>;
    try {
      result = await capture(page([s.personId]));
    } finally {
      restore();
    }
    expect(changed).toBe(true);
    expect(result!.ok).toBe(false);
    if (!result!.ok)
      expect(causes(result!.error)).toContain(
        'Native person target selection changed',
      );
    expect(await graph()).toEqual(baseline);
    expect(await audit()).toEqual([]);
  },
);

it('person selector preserves fail-closed handling of generated target flag effects', async () => {
  const [original] = await f.owner.query(
    `SELECT format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required,a.attgenerated AS generated,pg_get_expr(d.adbin,d.adrelid) AS expression FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::regclass AND a.attname='searchVector'`,
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
    const s = await seed();
    await target(s.email.threadId, s.personId, {
      isAutomaticallyAssigned: false,
      isManuallyAssigned: true,
    });
    const before = await graph();
    await rollback(
      page([s.personId]),
      before,
      'Native target reconciliation effects mismatch',
    );
  } finally {
    await f.owner.query(
      `ALTER TABLE ${table(TARGET)} DROP COLUMN "searchVector"`,
    );
    await f.owner.query(
      `ALTER TABLE ${table(TARGET)} ADD COLUMN "searchVector" ${original.type}${original.generated ? ` GENERATED ALWAYS AS (${original.expression}) STORED` : original.expression ? ` DEFAULT ${original.expression}` : ''}${original.required ? ' NOT NULL' : ''}`,
    );
  }
});

it('person selector rejects late new opportunity for an unrequested thread participant', async () => {
  const s = await seed(),
    other = await insert('person', { name: { firstName: 'Other' } });
  await insert(PART, {
    messageId: s.email.messageId,
    personId: other,
    role: 'TO',
  });
  const before = await graph();
  await trigger(
    `INSERT INTO ${table('opportunity')}(id,"pointOfContactId") VALUES(uuid_generate_v4(),'${other}');`,
  );
  await rollback(
    page([s.personId]),
    before,
    'Native target reconciliation sources changed',
  );
});

it('person selector retains committed data and audit on real lost COMMIT ACK', async () => {
  const s = await seed();
  let committed = false;
  const restore = await intercept(async (sql) => {
    if (sql === 'COMMIT') {
      committed = true;
      throw new Error('person targets ACK lost');
    }
  });
  try {
    await expect(page([s.personId])).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
  } finally {
    restore();
  }
  expect(committed).toBe(true);
  expect(await audit()).toHaveLength(3);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('person selector holds source SHARE so a raw opportunity insert cannot cross target derivation', async () => {
  const s = await seed();
  let release!: () => void, entered!: () => void;
  const resume = new Promise<void>((resolve) => {
      release = resolve;
    }),
    reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
  let held = false;
  const restore = await intercept(async (sql) => {
    if (!held && sql.includes('LOCK TABLE') && sql.includes('IN SHARE MODE')) {
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
  const work = capture(page([s.personId]));
  let mutation: ReturnType<typeof capture> | undefined;
  try {
    await Promise.race([
      reached,
      work.then(() => {
        throw new Error('Page settled before SHARE');
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
    let blocked = false;
    for (let i = 0; i < 150; i++) {
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
    const inserted = await mutation;
    if (!inserted.ok) throw inserted.error;
    expect(await audit()).toHaveLength(3);
  } finally {
    release();
    await work;
    await mutation;
    restore();
    await writer.release();
  }
  await page([s.personId]);
  expect(await audit()).toHaveLength(4);
});

it('person selector proves a skipped original Message outside the admitted graph through deferred audit effects', async () => {
  const s = await seed();
  const otherPerson = await insert('person', {
    name: { firstName: 'Outside' },
  });
  const replacement = await extraThread(otherPerson);
  await extraThread(s.personId);
  let moved = false;
  let baseline: unknown;
  const restore = await intercept(async (sql) => {
    if (!moved && discovery(sql)) {
      moved = true;
      await f.owner.query(
        `UPDATE ${table('message')} SET "messageThreadId"=$1 WHERE id=$2`,
        [replacement.threadId, s.email.messageId],
      );
      baseline = await graph();
    }
  });
  await trigger(
    `UPDATE ${table('message')} SET "headerMessageId"='deferred-original-proof' WHERE id='${s.email.messageId}';`,
    true,
  );
  try {
    const result = await capture(page([s.personId]));
    expect(moved).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(causes(result.error)).toContain(
        'Native person target selection changed',
      );
    expect(await graph()).toEqual(baseline);
    expect(await audit()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  } finally {
    restore();
  }
});
