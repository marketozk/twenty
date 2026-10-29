import { randomUUID } from 'node:crypto';
import { type QueryRunner } from 'typeorm';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { reconcileNativeMessageThreadTargetsWithAudit } from 'src/engine/core-modules/crm-audit/reconcile-native-message-thread-targets-with-audit';
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
const TARGET = 'messageThreadTarget';
const table = (name: string) => `"${f.schemaName}"."${name}"`;
const operation = (): CrmAuditOperation => ({
  workspaceId: f.workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'system', id: 'MessagingMessageChannelDeletionCleanupJob' },
});
// Terminal owner callback, with no later source or target writes before commit.
const reconcile = async (
  candidateThreadIds: readonly string[],
  auditOperation = operation(),
) =>
  f.withContext(() =>
    f.dataSource.transaction(
      (scope) =>
        reconcileNativeMessageThreadTargetsWithAudit({
          scope,
          candidateThreadIds,
          operation: auditOperation,
        }),
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
const emptyResult = () => ({
  createdTargetIds: [],
  updatedTargetIds: [],
  deletedTargetIds: [],
});
const audit = () =>
  f.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "resourceId"',
  );
const rows = (name: string) =>
  f.owner.query(
    `SELECT to_jsonb(row)::text AS snapshot FROM ${table(name)} row ORDER BY id`,
  );
const sources = async () => {
  const result: unknown[] = [];
  for (const name of [
    'messageThread',
    'message',
    'messageParticipant',
    'person',
    'company',
    'opportunity',
  ])
    result.push(await rows(name));
  return result;
};
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
const target = (threadId: string, fields: Record<string, unknown>) =>
  insert(TARGET, {
    messageThreadId: threadId,
    targetPersonId: null,
    targetCompanyId: null,
    targetOpportunityId: null,
    isAutomaticallyAssigned: true,
    isManuallyAssigned: false,
    ...fields,
  });
const seedSources = async () => {
  const seed = await f.seed('link');
  const companyId = await insert('company', {
    name: 'private current company',
  });
  await f.owner.query(
    `UPDATE ${table('person')} SET "companyId"=$1 WHERE id=$2`,
    [companyId, seed.personId],
  );
  const opportunityId = await insert('opportunity', {
    name: 'private current opportunity',
    pointOfContactId: seed.personId,
    companyId,
  });
  await f.owner.query(
    `DELETE FROM ${table(TARGET)} WHERE "messageThreadId"=$1`,
    [seed.email.threadId],
  );
  f.eventEmitter.mockClear();
  return { ...seed, companyId, opportunityId };
};
type Seed = Awaited<ReturnType<typeof seedSources>>;
const currentTargets = (threadId: string) =>
  f.owner.query(
    `SELECT * FROM ${table(TARGET)} WHERE "messageThreadId"=$1 ORDER BY id`,
    [threadId],
  );
const graphIdentities = (targets: Record<string, unknown>[]) =>
  targets.map((row) => ({
    person: row.targetPersonId,
    company: row.targetCompanyId,
    opportunity: row.targetOpportunityId,
    automatic: row.isAutomaticallyAssigned,
    manual: row.isManuallyAssigned,
  }));
const desiredIdentities = (seed: Seed) => [
  {
    person: seed.personId,
    company: null,
    opportunity: null,
    automatic: true,
    manual: false,
  },
  {
    person: null,
    company: seed.companyId,
    opportunity: null,
    automatic: true,
    manual: false,
  },
  {
    person: null,
    company: null,
    opportunity: seed.opportunityId,
    automatic: true,
    manual: false,
  },
];
beforeAll(() => f.initialize());
beforeEach(async () => {
  await f.owner.query(`DROP TRIGGER IF EXISTS target_test ON ${table(TARGET)}`);
  await f.owner.query(
    'DROP TRIGGER IF EXISTS target_audit_test ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".target_test()`,
  );
  await f.owner.query(`DROP TABLE IF EXISTS ${table('target_extra')}`);
  await f.reset();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it('derives Person/Company/Opportunity targets from actual live sources, audits creates, and leaves source rows unchanged', async () => {
  const seed = await seedSources(),
    before = await sources();
  const result = await reconcile([seed.email.threadId]);
  const targets = await currentTargets(seed.email.threadId);
  expect(targets).toHaveLength(3);
  expect(graphIdentities(targets)).toEqual(
    expect.arrayContaining(desiredIdentities(seed)),
  );
  expect(result).toEqual({
    createdTargetIds: targets.map((row: { id: string }) => row.id).sort(),
    updatedTargetIds: [],
    deletedTargetIds: [],
  });
  expect(await sources()).toEqual(before);
  const entries = await audit();
  expect(entries).toHaveLength(3);
  for (const row of entries)
    expect(row).toMatchObject({
      action: 'create',
      resourceKind: 'crmRecord',
      actor: operation().actor,
      securityDescriptor: {
        resourceKind: 'crmRecord',
        resourceId: row.resourceId,
        objectMetadataId: expect.any(String),
      },
    });
  expect(JSON.stringify(entries)).not.toContain('private current');
  f.eventEmitter.mockClear();
  expect(await reconcile([seed.email.threadId])).toEqual(emptyResult());
  expect(await audit()).toEqual(entries);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('preserves manual and tombstone policy while auditing only actual automatic-flag changes and obsolete deletions', async () => {
  const seed = await seedSources();
  const oldPeople: string[] = [];
  for (let i = 0; i < 4; i++)
    oldPeople.push(
      await insert('person', {
        name: { firstName: 'Old', lastName: String(i) },
      }),
    );
  const desiredManual = await target(seed.email.threadId, {
    targetPersonId: seed.personId,
    isAutomaticallyAssigned: false,
    isManuallyAssigned: true,
  });
  const tombstone = await target(seed.email.threadId, {
    targetCompanyId: seed.companyId,
    deletedAt: new Date(),
  });
  const oldBoth = await target(seed.email.threadId, {
    targetPersonId: oldPeople[0],
    isManuallyAssigned: true,
  });
  const oldManual = await target(seed.email.threadId, {
    targetPersonId: oldPeople[1],
    isAutomaticallyAssigned: false,
    isManuallyAssigned: true,
  });
  const oldAuto = await target(seed.email.threadId, {
    targetPersonId: oldPeople[2],
  });
  const oldNeither = await target(seed.email.threadId, {
    targetPersonId: oldPeople[3],
    isAutomaticallyAssigned: false,
  });
  const before = await currentTargets(seed.email.threadId);
  const result = await reconcile([seed.email.threadId]);
  const after = await currentTargets(seed.email.threadId);
  const created = after.find(
    (row: { targetOpportunityId: string | null }) =>
      row.targetOpportunityId === seed.opportunityId,
  );
  expect(created).toBeDefined();
  expect(result).toEqual({
    createdTargetIds: [created.id],
    updatedTargetIds: [desiredManual, oldBoth].sort(),
    deletedTargetIds: [oldAuto, oldNeither].sort(),
  });
  expect(
    after.find((row: { id: string }) => row.id === desiredManual),
  ).toMatchObject({ isAutomaticallyAssigned: true, isManuallyAssigned: true });
  expect(after.find((row: { id: string }) => row.id === oldBoth)).toMatchObject(
    { isAutomaticallyAssigned: false, isManuallyAssigned: true },
  );
  for (const id of [oldManual, tombstone])
    expect(after.find((row: { id: string }) => row.id === id)).toEqual(
      before.find((row: { id: string }) => row.id === id),
    );
  expect(
    after.filter(
      (row: { targetCompanyId: string | null }) =>
        row.targetCompanyId === seed.companyId,
    ),
  ).toHaveLength(1);
  expect(await audit()).toHaveLength(5);
});

it.each([
  'message',
  'messageParticipant',
  'person',
  'opportunity',
  'company',
] as const)(
  'preserves legacy source liveness semantics when %s is soft-deleted',
  async (name) => {
    const seed = await seedSources();
    const id =
      name === 'message'
        ? seed.email.messageId
        : name === 'messageParticipant'
          ? seed.email.participantId
          : name === 'person'
            ? seed.personId
            : name === 'opportunity'
              ? seed.opportunityId
              : seed.companyId;
    await f.owner.query(
      `UPDATE ${table(name)} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
      [id],
    );
    const result = await reconcile([seed.email.threadId]);
    const targets = await currentTargets(seed.email.threadId);
    // Company liveness is intentionally not filtered by legacy buildDesiredTargets.
    const expected =
      name === 'company'
        ? desiredIdentities(seed)
        : name === 'opportunity'
          ? desiredIdentities(seed).slice(0, 2)
          : [];
    expect(targets).toHaveLength(expected.length);
    expect(graphIdentities(targets)).toEqual(expect.arrayContaining(expected));
    expect(result.createdTargetIds).toHaveLength(expected.length);
    expect(await audit()).toHaveLength(expected.length);
  },
);

it('deduplicates shared sources and ignores null participant Person without inventing targets', async () => {
  const seed = await seedSources();
  await insert('messageParticipant', {
    messageId: seed.email.messageId,
    personId: seed.personId,
    role: 'TO',
    handle: 'duplicate@example.test',
    displayName: null,
  });
  await insert('messageParticipant', {
    messageId: seed.email.messageId,
    personId: null,
    role: 'CC',
    handle: null,
    displayName: null,
  });
  expect(
    (await reconcile([seed.email.threadId, seed.email.threadId]))
      .createdTargetIds,
  ).toHaveLength(3);
  expect(await currentTargets(seed.email.threadId)).toHaveLength(3);
  expect(await audit()).toHaveLength(3);
});

it('retains the protected thread projection while reconciling an ordinary thread in the same batch', async () => {
  const seed = await seedSources(),
    before = await currentTargets(seed.omni.threadId);
  expect(
    (await reconcile([seed.omni.threadId, seed.email.threadId]))
      .createdTargetIds,
  ).toHaveLength(3);
  expect(await currentTargets(seed.omni.threadId)).toEqual(before);
  expect(await audit()).toHaveLength(3);
});

it.each(['INSERT', 'UPDATE', 'DELETE'] as const)(
  'does not claim or audit trigger-skipped target %s effects',
  async (action) => {
    const seed = await seedSources();
    if (action === 'UPDATE') {
      for (const fields of [
        { targetPersonId: seed.personId },
        { targetCompanyId: seed.companyId },
        { targetOpportunityId: seed.opportunityId },
      ])
        await target(seed.email.threadId, {
          ...fields,
          isAutomaticallyAssigned: false,
          isManuallyAssigned: true,
        });
    } else if (action === 'DELETE') {
      await f.owner.query(
        `UPDATE ${table('messageParticipant')} SET "personId"=NULL WHERE id=$1`,
        [seed.email.participantId],
      );
      await target(seed.email.threadId, { targetPersonId: seed.personId });
    }
    const before = await rows(TARGET);
    await f.owner
      .query(`CREATE FUNCTION "${f.schemaName}".target_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER target_test BEFORE ${action} ON ${table(TARGET)} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".target_test()`);
    expect(await reconcile([seed.email.threadId])).toEqual(emptyResult());
    expect(await rows(TARGET)).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it('rejects an alternate row inserted by a real INSERT-conflict trigger instead of fabricating a create audit', async () => {
  const seed = await seedSources(),
    before = await rows(TARGET);
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".target_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    IF pg_trigger_depth()=1 THEN
      INSERT INTO ${table(TARGET)} SELECT * FROM jsonb_populate_record(NULL::${table(TARGET)}, to_jsonb(NEW)||jsonb_build_object('id',gen_random_uuid()));
    END IF; RETURN NEW; END $$;
    CREATE TRIGGER target_test BEFORE INSERT ON ${table(TARGET)} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".target_test()`);
  await expect(reconcile([seed.email.threadId])).rejects.toThrow();
  expect(await rows(TARGET)).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('rolls back all target mutations if audit insertion is refused', async () => {
  const seed = await seedSources(),
    before = await rows(TARGET);
  await f.owner.query(
    `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${f.roleName}"`,
  );
  try {
    await expect(reconcile([seed.email.threadId])).rejects.toThrow();
  } finally {
    await f.owner.query(
      `GRANT INSERT ON crm_audit."crmAuditEntry" TO "${f.roleName}"`,
    );
  }
  expect(await rows(TARGET)).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('rolls back late Conversation ownership introduced during audit flush', async () => {
  const seed = await seedSources(),
    before = await rows(TARGET),
    conversationId = randomUUID();
  const [source] = await f.owner.query(
    'SELECT (to_jsonb(row)||$2::jsonb)::text AS snapshot FROM core."omniConversation" row WHERE "messageThreadId"=$1',
    [
      seed.markerThreadId,
      JSON.stringify({
        id: conversationId,
        messageThreadId: seed.email.threadId,
        providerChatId: randomUUID(),
      }),
    ],
  );
  expect(source).toBeDefined();
  const literal = source.snapshot.replaceAll("'", "''");
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".target_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    INSERT INTO core."omniConversation" SELECT * FROM jsonb_populate_record(NULL::core."omniConversation", '${literal}'::jsonb) ON CONFLICT DO NOTHING;
    RETURN NEW; END $$;
    CREATE TRIGGER target_audit_test AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".target_test()`);
  await expect(reconcile([seed.email.threadId])).rejects.toThrow(/ownership/);
  expect(await rows(TARGET)).toEqual(before);
  expect(
    await f.owner.query('SELECT id FROM core."omniConversation" WHERE id=$1', [
      conversationId,
    ]),
  ).toEqual([]);
  expect(await audit()).toEqual([]);
});

it('drains a deferred target DELETE resurrection and rejects its effects before commit', async () => {
  const seed = await seedSources();
  await f.owner.query(
    `UPDATE ${table('messageParticipant')} SET "personId"=NULL WHERE id=$1`,
    [seed.email.participantId],
  );
  await target(seed.email.threadId, { targetPersonId: seed.personId });
  const before = await rows(TARGET);
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".target_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    INSERT INTO ${table(TARGET)} SELECT OLD.*;
    RETURN OLD; END $$;
    CREATE CONSTRAINT TRIGGER target_test AFTER DELETE ON ${table(TARGET)} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".target_test()`);
  await expect(reconcile([seed.email.threadId])).rejects.toThrow(
    /effects mismatch/,
  );
  expect(await rows(TARGET)).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('rejects populated unknown incoming target CASCADE instead of deleting an unaudited dependent', async () => {
  const seed = await seedSources();
  await f.owner.query(
    `UPDATE ${table('messageParticipant')} SET "personId"=NULL WHERE id=$1`,
    [seed.email.participantId],
  );
  const targetId = await target(seed.email.threadId, {
      targetPersonId: seed.personId,
    }),
    before = await rows(TARGET);
  await f.owner.query(
    `CREATE TABLE ${table('target_extra')} (parent uuid REFERENCES ${table(TARGET)}(id) ON DELETE CASCADE); GRANT SELECT ON ${table('target_extra')} TO "${f.roleName}"`,
  );
  await f.owner.query(`INSERT INTO ${table('target_extra')} VALUES($1)`, [
    targetId,
  ]);
  await expect(reconcile([seed.email.threadId])).rejects.toThrow();
  expect(await rows(TARGET)).toEqual(before);
  expect(
    await f.owner.query(`SELECT parent FROM ${table('target_extra')}`),
  ).toEqual([{ parent: targetId }]);
  expect(await audit()).toEqual([]);
});

it('preserves committed targets and audit after actual COMMIT acknowledgement loss', async () => {
  const seed = await seedSources();
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
      throw new Error('lost target reconciliation COMMIT acknowledgement');
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await expect(reconcile([seed.email.threadId])).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(statements).not.toContain('ROLLBACK');
  expect(await currentTargets(seed.email.threadId)).toHaveLength(3);
  expect(await audit()).toHaveLength(3);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('requires the Opportunity-to-Person FK that fences new source insertions', async () => {
  const seed = await seedSources(),
    before = await rows(TARGET);
  const constraints = await f.owner.query(
    `SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE contype='f' AND conrelid=$1::regclass AND confrelid=$2::regclass`,
    [table('opportunity'), table('person')],
  );
  expect(constraints).toHaveLength(1);
  const constraint = constraints[0],
    quotedName = '"' + constraint.name.replaceAll('"', '""') + '"';
  await f.owner.query(
    `ALTER TABLE ${table('opportunity')} DROP CONSTRAINT ${quotedName}`,
  );
  try {
    await expect(reconcile([seed.email.threadId])).rejects.toThrow(
      /expected foreign keys/,
    );
    expect(await rows(TARGET)).toEqual(before);
    expect(await audit()).toEqual([]);
  } finally {
    await f.owner.query(
      `ALTER TABLE ${table('opportunity')} ADD CONSTRAINT ${quotedName} ${constraint.definition}`,
    );
  }
});

it.each(['foreign-operation', 'shared-scope', 'too-many'] as const)(
  'refuses %s authority/input without effects',
  async (kind) => {
    const seed = await seedSources(),
      before = await rows(TARGET);
    const work =
      kind === 'shared-scope'
        ? f.withContext(() =>
            f.dataSource.transaction(
              (scope) =>
                reconcileNativeMessageThreadTargetsWithAudit({
                  scope,
                  candidateThreadIds: [seed.email.threadId],
                  operation: operation(),
                }),
              { commitOutcome: 'strict' },
            ),
          )
        : kind === 'foreign-operation'
          ? reconcile([seed.email.threadId], {
              ...operation(),
              workspaceId: randomUUID(),
            })
          : reconcile(Array.from({ length: 501 }, () => randomUUID()));
    await expect(work).rejects.toThrow();
    expect(await rows(TARGET)).toEqual(before);
    expect(await audit()).toEqual([]);
  },
);

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
  throw new Error('Expected exact target-source PostgreSQL lock wait');
};
const closeWriter = async (writer: QueryRunner) => {
  if (writer.isTransactionActive) await writer.rollbackTransaction();
  if (!writer.isReleased) await writer.release();
};
const prepareOpportunityRace = async (seed: Seed) => {
  const writer = f.owner.createQueryRunner(),
    id = randomUUID();
  await writer.connect();
  const [backend] = await writer.query('SELECT pg_backend_pid() AS pid');
  const write = () =>
    writer.query(
      `INSERT INTO ${table('opportunity')} (id,name,"pointOfContactId","companyId") VALUES($1,'concurrent private opportunity',$2,$3)`,
      [id, seed.personId, seed.companyId],
    );
  return { writer, id, writerPid: backend.pid as number, write };
};

it('refuses a real incoming composite ON UPDATE cascade when automatic assignment changes', async () => {
  const seed = await seedSources();
  const targetId = await target(seed.email.threadId, {
    targetPersonId: seed.personId,
    isAutomaticallyAssigned: false,
    isManuallyAssigned: true,
  });
  await f.owner.query(
    `ALTER TABLE ${table(TARGET)} ADD CONSTRAINT target_flag_test_unique UNIQUE(id,"isAutomaticallyAssigned")`,
  );
  try {
    await f.owner
      .query(`CREATE TABLE ${table('target_extra')} (parent uuid, automatic boolean,
      FOREIGN KEY(parent,automatic) REFERENCES ${table(TARGET)}(id,"isAutomaticallyAssigned") ON UPDATE CASCADE);
      GRANT SELECT ON ${table('target_extra')} TO "${f.roleName}"`);
    await f.owner.query(
      `INSERT INTO ${table('target_extra')} VALUES($1,false)`,
      [targetId],
    );
    const before = await rows(TARGET),
      beforeSources = await sources();
    await expect(reconcile([seed.email.threadId])).rejects.toThrow(
      /referential UPDATE effects/,
    );
    expect(await rows(TARGET)).toEqual(before);
    expect(await sources()).toEqual(beforeSources);
    expect(
      await f.owner.query(
        `SELECT parent,automatic FROM ${table('target_extra')}`,
      ),
    ).toEqual([{ parent: targetId, automatic: false }]);
    expect(await audit()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  } finally {
    await f.owner.query(`DROP TABLE IF EXISTS ${table('target_extra')}`);
    await f.owner.query(
      `ALTER TABLE ${table(TARGET)} DROP CONSTRAINT target_flag_test_unique`,
    );
  }
});

it('allows automatic assignment with an incoming ON UPDATE cascade that references only unchanged id', async () => {
  const seed = await seedSources();
  const targetId = await target(seed.email.threadId, {
    targetPersonId: seed.personId,
    isAutomaticallyAssigned: false,
    isManuallyAssigned: true,
  });
  await f.owner
    .query(`CREATE TABLE ${table('target_extra')} (parent uuid REFERENCES ${table(TARGET)}(id) ON UPDATE CASCADE);
    GRANT SELECT ON ${table('target_extra')} TO "${f.roleName}"`);
  await f.owner.query(`INSERT INTO ${table('target_extra')} VALUES($1)`, [
    targetId,
  ]);
  const result = await reconcile([seed.email.threadId]);
  expect(result.updatedTargetIds).toEqual([targetId]);
  expect(result.createdTargetIds).toHaveLength(2);
  expect(result.deletedTargetIds).toEqual([]);
  expect(
    await f.owner.query(`SELECT parent FROM ${table('target_extra')}`),
  ).toEqual([{ parent: targetId }]);
  expect(
    (await currentTargets(seed.email.threadId)).find(
      (row: { id: string }) => row.id === targetId,
    ),
  ).toMatchObject({ isAutomaticallyAssigned: true, isManuallyAssigned: true });
  expect(await audit()).toHaveLength(3);
});

it('holds Company FOR SHARE until commit and blocks a real Company update', async () => {
  const seed = await seedSources();
  const writer = f.owner.createQueryRunner();
  await writer.connect();
  const [backend] = await writer.query('SELECT pg_backend_pid() AS pid');
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
      text.includes('FROM ' + table('company')) &&
      text.includes('FOR SHARE')
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
  const work = capture(reconcile([seed.email.threadId]));
  let mutation: ReturnType<typeof capture> | undefined;
  try {
    await Promise.race([
      reached.promise,
      work.then(() => {
        throw new Error('Reconciliation settled before Company source lock');
      }),
    ]);
    mutation = capture(
      writer.query(
        `UPDATE ${table('company')} SET name='later company name' WHERE id=$1`,
        [seed.companyId],
      ),
    );
    await waitForBlocker(backend.pid, nativePid);
    resume.release();
    const outcome = await work;
    if (!outcome.ok) throw outcome.error;
    expect(outcome.value.createdTargetIds).toHaveLength(3);
    const changed = await mutation;
    if (!changed.ok) throw changed.error;
    expect(await currentTargets(seed.email.threadId)).toHaveLength(3);
    expect(await audit()).toHaveLength(3);
    expect(
      await f.owner.query(`SELECT name FROM ${table('company')} WHERE id=$1`, [
        seed.companyId,
      ]),
    ).toEqual([{ name: 'later company name' }]);
  } finally {
    resume.release();
    await work;
    if (mutation) await mutation;
    await closeWriter(writer);
  }
});

it('includes a new Opportunity source whose FK lock commits before source locking', async () => {
  const seed = await seedSources(),
    race = await prepareOpportunityRace(seed);
  const client = await f.pool.connect();
  const nativePid = (await client.query('SELECT pg_backend_pid() AS pid'))
    .rows[0].pid as number;
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await race.writer.startTransaction();
  await race.write();
  const work = capture(reconcile([seed.email.threadId]));
  try {
    await waitForBlocker(nativePid, race.writerPid);
    await race.writer.commitTransaction();
    const outcome = await work;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw outcome.error;
    expect(outcome.value.createdTargetIds).toHaveLength(4);
    const targets = await currentTargets(seed.email.threadId);
    expect(targets).toHaveLength(4);
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetOpportunityId: race.id,
          isAutomaticallyAssigned: true,
        }),
      ]),
    );
    expect(await audit()).toHaveLength(4);
  } finally {
    await closeWriter(race.writer);
    await work;
  }
});

it('holds Person source locks until commit so later Opportunity insertion is handled by the next reconciliation', async () => {
  const seed = await seedSources(),
    race = await prepareOpportunityRace(seed);
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
      text.includes('FROM ' + table('person')) &&
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
  const work = capture(reconcile([seed.email.threadId]));
  let mutation: ReturnType<typeof capture> | undefined;
  try {
    await Promise.race([
      reached.promise,
      work.then(() => {
        throw new Error('Reconciliation settled before Person source lock');
      }),
    ]);
    mutation = capture(race.write());
    await waitForBlocker(race.writerPid, nativePid);
    resume.release();
    const outcome = await work;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw outcome.error;
    expect(outcome.value.createdTargetIds).toHaveLength(3);
    const mutationOutcome = await mutation;
    if (!mutationOutcome.ok) throw mutationOutcome.error;
    expect(mutationOutcome.ok).toBe(true);
    expect(await currentTargets(seed.email.threadId)).toHaveLength(3);
    expect(await audit()).toHaveLength(3);
    const next = await reconcile([seed.email.threadId]);
    expect(next.createdTargetIds).toHaveLength(1);
    expect(await currentTargets(seed.email.threadId)).toHaveLength(4);
    expect(await audit()).toHaveLength(4);
  } finally {
    resume.release();
    await work;
    if (mutation) await mutation;
    await closeWriter(race.writer);
  }
});
