import { randomUUID } from 'node:crypto';
import { type QueryRunner } from 'typeorm';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { deleteOrphanNativeMessagesWithAudit } from 'src/engine/core-modules/crm-audit/delete-orphan-native-messages-with-audit';
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
const MESSAGE = 'message';
const PARTICIPANT = 'messageParticipant';
const ASSOCIATION = 'messageChannelMessageAssociation';
const THREAD = 'messageThread';
const TARGET = 'messageThreadTarget';
const table = (name: string) => `"${f.schemaName}"."${name}"`;
const operation = (): CrmAuditOperation => ({
  workspaceId: f.workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'system', id: 'MessagingMessageChannelDeletionCleanupJob' },
});
// Terminal owner callback: do not add later writes after final verification.
const remove = async (
  candidateMessageIds: readonly string[],
  auditOperation = operation(),
) =>
  f.withContext(() =>
    f.dataSource.transaction(
      (scope) =>
        deleteOrphanNativeMessagesWithAudit({
          scope,
          candidateMessageIds,
          operation: auditOperation,
        }),
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
const emptyResult = () => ({ deletedMessageIds: [], affectedThreadIds: [] });
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
    MESSAGE,
    PARTICIPANT,
    ASSOCIATION,
    'messageChannelMessageAssociationMessageFolder',
    THREAD,
    TARGET,
    'person',
  ])
    all.push(await rows(name));
  return all;
};
const retainedSnapshots = async () => {
  const all: unknown[] = [];
  for (const name of [
    THREAD,
    TARGET,
    'person',
    ASSOCIATION,
    'messageChannelMessageAssociationMessageFolder',
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
const seedOrphan = async (marker: 'link' | 'conversation' = 'link') => {
  const seed = await f.seed(marker);
  // Setup removes the association and its junction through the actual FK.
  await f.owner.query(`DELETE FROM ${table(ASSOCIATION)} WHERE id=$1`, [
    seed.email.associationId,
  ]);
  f.eventEmitter.mockClear();
  return seed;
};
const addOrphan = async (threadId?: string) => {
  const messageId = randomUUID(),
    participantId = randomUUID(),
    parentId = threadId ?? randomUUID();
  await f.seedNative(async (scope) => {
    const permissions = { shouldBypassPermissionChecks: true } as const;
    if (!threadId)
      await scope
        .getRepository(THREAD, permissions)
        .insert({ id: parentId, subject: 'second private parent' });
    await scope
      .getRepository(MESSAGE, permissions)
      .insert({
        id: messageId,
        messageThreadId: parentId,
        headerMessageId: randomUUID(),
        subject: 'private orphan',
        text: 'private body',
        isDraft: false,
      });
    await scope
      .getRepository(PARTICIPANT, permissions)
      .insert({
        id: participantId,
        messageId,
        role: 'FROM',
        handle: null,
        displayName: null,
      });
  });
  f.eventEmitter.mockClear();
  return { messageId, participantId, threadId: parentId };
};
beforeAll(() => f.initialize());
beforeEach(async () => {
  await f.owner.query(
    `DROP TRIGGER IF EXISTS orphan_message_skip ON ${table(MESSAGE)}`,
  );
  await f.owner.query(
    'DROP TRIGGER IF EXISTS orphan_message_corrupt ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".orphan_message_test()`,
  );
  await f.owner.query(`DROP TABLE IF EXISTS ${table('orphan_message_extra')}`);
  await f.reset();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it('deletes and audits only the orphan Message and Participant while preserving exact Thread and Target rows', async () => {
  const seed = await seedOrphan(),
    retained = await retainedSnapshots();
  expect(await remove([seed.email.messageId])).toEqual({
    deletedMessageIds: [seed.email.messageId],
    affectedThreadIds: [seed.email.threadId],
  });
  expect(await present(MESSAGE, seed.email.messageId)).toBe(false);
  expect(await present(PARTICIPANT, seed.email.participantId)).toBe(false);
  expect(await retainedSnapshots()).toEqual(retained);
  const entries = await audit();
  expect(entries).toHaveLength(2);
  expect(
    entries.map((row: { resourceId: string }) => row.resourceId).sort(),
  ).toEqual([seed.email.messageId, seed.email.participantId].sort());
  expect(
    new Set(entries.map((row: { operationId: string }) => row.operationId))
      .size,
  ).toBe(1);
  for (const row of entries)
    expect(row).toMatchObject({
      workspaceId: f.workspaceId,
      resourceKind: 'crmRecord',
      action: 'delete',
      actor: operation().actor,
      securityDescriptor: {
        resourceKind: 'crmRecord',
        resourceId: row.resourceId,
        objectMetadataId: expect.any(String),
        deletedRecord: { access: 'currentWorkspaceAdministration' },
      },
    });
  expect(JSON.stringify(entries)).not.toContain('email body');
  expect(JSON.stringify(entries)).not.toContain('client@example.test');
  expect(emittedIds()).toEqual([seed.email.messageId]);
  f.eventEmitter.mockClear();
  expect(await remove([seed.email.messageId])).toEqual(emptyResult());
  expect(await audit()).toEqual(entries);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it.each([false, true])(
  'any ordinary association blocks orphan deletion including soft-deleted=%s',
  async (deleted) => {
    const seed = await f.seed('link');
    if (deleted)
      await f.owner.query(
        `UPDATE ${table(ASSOCIATION)} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
        [seed.email.associationId],
      );
    const before = await snapshots();
    expect(await remove([seed.email.messageId])).toEqual(emptyResult());
    expect(await snapshots()).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it.each(['link', 'conversation'] as const)(
  'retains %s-owned Message with no remaining associations while deleting an ordinary sibling',
  async (marker) => {
    const seed = await seedOrphan(marker);
    await f.owner.query(
      `DELETE FROM ${table(ASSOCIATION)} WHERE "messageId"=$1`,
      [seed.omni.messageId],
    );
    expect(await remove([seed.omni.messageId, seed.email.messageId])).toEqual({
      deletedMessageIds: [seed.email.messageId],
      affectedThreadIds: [seed.email.threadId],
    });
    expect(await present(MESSAGE, seed.omni.messageId)).toBe(true);
    expect(await present(PARTICIPANT, seed.omni.participantId)).toBe(true);
    expect(await present(THREAD, seed.omni.threadId)).toBe(true);
    expect(await present(TARGET, seed.omni.targetId)).toBe(true);
    expect(
      (await audit())
        .map((row: { resourceId: string }) => row.resourceId)
        .sort(),
    ).toEqual([seed.email.messageId, seed.email.participantId].sort());
  },
);

it('preserves a soft-deleted orphan Message and its live Participant', async () => {
  const seed = await seedOrphan();
  await f.owner.query(
    `UPDATE ${table(MESSAGE)} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
    [seed.email.messageId],
  );
  const before = await snapshots();
  expect(await remove([seed.email.messageId])).toEqual(emptyResult());
  expect(await snapshots()).toEqual(before);
  expect(await audit()).toEqual([]);
});

it('journals a soft-deleted Participant that is actually removed by the Message FK cascade', async () => {
  const seed = await seedOrphan();
  await f.owner.query(
    `UPDATE ${table(PARTICIPANT)} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
    [seed.email.participantId],
  );
  expect(await remove([seed.email.messageId])).toEqual({
    deletedMessageIds: [seed.email.messageId],
    affectedThreadIds: [seed.email.threadId],
  });
  expect(await present(PARTICIPANT, seed.email.participantId)).toBe(false);
  expect(await audit()).toHaveLength(2);
});

it('deduplicates affectedThreadIds and never includes unmatched candidate IDs', async () => {
  const seed = await seedOrphan(),
    second = await addOrphan(seed.email.threadId);
  expect(
    await remove([
      second.messageId,
      seed.email.messageId,
      second.messageId,
      randomUUID(),
    ]),
  ).toEqual({
    deletedMessageIds: [second.messageId, seed.email.messageId].sort(),
    affectedThreadIds: [seed.email.threadId],
  });
  expect(await audit()).toHaveLength(4);
  expect(await present(THREAD, seed.email.threadId)).toBe(true);
  expect(await present(TARGET, seed.email.targetId)).toBe(true);
});

it('does not fabricate affectedThreadIds for an orphan with a null native thread', async () => {
  const seed = await seedOrphan();
  await f.owner.query(
    `UPDATE ${table(MESSAGE)} SET "messageThreadId"=NULL WHERE id=$1`,
    [seed.email.messageId],
  );
  const retained = await retainedSnapshots();
  expect(await remove([seed.email.messageId])).toEqual({
    deletedMessageIds: [seed.email.messageId],
    affectedThreadIds: [],
  });
  expect(await retainedSnapshots()).toEqual(retained);
  expect(await audit()).toHaveLength(2);
});

it('captures caller candidate IDs and actor before awaiting the first owner query', async () => {
  const seed = await seedOrphan(),
    second = await addOrphan();
  const candidates: string[] = [seed.email.messageId],
    auditOperation = operation(),
    actor = { ...auditOperation.actor };
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
      candidates[0] = second.messageId;
      auditOperation.actor.id = 'changed-after-entry';
      auditOperation.workspaceId = randomUUID();
    }
    return original(statement as string, values);
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  expect(await remove(candidates, auditOperation)).toEqual({
    deletedMessageIds: [seed.email.messageId],
    affectedThreadIds: [seed.email.threadId],
  });
  expect(mutated).toBe(true);
  expect(await present(MESSAGE, second.messageId)).toBe(true);
  for (const row of await audit())
    expect(row).toMatchObject({ actor, workspaceId: f.workspaceId });
});

it('returns affectedThreadIds only from actual DELETE RETURNING when a trigger skips another Message', async () => {
  const seed = await seedOrphan(),
    second = await addOrphan(),
    retained = await retainedSnapshots();
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".orphan_message_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.id='${seed.email.messageId}'::uuid THEN RETURN NULL; END IF; RETURN OLD; END $$;
    CREATE TRIGGER orphan_message_skip BEFORE DELETE ON ${table(MESSAGE)} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".orphan_message_test()`);
  expect(await remove([seed.email.messageId, second.messageId])).toEqual({
    deletedMessageIds: [second.messageId],
    affectedThreadIds: [second.threadId],
  });
  expect(await present(MESSAGE, seed.email.messageId)).toBe(true);
  expect(await present(PARTICIPANT, seed.email.participantId)).toBe(true);
  expect(await retainedSnapshots()).toEqual(retained);
  expect(
    (await audit()).map((row: { resourceId: string }) => row.resourceId).sort(),
  ).toEqual([second.messageId, second.participantId].sort());
  expect(emittedIds()).toEqual([second.messageId]);
});

it('rolls back Message and Participant deletion if audit insertion is refused', async () => {
  const seed = await seedOrphan(),
    before = await snapshots();
  await f.owner.query(
    `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${f.roleName}"`,
  );
  try {
    await expect(remove([seed.email.messageId])).rejects.toThrow();
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
  [MESSAGE, 'CASCADE'],
  [PARTICIPANT, 'CASCADE'],
  [PARTICIPANT, 'SET NULL'],
])(
  'rejects an unaccounted populated %s incoming FK %s',
  async (name, action) => {
    const seed = await seedOrphan(),
      before = await snapshots();
    const id =
      name === MESSAGE ? seed.email.messageId : seed.email.participantId;
    await f.owner.query(
      `CREATE TABLE ${table('orphan_message_extra')} (parent uuid REFERENCES ${table(name)}(id) ON DELETE ${action}); GRANT SELECT ON ${table('orphan_message_extra')} TO "${f.roleName}"`,
    );
    await f.owner.query(
      `INSERT INTO ${table('orphan_message_extra')} VALUES($1)`,
      [id],
    );
    await expect(remove([seed.email.messageId])).rejects.toThrow();
    expect(await snapshots()).toEqual(before);
    expect(
      await f.owner.query(
        `SELECT parent FROM ${table('orphan_message_extra')}`,
      ),
    ).toEqual([{ parent: id }]);
    expect(await audit()).toEqual([]);
  },
);

it.each([
  [PARTICIPANT, MESSAGE],
  [ASSOCIATION, MESSAGE],
])(
  'requires the real FK from %s to %s even when a blocking child is absent',
  async (child, parent) => {
    const seed = await seedOrphan(),
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
      await expect(remove([seed.email.messageId])).rejects.toThrow(
        /expected foreign keys/,
      );
      expect(await snapshots()).toEqual(before);
      expect(await audit()).toEqual([]);
    } finally {
      await f.owner.query(
        `ALTER TABLE ${table(child)} ADD CONSTRAINT ${quotedName} ${constraint.definition}`,
      );
    }
  },
);

it('rejects a retained MessageLink introduced by an audit trigger after native deletion', async () => {
  const seed = await seedOrphan(),
    before = await snapshots(),
    linkId = randomUUID();
  const [source] = await f.owner.query(
    'SELECT (to_jsonb(row)||$2::jsonb)::text AS snapshot FROM core."omniMessageLink" row WHERE "messageId"=$1',
    [
      seed.omni.messageId,
      JSON.stringify({
        id: linkId,
        messageId: seed.email.messageId,
        rawNativeMessageId: randomUUID(),
        nativeMessageKey: randomUUID(),
      }),
    ],
  );
  expect(source).toBeDefined();
  const literal = source.snapshot.replaceAll("'", "''");
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".orphan_message_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    INSERT INTO core."omniMessageLink" SELECT * FROM jsonb_populate_record(NULL::core."omniMessageLink", '${literal}'::jsonb) ON CONFLICT DO NOTHING;
    RETURN NEW; END $$;
    CREATE TRIGGER orphan_message_corrupt AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".orphan_message_test()`);
  await expect(remove([seed.email.messageId])).rejects.toThrow(/ownership/);
  expect(await snapshots()).toEqual(before);
  expect(
    await f.owner.query('SELECT id FROM core."omniMessageLink" WHERE id=$1', [
      linkId,
    ]),
  ).toEqual([]);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('drains deferred AFTER DELETE resurrection before final verification and rolls back everything', async () => {
  const seed = await seedOrphan(),
    before = await snapshots();
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".orphan_message_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    INSERT INTO ${table(MESSAGE)} SELECT OLD.*;
    RETURN OLD; END $$;
    CREATE CONSTRAINT TRIGGER orphan_message_skip AFTER DELETE ON ${table(MESSAGE)} DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".orphan_message_test()`);
  expect(
    await f.owner.query(
      `SELECT tgdeferrable AS deferrable, tginitdeferred AS deferred FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname='orphan_message_skip'`,
      [table(MESSAGE)],
    ),
  ).toEqual([{ deferrable: true, deferred: true }]);
  await expect(remove([seed.email.messageId])).rejects.toThrow(
    /effects mismatch/,
  );
  expect(await snapshots()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it.each(['missing', 'deleted'] as const)(
  'refuses a %s workspace',
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
    await expect(remove([randomUUID()])).rejects.toThrow(/active workspace/);
    expect(await audit()).toEqual([]);
  },
);

it.each(['invalid', 'too-many', 'foreign-operation', 'shared-scope'] as const)(
  'rejects %s input/authority without effects',
  async (kind) => {
    const seed = await seedOrphan(),
      before = await snapshots();
    const work =
      kind === 'shared-scope'
        ? f.withContext(() =>
            f.dataSource.transaction(
              (scope) =>
                deleteOrphanNativeMessagesWithAudit({
                  scope,
                  candidateMessageIds: [seed.email.messageId],
                  operation: operation(),
                }),
              { commitOutcome: 'strict' },
            ),
          )
        : kind === 'foreign-operation'
          ? remove([seed.email.messageId], {
              ...operation(),
              workspaceId: randomUUID(),
            })
          : remove(
              kind === 'invalid'
                ? [seed.email.messageId, 'invalid']
                : Array.from({ length: 501 }, () => randomUUID()),
            );
    await expect(work).rejects.toThrow();
    expect(await snapshots()).toEqual(before);
    expect(await audit()).toEqual([]);
  },
);

it('preserves committed Message deletion and audit after actual COMMIT acknowledgement loss', async () => {
  const seed = await seedOrphan(),
    retained = await retainedSnapshots();
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
      throw new Error('lost orphan-message COMMIT acknowledgement');
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await expect(remove([seed.email.messageId])).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(statements).not.toContain('ROLLBACK');
  expect(await present(MESSAGE, seed.email.messageId)).toBe(false);
  expect(await present(PARTICIPANT, seed.email.participantId)).toBe(false);
  expect(await retainedSnapshots()).toEqual(retained);
  expect(await audit()).toHaveLength(2);
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
  throw new Error('Expected exact orphan-message/FK PostgreSQL lock wait');
};
const closeWriter = async (runner: QueryRunner) => {
  if (runner.isTransactionActive) await runner.rollbackTransaction();
  if (!runner.isReleased) await runner.release();
};
type Seed = Awaited<ReturnType<typeof seedOrphan>>;
type RaceKind = 'association' | 'participant';
const prepareRace = async (seed: Seed, kind: RaceKind) => {
  const id = randomUUID(),
    writer = f.owner.createQueryRunner();
  await writer.connect();
  const [backend] = await writer.query('SELECT pg_backend_pid() AS pid');
  const write = () =>
    kind === 'association'
      ? writer.query(
          `INSERT INTO ${table(ASSOCIATION)} (id,"messageId","messageChannelId","messageExternalId","messageThreadExternalId",direction)
        VALUES($1,$2,$3,'race-association','race-thread','INCOMING')`,
          [id, seed.email.messageId, seed.channelId],
        )
      : writer.query(
          `INSERT INTO ${table(PARTICIPANT)} (id,"messageId",role,handle,"displayName") VALUES($1,$2,'TO','race@example.test','private race participant')`,
          [id, seed.email.messageId],
        );
  return { writer, writerPid: backend.pid as number, id, write };
};

// These raw writers intentionally omit the supported native fence. Actual FK
// key-share locks must serialize with owner Message locks in both directions.
it.each(['association', 'participant'] as const)(
  'rereads a %s INSERT committed before its Message lock',
  async (kind) => {
    const seed = await seedOrphan(),
      race = await prepareRace(seed, kind),
      retained = await retainedSnapshots();
    const client = await f.pool.connect();
    const nativePid = (await client.query('SELECT pg_backend_pid() AS pid'))
      .rows[0].pid as number;
    jest
      .spyOn(f.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await race.writer.startTransaction();
    await race.write();
    const deletion = capture(remove([seed.email.messageId]));
    try {
      await waitForBlocker(nativePid, race.writerPid);
      await race.writer.commitTransaction();
      if (kind === 'association') {
        expect(await deletion).toEqual({ ok: true, value: emptyResult() });
        expect(await present(MESSAGE, seed.email.messageId)).toBe(true);
        expect(await present(PARTICIPANT, seed.email.participantId)).toBe(true);
        expect(await present(ASSOCIATION, race.id)).toBe(true);
        expect(await audit()).toEqual([]);
        expect(f.eventEmitter).not.toHaveBeenCalled();
      } else {
        expect(await deletion).toEqual({
          ok: true,
          value: {
            deletedMessageIds: [seed.email.messageId],
            affectedThreadIds: [seed.email.threadId],
          },
        });
        expect(await present(PARTICIPANT, race.id)).toBe(false);
        expect(
          (await audit())
            .map((row: { resourceId: string }) => row.resourceId)
            .sort(),
        ).toEqual(
          [seed.email.messageId, seed.email.participantId, race.id].sort(),
        );
        expect(await retainedSnapshots()).toEqual(retained);
        expect(emittedIds()).toEqual([seed.email.messageId]);
      }
    } finally {
      await closeWriter(race.writer);
      await deletion;
    }
  },
);

it.each(['association', 'participant'] as const)(
  'Message lock first makes a later %s INSERT fail after commit',
  async (kind) => {
    const seed = await seedOrphan(),
      race = await prepareRace(seed, kind),
      retained = await retainedSnapshots();
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
        text.includes('FROM ' + table(MESSAGE)) &&
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
    const deletion = capture(remove([seed.email.messageId]));
    let mutation: ReturnType<typeof capture> | undefined;
    try {
      await Promise.race([
        reached.promise,
        deletion.then(() => {
          throw new Error('Cleanup settled before Message lock barrier');
        }),
      ]);
      mutation = capture(race.write());
      await waitForBlocker(race.writerPid, nativePid);
      resume.release();
      expect(await deletion).toEqual({
        ok: true,
        value: {
          deletedMessageIds: [seed.email.messageId],
          affectedThreadIds: [seed.email.threadId],
        },
      });
      expect(await mutation).toMatchObject({
        ok: false,
        error: expect.objectContaining({
          driverError: expect.objectContaining({ code: '23503' }),
        }),
      });
      expect(
        await present(
          kind === 'association' ? ASSOCIATION : PARTICIPANT,
          race.id,
        ),
      ).toBe(false);
      expect(await retainedSnapshots()).toEqual(retained);
      expect(await audit()).toHaveLength(2);
      expect(emittedIds()).toEqual([seed.email.messageId]);
    } finally {
      resume.release();
      await deletion;
      if (mutation) await mutation;
      await closeWriter(race.writer);
    }
  },
);
