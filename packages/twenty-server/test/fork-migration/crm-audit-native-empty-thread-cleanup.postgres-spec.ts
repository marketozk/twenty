import { randomUUID } from 'node:crypto';
import { type QueryRunner } from 'typeorm';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { deleteEmptyNativeMessageThreadsWithAudit } from 'src/engine/core-modules/crm-audit/delete-empty-native-message-threads-with-audit';
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
const THREAD = 'messageThread';
const TARGET = 'messageThreadTarget';
const ASSOCIATION = 'messageChannelMessageAssociation';
const JUNCTION = 'messageChannelMessageAssociationMessageFolder';
const table = (name: string) => `"${f.schemaName}"."${name}"`;
const operation = (): CrmAuditOperation => ({
  workspaceId: f.workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'system', id: 'MessagingMessageChannelDeletionCleanupJob' },
});
// The owner is the terminal transaction callback: callers must not issue later
// writes after its constraint drain and final graph verification.
const remove = async (
  candidateThreadIds: readonly string[],
  auditOperation = operation(),
) =>
  f.withContext(() =>
    f.dataSource.transaction(
      (scope) =>
        deleteEmptyNativeMessageThreadsWithAudit({
          scope,
          candidateThreadIds,
          operation: auditOperation,
        }),
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
const audit = () =>
  f.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "resourceId"',
  );
const rows = (name: string) =>
  f.owner.query(
    `SELECT to_jsonb(row)::text AS snapshot FROM ${table(name)} row ORDER BY id`,
  );
const snapshots = async () => {
  const all: unknown[] = [];
  for (const name of [
    THREAD,
    TARGET,
    ASSOCIATION,
    JUNCTION,
    'message',
    'messageParticipant',
    'person',
  ])
    all.push(await rows(name));
  return all;
};
const present = async (name: string, id: string) =>
  (await f.owner.query(`SELECT id FROM ${table(name)} WHERE id=$1`, [id]))
    .length === 1;
const emittedIds = () =>
  f.eventEmitter.mock.calls.flatMap(([batch]) =>
    batch.events.map((event: { recordId: string }) => event.recordId),
  );
const emptyThread = async () => {
  const id = randomUUID();
  await f.seedNative((scope) =>
    scope
      .getRepository(THREAD, { shouldBypassPermissionChecks: true })
      .insert({ id, subject: 'private empty thread' }),
  );
  f.eventEmitter.mockClear();
  return id;
};
// The actual standard schema has association.messageThreadId despite its absence
// from the legacy TS entity. Its Message deliberately belongs to another thread.
const seedGraph = async () => {
  const seed = await f.seed('link');
  const threadId = await emptyThread(),
    targetId = randomUUID();
  await f.seedNative((scope) =>
    scope.getRepository(TARGET, { shouldBypassPermissionChecks: true }).insert({
      id: targetId,
      messageThreadId: threadId,
      targetPersonId: seed.personId,
      isAutomaticallyAssigned: false,
      isManuallyAssigned: true,
    }),
  );
  await f.owner.query(
    `UPDATE ${table(ASSOCIATION)} SET "messageThreadId"=$1 WHERE id=$2`,
    [threadId, seed.email.associationId],
  );
  expect(
    await f.owner.query(
      `SELECT id FROM ${table('message')} WHERE "messageThreadId"=$1`,
      [threadId],
    ),
  ).toEqual([]);
  f.eventEmitter.mockClear();
  return { ...seed, threadId, targetId };
};
beforeAll(() => f.initialize());
beforeEach(async () => {
  await f.owner.query(
    `DROP TRIGGER IF EXISTS empty_thread_skip ON ${table(THREAD)}`,
  );
  await f.owner.query(
    'DROP TRIGGER IF EXISTS empty_thread_corrupt ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".empty_thread_test()`,
  );
  await f.owner.query(`DROP TABLE IF EXISTS ${table('empty_thread_extra')}`);
  await f.reset();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it('rolls back the entire graph when a deferred AFTER DELETE constraint trigger resurrects its thread', async () => {
  const seed = await seedGraph(),
    before = await snapshots();
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".empty_thread_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    INSERT INTO ${table(THREAD)} SELECT OLD.*;
    RETURN OLD; END $$;
    CREATE CONSTRAINT TRIGGER empty_thread_skip AFTER DELETE ON ${table(THREAD)}
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".empty_thread_test()`);
  expect(
    await f.owner.query(
      `SELECT tgdeferrable AS deferrable, tginitdeferred AS deferred FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname='empty_thread_skip'`,
      [table(THREAD)],
    ),
  ).toEqual([{ deferrable: true, deferred: true }]);
  await expect(remove([seed.threadId])).rejects.toThrow(
    'Native empty-thread cleanup effects mismatch',
  );
  expect(await snapshots()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('deletes and audits the full empty-thread target/association/junction graph while retaining the association Message in its other thread', async () => {
  const seed = await seedGraph();
  const unchanged = await Promise.all(
    ['message', 'messageParticipant', 'person'].map(rows),
  );
  expect(await remove([seed.threadId])).toEqual([seed.threadId]);
  for (const [name, id] of [
    [THREAD, seed.threadId],
    [TARGET, seed.targetId],
    [ASSOCIATION, seed.email.associationId],
    [JUNCTION, seed.email.junctionId],
  ])
    expect(await present(name, id)).toBe(false);
  expect(await present(THREAD, seed.email.threadId)).toBe(true);
  expect(await present(TARGET, seed.email.targetId)).toBe(true);
  expect(
    await Promise.all(['message', 'messageParticipant', 'person'].map(rows)),
  ).toEqual(unchanged);
  const entries = await audit();
  expect(entries).toHaveLength(4);
  expect(
    entries.map((row: { resourceId: string }) => row.resourceId).sort(),
  ).toEqual(
    [
      seed.threadId,
      seed.targetId,
      seed.email.associationId,
      seed.email.junctionId,
    ].sort(),
  );
  expect(
    new Set(entries.map((row: { operationId: string }) => row.operationId))
      .size,
  ).toBe(1);
  for (const row of entries)
    expect(row).toMatchObject({
      workspaceId: f.workspaceId,
      action: 'delete',
      resourceKind: 'crmRecord',
      actor: operation().actor,
      securityDescriptor: {
        resourceKind: 'crmRecord',
        resourceId: row.resourceId,
        objectMetadataId: expect.any(String),
        deletedRecord: { access: 'currentWorkspaceAdministration' },
      },
    });
  expect(JSON.stringify(entries)).not.toContain('private empty thread');
  expect(JSON.stringify(entries)).not.toContain('client@example.test');
  expect(emittedIds()).toEqual([seed.threadId]);
  f.eventEmitter.mockClear();
  expect(await remove([seed.threadId])).toEqual([]);
  expect(await audit()).toEqual(entries);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it.each([false, true])(
  'retains a thread with an actual Message including soft-deleted=%s',
  async (deleted) => {
    const seed = await seedGraph();
    await f.owner.query(
      `UPDATE ${table('message')} SET "messageThreadId"=$1,"deletedAt"=${deleted ? 'clock_timestamp()' : 'NULL'} WHERE id=$2`,
      [seed.threadId, seed.email.messageId],
    );
    const before = await snapshots();
    expect(await remove([seed.threadId])).toEqual([]);
    expect(await snapshots()).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it('preserves a soft-deleted empty root even when children remain live', async () => {
  const seed = await seedGraph();
  await f.owner.query(
    `UPDATE ${table(THREAD)} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
    [seed.threadId],
  );
  const before = await snapshots();
  expect(await remove([seed.threadId])).toEqual([]);
  expect(await snapshots()).toEqual(before);
  expect(await audit()).toEqual([]);
});

it.each(['too-many', 'invalid-uuid'] as const)(
  'rejects %s candidate input before mutation',
  async (kind) => {
    const seed = await seedGraph(),
      before = await snapshots();
    const candidates =
      kind === 'too-many'
        ? Array.from({ length: 501 }, () => randomUUID())
        : [seed.threadId, 'invalid'];
    await expect(remove(candidates)).rejects.toThrow(
      /bounded scoped system authority/,
    );
    expect(await snapshots()).toEqual(before);
    expect(await audit()).toEqual([]);
  },
);

it.each(['shared-scope', 'foreign-operation'] as const)(
  'refuses %s without effects',
  async (kind) => {
    const seed = await seedGraph(),
      before = await snapshots();
    const work =
      kind === 'shared-scope'
        ? f.withContext(() =>
            f.dataSource.transaction(
              (scope) =>
                deleteEmptyNativeMessageThreadsWithAudit({
                  scope,
                  candidateThreadIds: [seed.threadId],
                  operation: operation(),
                }),
              { commitOutcome: 'strict' },
            ),
          )
        : remove([seed.threadId], {
            ...operation(),
            workspaceId: randomUUID(),
          });
    await expect(work).rejects.toThrow();
    expect(await snapshots()).toEqual(before);
    expect(await audit()).toEqual([]);
  },
);

it('captures candidate IDs and audit identity before the first owner SQL await', async () => {
  const seed = await seedGraph(),
    otherId = await emptyThread();
  const candidates = [seed.threadId],
    auditOperation = operation();
  const actor = { ...auditOperation.actor };
  const client = await f.pool.connect(),
    original = client.query.bind(client);
  let mutated = false;
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const text = typeof statement === 'string' ? statement : statement.text;
    if (!mutated && text === "SET LOCAL lock_timeout='8s'") {
      mutated = true;
      candidates[0] = otherId;
      auditOperation.actor.id = 'changed-after-owner-entry';
      auditOperation.workspaceId = randomUUID();
    }
    return original(statement as string, values);
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  expect(await remove(candidates, auditOperation)).toEqual([seed.threadId]);
  expect(mutated).toBe(true);
  expect(await present(THREAD, otherId)).toBe(true);
  expect(await present(THREAD, seed.threadId)).toBe(false);
  const entries = await audit();
  expect(entries).toHaveLength(4);
  for (const row of entries)
    expect(row).toMatchObject({ actor, workspaceId: f.workspaceId });
});

it('audits soft-deleted target and junction rows actually removed by the native FK cascade', async () => {
  const seed = await seedGraph();
  for (const [name, id] of [
    [TARGET, seed.targetId],
    [ASSOCIATION, seed.email.associationId],
    [JUNCTION, seed.email.junctionId],
  ])
    await f.owner.query(
      `UPDATE ${table(name)} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
      [id],
    );
  expect(await remove([seed.threadId])).toEqual([seed.threadId]);
  expect(await audit()).toHaveLength(4);
  expect(await present(JUNCTION, seed.email.junctionId)).toBe(false);
});

it.each([
  'conversation',
  'association-message',
  'association-binding',
  'folder-only',
] as const)(
  'retains the entire graph for %s ownership while deleting another ordinary candidate',
  async (marker) => {
    const seed = await seedGraph();
    if (marker === 'conversation')
      await f.coreInsert('omniConversation', {
        workspaceId: f.workspaceId,
        bindingId: seed.bindingId,
        policyId: seed.policyId,
        policyVersion: '0',
        providerChatId: randomUUID(),
        messageThreadId: seed.threadId,
      });
    else if (marker === 'association-message') {
      const unboundChannelId = await f.coreInsert('messageChannel', {
        workspaceId: f.workspaceId,
        type: 'EMAIL',
      });
      await f.owner.query(
        `UPDATE ${table(ASSOCIATION)} SET "messageId"=$1,"messageChannelId"=$2 WHERE id=$3`,
        [seed.omni.messageId, unboundChannelId, seed.email.associationId],
      );
    } else if (marker === 'association-binding')
      await f.owner.query(
        `UPDATE ${table(ASSOCIATION)} SET "messageChannelId"=$1 WHERE id=$2`,
        [seed.protectedChannelId, seed.email.associationId],
      );
    else {
      const folderId = await f.coreInsert('messageFolder', {
        workspaceId: f.workspaceId,
        messageChannelId: seed.protectedChannelId,
      });
      await f.owner.query(
        `UPDATE ${table(JUNCTION)} SET "messageFolderId"=$1 WHERE id=$2`,
        [folderId, seed.email.junctionId],
      );
    }
    const before = await snapshots();
    const otherId = await emptyThread();
    expect(await remove([seed.threadId, otherId])).toEqual([otherId]);
    expect(await snapshots()).toEqual(before);
    expect(
      (await audit()).map((row: { resourceId: string }) => row.resourceId),
    ).toEqual([otherId]);
    expect(emittedIds()).toEqual([otherId]);
  },
);

it('uses actual DELETE RETURNING so a skipped parent keeps all children without false audit or events', async () => {
  const seed = await seedGraph(),
    otherId = await emptyThread();
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".empty_thread_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.id='${seed.threadId}'::uuid THEN RETURN NULL; END IF; RETURN OLD; END $$;
    CREATE TRIGGER empty_thread_skip BEFORE DELETE ON ${table(THREAD)} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".empty_thread_test()`);
  expect(await remove([seed.threadId, otherId])).toEqual([otherId]);
  for (const [name, id] of [
    [THREAD, seed.threadId],
    [TARGET, seed.targetId],
    [ASSOCIATION, seed.email.associationId],
    [JUNCTION, seed.email.junctionId],
  ])
    expect(await present(name, id)).toBe(true);
  expect(
    (await audit()).map((row: { resourceId: string }) => row.resourceId),
  ).toEqual([otherId]);
  expect(emittedIds()).toEqual([otherId]);
});

it('rolls back the entire native FK graph when audit insertion is refused', async () => {
  const seed = await seedGraph(),
    before = await snapshots();
  await f.owner.query(
    `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${f.roleName}"`,
  );
  try {
    await expect(remove([seed.threadId])).rejects.toThrow();
  } finally {
    await f.owner.query(
      `GRANT INSERT ON crm_audit."crmAuditEntry" TO "${f.roleName}"`,
    );
  }
  expect(await snapshots()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it.each([
  [THREAD, 'CASCADE'],
  [TARGET, 'CASCADE'],
  [ASSOCIATION, 'CASCADE'],
  [JUNCTION, 'CASCADE'],
  [TARGET, 'SET NULL'],
])(
  'refuses an unaccounted populated %s incoming FK %s',
  async (name, action) => {
    const seed = await seedGraph(),
      before = await snapshots();
    const id =
      name === THREAD
        ? seed.threadId
        : name === TARGET
          ? seed.targetId
          : name === ASSOCIATION
            ? seed.email.associationId
            : seed.email.junctionId;
    await f.owner.query(
      `CREATE TABLE ${table('empty_thread_extra')} (parent uuid REFERENCES ${table(name)}(id) ON DELETE ${action}); GRANT SELECT ON ${table('empty_thread_extra')} TO "${f.roleName}"`,
    );
    await f.owner.query(
      `INSERT INTO ${table('empty_thread_extra')} VALUES($1)`,
      [id],
    );
    await expect(remove([seed.threadId])).rejects.toThrow();
    expect(await snapshots()).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(
      await f.owner.query(`SELECT parent FROM ${table('empty_thread_extra')}`),
    ).toEqual([{ parent: id }]);
  },
);

it.each(['missing', 'deleted'] as const)(
  'refuses a %s workspace before native mutation',
  async (state) => {
    if (state === 'missing')
      await f.owner.query('DELETE FROM core.workspace WHERE id=$1', [
        f.workspaceId,
      ]);
    else
      await f.owner.query(
        'UPDATE core.workspace SET "deletedAt"=clock_timestamp() WHERE id=$1',
        [f.workspaceId],
      );
    const before = await snapshots();
    await expect(remove([randomUUID()])).rejects.toThrow();
    expect(await snapshots()).toEqual(before);
    expect(await audit()).toEqual([]);
  },
);

it.each([
  ['message', THREAD],
  [TARGET, THREAD],
  [ASSOCIATION, THREAD],
  [JUNCTION, ASSOCIATION],
])(
  'refuses missing native FK %s to %s before relying on its child lock behavior',
  async (child, parent) => {
    const seed = await seedGraph(),
      before = await snapshots();
    const constraints = await f.owner.query(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE contype='f' AND conrelid=$1::regclass AND confrelid=$2::regclass`,
      [table(child), table(parent)],
    );
    expect(constraints).toHaveLength(1);
    const constraint = constraints[0],
      quotedName = '"' + constraint.name.replaceAll('"', '""') + '"';
    await f.owner.query(
      `ALTER TABLE ${table(child)} DROP CONSTRAINT ${quotedName}`,
    );
    try {
      await expect(remove([seed.threadId])).rejects.toThrow(
        /expected foreign keys/,
      );
      expect(await snapshots()).toEqual(before);
      expect(await audit()).toEqual([]);
      expect(f.eventEmitter).not.toHaveBeenCalled();
    } finally {
      await f.owner.query(
        `ALTER TABLE ${table(child)} ADD CONSTRAINT ${quotedName} ${constraint.definition}`,
      );
    }
  },
);

it('rejects ownership introduced by a late audit trigger and rolls back the full graph', async () => {
  const seed = await seedGraph(),
    before = await snapshots(),
    conversationId = randomUUID();
  const [source] = await f.owner.query(
    'SELECT (to_jsonb(row)||$2::jsonb)::text AS snapshot FROM core."omniConversation" row WHERE "messageThreadId"=$1',
    [
      seed.markerThreadId,
      JSON.stringify({
        id: conversationId,
        messageThreadId: seed.threadId,
        providerChatId: randomUUID(),
      }),
    ],
  );
  expect(source).toBeDefined();
  const literal = source.snapshot.replaceAll("'", "''");
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".empty_thread_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    INSERT INTO core."omniConversation" SELECT * FROM jsonb_populate_record(NULL::core."omniConversation", '${literal}'::jsonb) ON CONFLICT DO NOTHING;
    RETURN NEW; END $$;
    CREATE TRIGGER empty_thread_corrupt AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".empty_thread_test()`);
  await expect(remove([seed.threadId])).rejects.toThrow(/ownership/);
  expect(await snapshots()).toEqual(before);
  expect(
    await f.owner.query('SELECT id FROM core."omniConversation" WHERE id=$1', [
      conversationId,
    ]),
  ).toEqual([]);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('keeps committed graph deletion and four audits after actual COMMIT acknowledgement loss', async () => {
  const seed = await seedGraph();
  const client = await f.pool.connect(),
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
      throw new Error('lost empty-thread commit acknowledgement');
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await expect(remove([seed.threadId])).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(statements).not.toContain('ROLLBACK');
  expect(await present(THREAD, seed.threadId)).toBe(false);
  expect(await present(JUNCTION, seed.email.junctionId)).toBe(false);
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
  for (let attempt = 0; attempt < 300; attempt++) {
    const [row] = await f.owner.query(
      'SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',
      [waiting, blocking],
    );
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected exact empty-thread/FK PostgreSQL lock wait');
};
const closeWriter = async (runner: QueryRunner) => {
  if (runner.isTransactionActive) await runner.rollbackTransaction();
  if (!runner.isReleased) await runner.release();
};
type Seed = Awaited<ReturnType<typeof seedGraph>>;
type RaceKind = 'message-insert' | 'association-reparent';
const prepareRace = async (seed: Seed, kind: RaceKind) => {
  const messageId = randomUUID(),
    associationId = randomUUID(),
    junctionId = randomUUID();
  const sourceThreadId = await emptyThread();
  if (kind === 'association-reparent') {
    const channelId = await f.coreInsert('messageChannel', {
      workspaceId: f.workspaceId,
      type: 'EMAIL',
    });
    await f.owner.query(
      `INSERT INTO ${table(ASSOCIATION)} (id,"messageId","messageThreadId","messageChannelId","messageExternalId","messageThreadExternalId",direction)
       VALUES($1,$2,$3,$4,'race-association','race-thread','INCOMING')`,
      [associationId, seed.email.messageId, sourceThreadId, channelId],
    );
    await f.owner.query(
      `INSERT INTO ${table(JUNCTION)} (id,"messageChannelMessageAssociationId","messageFolderId") VALUES($1,$2,$3)`,
      [junctionId, associationId, randomUUID()],
    );
  }
  const writer = f.owner.createQueryRunner();
  await writer.connect();
  const [backend] = await writer.query('SELECT pg_backend_pid() AS pid');
  const write = () =>
    kind === 'message-insert'
      ? writer.query(
          `INSERT INTO ${table('message')} (id,"messageThreadId","headerMessageId",subject,text,"isDraft") VALUES($1,$2,$3,'concurrent','private body',false)`,
          [messageId, seed.threadId, randomUUID()],
        )
      : writer.query(
          `UPDATE ${table(ASSOCIATION)} SET "messageThreadId"=$1 WHERE id=$2`,
          [seed.threadId, associationId],
        );
  return {
    writer,
    writerPid: backend.pid as number,
    write,
    messageId,
    associationId,
    junctionId,
    sourceThreadId,
  };
};

// Direct SQL deliberately omits the supported ownership fence. Real native FK
// locks, not a mock writer or timing assumption, must serialize these operations.
it.each(['message-insert', 'association-reparent'] as const)(
  'rereads a %s committed before its thread cleanup lock',
  async (kind) => {
    const seed = await seedGraph(),
      race = await prepareRace(seed, kind);
    const client = await f.pool.connect();
    const nativePid = (await client.query('SELECT pg_backend_pid() AS pid'))
      .rows[0].pid as number;
    jest
      .spyOn(f.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await race.writer.startTransaction();
    await race.write();
    const deletion = capture(remove([seed.threadId]));
    try {
      await waitForBlocker(nativePid, race.writerPid);
      await race.writer.commitTransaction();
      if (kind === 'message-insert') {
        expect(await deletion).toEqual({ ok: true, value: [] });
        for (const [name, id] of [
          [THREAD, seed.threadId],
          [TARGET, seed.targetId],
          [ASSOCIATION, seed.email.associationId],
          [JUNCTION, seed.email.junctionId],
          ['message', race.messageId],
        ])
          expect(await present(name, id)).toBe(true);
        expect(await audit()).toEqual([]);
        expect(f.eventEmitter).not.toHaveBeenCalled();
      } else {
        expect(await deletion).toEqual({ ok: true, value: [seed.threadId] });
        expect(await present(ASSOCIATION, race.associationId)).toBe(false);
        expect(await present(JUNCTION, race.junctionId)).toBe(false);
        expect(
          (await audit())
            .map((row: { resourceId: string }) => row.resourceId)
            .sort(),
        ).toEqual(
          [
            seed.threadId,
            seed.targetId,
            seed.email.associationId,
            seed.email.junctionId,
            race.associationId,
            race.junctionId,
          ].sort(),
        );
        expect(await present('message', seed.email.messageId)).toBe(true);
        expect(emittedIds()).toEqual([seed.threadId]);
      }
      expect(await present(THREAD, race.sourceThreadId)).toBe(true);
    } finally {
      await closeWriter(race.writer);
      await deletion;
    }
  },
);

it.each(['message-insert', 'association-reparent'] as const)(
  'thread cleanup locks first and later %s is rejected after committed deletion',
  async (kind) => {
    const seed = await seedGraph(),
      race = await prepareRace(seed, kind);
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
        text.startsWith('SELECT id FROM ' + table(THREAD)) &&
        text.includes('FOR UPDATE')
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
    const deletion = capture(remove([seed.threadId]));
    let mutation: ReturnType<typeof capture> | undefined;
    try {
      await Promise.race([
        reached.promise,
        deletion.then(() => {
          throw new Error('Cleanup settled before thread lock barrier');
        }),
      ]);
      mutation = capture(race.write());
      await waitForBlocker(race.writerPid, nativePid);
      resume.release();
      expect(await deletion).toEqual({ ok: true, value: [seed.threadId] });
      expect(await mutation).toMatchObject({
        ok: false,
        error: expect.objectContaining({
          driverError: expect.objectContaining({ code: '23503' }),
        }),
      });
      expect(await audit()).toHaveLength(4);
      expect(await present('message', seed.email.messageId)).toBe(true);
      expect(await present('message', race.messageId)).toBe(false);
      if (kind === 'association-reparent') {
        expect(
          await f.owner.query(
            `SELECT "messageThreadId" FROM ${table(ASSOCIATION)} WHERE id=$1`,
            [race.associationId],
          ),
        ).toEqual([{ messageThreadId: race.sourceThreadId }]);
        expect(await present(JUNCTION, race.junctionId)).toBe(true);
      }
      expect(emittedIds()).toEqual([seed.threadId]);
    } finally {
      resume.release();
      await deletion;
      if (mutation) await mutation;
      await closeWriter(race.writer);
    }
  },
);
