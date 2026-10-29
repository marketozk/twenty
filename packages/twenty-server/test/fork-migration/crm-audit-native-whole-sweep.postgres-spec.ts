import { randomUUID } from 'node:crypto';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { cleanOrphanNativeMessagesAndThreadsWithAudit } from 'src/engine/core-modules/crm-audit/native-message-cleanup-with-audit';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import * as reconciliationPolicy from 'src/modules/match-participant/utils/compute-target-reconciliation-operations.util';
import { createOmniNativeCleanupFixture } from 'test/fork-migration/omni-native-cleanup.fixture';

jest.mock(
  'src/modules/match-participant/utils/compute-target-reconciliation-operations.util',
  () => {
    const actual = jest.requireActual<
      typeof import('src/modules/match-participant/utils/compute-target-reconciliation-operations.util')
    >(
      'src/modules/match-participant/utils/compute-target-reconciliation-operations.util',
    );
    return {
      ...actual,
      computeTargetReconciliationOperations: jest.fn(
        actual.computeTargetReconciliationOperations,
      ),
    };
  },
);

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
const table = (name: string) => `"${f.schemaName}"."${name}"`;
const operation = (): CrmAuditOperation => ({
  workspaceId: f.workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'system', id: 'MessagingMessageChannelDeletionCleanupJob' },
});
// The whole sweep owns the terminal transaction callback, including its single audit flush.
const sweep = async (auditOperation = operation()) =>
  f.withContext(() =>
    f.dataSource.transaction(
      (scope) =>
        cleanOrphanNativeMessagesAndThreadsWithAudit({
          scope,
          operation: auditOperation,
        }),
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
const emptyResult = () => ({
  deletedMessageIds: [],
  affectedThreadIds: [],
  deletedThreadIds: [],
  createdTargetIds: [],
  updatedTargetIds: [],
  deletedTargetIds: [],
});
const audit = () =>
  f.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "resourceId"',
  );
const present = async (name: string, id: string) =>
  (await f.owner.query(`SELECT id FROM ${table(name)} WHERE id=$1`, [id]))
    .length === 1;
const snapshot = async () => {
  const snapshots: unknown[] = [];
  for (const name of [
    'messageThread',
    'message',
    'messageParticipant',
    'messageThreadTarget',
    'messageChannelMessageAssociation',
    'messageChannelMessageAssociationMessageFolder',
    'person',
    'company',
    'opportunity',
  ])
    snapshots.push(
      await f.owner.query(
        `SELECT to_jsonb(row)::text AS row FROM ${table(name)} row ORDER BY id`,
      ),
    );
  return snapshots;
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
const message = (threadId: string) =>
  insert('message', {
    messageThreadId: threadId,
    headerMessageId: randomUUID(),
    text: 'ordinary sweep body',
    receivedAt: new Date(),
    isDraft: false,
  });
const target = (threadId: string, personId: string) =>
  insert('messageThreadTarget', {
    messageThreadId: threadId,
    targetPersonId: personId,
    isAutomaticallyAssigned: true,
    isManuallyAssigned: false,
  });
const orphanSeed = async () => {
  const seed = await f.seed('conversation');
  await f.owner.query(
    `DELETE FROM ${table('messageChannelMessageAssociation')} WHERE id=$1`,
    [seed.email.associationId],
  );
  f.eventEmitter.mockClear();
  return seed;
};
const mixedSeed = async () => {
  const seed = await f.seed('conversation');
  // email's original Message remains associated, so the thread survives.
  const oldPersonId = await insert('person', {
    name: { firstName: 'Old', lastName: 'Participant' },
  });
  const orphanId = await message(seed.email.threadId);
  const participantId = await insert('messageParticipant', {
    messageId: orphanId,
    personId: oldPersonId,
    role: 'FROM',
    handle: null,
    displayName: null,
  });
  const obsoleteTargetId = await target(seed.email.threadId, oldPersonId);
  const emptyThreadId = await insert('messageThread', {
    subject: 'ordinary empty thread',
  });
  const emptyTargetId = await target(emptyThreadId, seed.personId);
  return {
    ...seed,
    orphanId,
    participantId,
    obsoleteTargetId,
    emptyThreadId,
    emptyTargetId,
  };
};

beforeAll(() => f.initialize());
beforeEach(async () => {
  await f.owner.query(
    `DROP TRIGGER IF EXISTS sweep_test ON ${table('message')}`,
  );
  await f.owner.query(
    `DROP TRIGGER IF EXISTS sweep_test ON ${table('messageThread')}`,
  );
  await f.owner.query(
    'DROP TRIGGER IF EXISTS sweep_audit_test ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query(`DROP FUNCTION IF EXISTS "${f.schemaName}".sweep_test()`);
  await f.reset();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it('commits orphan messages, surviving-thread reconciliation, and empty-thread cleanup in one audit operation', async () => {
  const seed = await mixedSeed();
  const supplied = operation();
  const result = await sweep(supplied);
  expect(result.deletedMessageIds).toEqual([seed.orphanId]);
  expect(result.affectedThreadIds).toEqual([seed.email.threadId]);
  expect(result.deletedThreadIds).toEqual([seed.emptyThreadId]);
  expect(result.createdTargetIds).toEqual([]);
  expect(result.updatedTargetIds).toEqual([]);
  expect(result.deletedTargetIds).toEqual(
    [seed.obsoleteTargetId, seed.emptyTargetId].sort(),
  );
  for (const [name, id] of [
    ['message', seed.orphanId],
    ['messageParticipant', seed.participantId],
    ['messageThreadTarget', seed.obsoleteTargetId],
    ['messageThread', seed.emptyThreadId],
    ['messageThreadTarget', seed.emptyTargetId],
  ])
    expect(await present(name, id)).toBe(false);
  for (const [name, id] of [
    ['message', seed.email.messageId],
    ['messageThread', seed.email.threadId],
    ['messageThreadTarget', seed.email.targetId],
    ['message', seed.omni.messageId],
    ['messageThread', seed.omni.threadId],
  ])
    expect(await present(name, id)).toBe(true);
  const entries = await audit();
  expect(entries).toHaveLength(5);
  expect(
    new Set(entries.map((row: { operationId: string }) => row.operationId))
      .size,
  ).toBe(1);
  expect(entries.map((row: { actor: unknown }) => row.actor)).toEqual(
    entries.map(() => supplied.actor),
  );
  f.eventEmitter.mockClear();
  expect(await sweep(supplied)).toEqual(emptyResult());
  expect(await audit()).toEqual(entries);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('keeps protected-only first Message and Thread pages from starving an ordinary later orphan', async () => {
  const seed = await orphanSeed();
  const protectedIds: string[] = Array.from(
    { length: 500 },
    (_, index) =>
      `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
  );
  await f.seedNative(async (scope) => {
    const options = { shouldBypassPermissionChecks: true } as const;
    await scope
      .getRepository('messageThread', options)
      .insert(
        protectedIds.map((id) => ({ id, subject: 'protected empty thread' })),
      );
    await scope.getRepository('message', options).insert(
      protectedIds.map((id) => ({
        id,
        messageThreadId: seed.omni.threadId,
        headerMessageId: randomUUID(),
        text: 'protected message',
        receivedAt: new Date(),
        isDraft: false,
      })),
    );
    await scope
      .getRepository('messageChannelMessageAssociation', options)
      .insert(
        protectedIds.map((id) => ({
          id: randomUUID(),
          messageId: id,
          messageChannelId: seed.protectedChannelId,
          messageExternalId: id,
          messageThreadExternalId: 'protected-page',
          direction: 'INCOMING',
          deletedAt: new Date(),
        })),
      );
  });
  await f.owner.query(
    `INSERT INTO core."omniConversation" (id,"workspaceId","bindingId","providerChatId","messageThreadId","policyId","policyVersion")
    SELECT gen_random_uuid(),$1,$2,thread::text,thread,$3,'0' FROM unnest($4::uuid[]) thread`,
    [f.workspaceId, seed.bindingId, seed.policyId, protectedIds],
  );
  for (const name of ['message', 'messageThread'])
    expect(
      (
        await f.owner.query(
          `SELECT id FROM ${table(name)} WHERE "deletedAt" IS NULL ORDER BY id LIMIT 500`,
        )
      ).map((row: { id: string }) => row.id),
    ).toEqual(protectedIds);
  f.eventEmitter.mockClear();
  const result = await sweep();
  expect(result.deletedMessageIds).toEqual([seed.email.messageId]);
  expect(result.deletedThreadIds).toEqual([seed.email.threadId]);
  for (const name of ['message', 'messageThread'])
    expect(
      await f.owner.query(
        `SELECT count(*)::int AS count FROM ${table(name)} WHERE id=ANY($1::uuid[])`,
        [protectedIds],
      ),
    ).toEqual([{ count: 500 }]);
  const entries = await audit();
  expect(entries).toHaveLength(4);
  expect(
    new Set(entries.map((row: { operationId: string }) => row.operationId))
      .size,
  ).toBe(1);
});

it('preserves one-pass semantics when an empty Thread cascade makes a Message in another thread newly orphaned', async () => {
  const seed = await f.seed('conversation');
  const emptyThreadId = await insert('messageThread', {
    subject: 'cross-thread association parent',
  });
  const emptyTargetId = await target(emptyThreadId, seed.personId);
  // The actual association FK parent differs from its Message's own Thread.
  await f.owner.query(
    `UPDATE ${table('messageChannelMessageAssociation')} SET "messageThreadId"=$1 WHERE id=$2`,
    [emptyThreadId, seed.email.associationId],
  );
  const retainedBefore = await f.owner.query(
    `SELECT to_jsonb(row)::text AS row FROM ${table('message')} row WHERE id=$1`,
    [seed.email.messageId],
  );
  const first = await sweep();
  expect(first).toEqual({
    ...emptyResult(),
    deletedThreadIds: [emptyThreadId],
    deletedTargetIds: [emptyTargetId],
  });
  expect(
    await f.owner.query(
      `SELECT to_jsonb(row)::text AS row FROM ${table('message')} row WHERE id=$1`,
      [seed.email.messageId],
    ),
  ).toEqual(retainedBefore);
  for (const [name, id] of [
    ['messageParticipant', seed.email.participantId],
    ['messageThread', seed.email.threadId],
    ['messageThreadTarget', seed.email.targetId],
  ])
    expect(await present(name, id)).toBe(true);
  for (const [name, id] of [
    ['messageThread', emptyThreadId],
    ['messageThreadTarget', emptyTargetId],
    ['messageChannelMessageAssociation', seed.email.associationId],
    ['messageChannelMessageAssociationMessageFolder', seed.email.junctionId],
  ])
    expect(await present(name, id)).toBe(false);
  const firstEntries = await audit();
  expect(firstEntries).toHaveLength(4);
  expect(
    firstEntries.map((row: { resourceId: string }) => row.resourceId).sort(),
  ).toEqual(
    [
      emptyThreadId,
      emptyTargetId,
      seed.email.associationId,
      seed.email.junctionId,
    ].sort(),
  );
  const firstOperationIds = new Set(
    firstEntries.map((row: { operationId: string }) => row.operationId),
  );
  expect(firstOperationIds.size).toBe(1);

  const second = await sweep();
  expect(second).toEqual({
    ...emptyResult(),
    deletedMessageIds: [seed.email.messageId],
    affectedThreadIds: [seed.email.threadId],
    deletedThreadIds: [seed.email.threadId],
    deletedTargetIds: [seed.email.targetId],
  });
  for (const [name, id] of [
    ['message', seed.email.messageId],
    ['messageParticipant', seed.email.participantId],
    ['messageThread', seed.email.threadId],
    ['messageThreadTarget', seed.email.targetId],
  ])
    expect(await present(name, id)).toBe(false);
  const entries = await audit();
  expect(entries).toHaveLength(8);
  const secondEntries = entries.filter(
    (row: { operationId: string }) => !firstOperationIds.has(row.operationId),
  );
  expect(secondEntries).toHaveLength(4);
  expect(
    new Set(
      secondEntries.map((row: { operationId: string }) => row.operationId),
    ).size,
  ).toBe(1);
  expect(
    secondEntries.map((row: { resourceId: string }) => row.resourceId).sort(),
  ).toEqual(
    [
      seed.email.messageId,
      seed.email.participantId,
      seed.email.threadId,
      seed.email.targetId,
    ].sort(),
  );
  expect(await present('message', seed.omni.messageId)).toBe(true);
  expect(await sweep()).toEqual(emptyResult());
  expect(await audit()).toEqual(entries);
});

it('collects actual affected threads across more than 500 messages and reconciles each surviving thread once', async () => {
  const seed = await f.seed('conversation');
  const oldPersonId = await insert('person', {
    name: { firstName: 'Obsolete', lastName: 'Only' },
  });
  const obsoleteTargetId = await target(seed.email.threadId, oldPersonId);
  const messageIds: string[] = Array.from({ length: 501 }, () => randomUUID());
  await f.seedNative((scope) =>
    scope
      .getRepository('message', { shouldBypassPermissionChecks: true })
      .insert(
        messageIds.map((id) => ({
          id,
          messageThreadId: seed.email.threadId,
          headerMessageId: randomUUID(),
          text: 'page orphan',
          receivedAt: new Date(),
          isDraft: false,
        })),
      ),
  );
  f.eventEmitter.mockClear();
  // Spy preserves the real policy; it only observes per-thread reconciliation calls.
  const policy = jest.mocked(
    reconciliationPolicy.computeTargetReconciliationOperations,
  );
  policy.mockClear();
  const result = await sweep();
  expect(result.deletedMessageIds).toEqual([...messageIds].sort());
  expect(result.affectedThreadIds).toEqual([seed.email.threadId]);
  expect(result.deletedThreadIds).toEqual([]);
  expect(result.deletedTargetIds).toEqual([obsoleteTargetId]);
  const containingThread = policy.mock.calls.filter(([args]) =>
    [...args.existingTargets, ...args.desiredTargets].some(
      (entry) => entry.parentId === seed.email.threadId,
    ),
  );
  expect(containingThread).toHaveLength(1);
  const entries = await audit();
  expect(entries).toHaveLength(502);
  expect(
    new Set(entries.map((row: { operationId: string }) => row.operationId))
      .size,
  ).toBe(1);
  expect(await present('message', seed.email.messageId)).toBe(true);
  expect(await present('messageThread', seed.email.threadId)).toBe(true);
});

it('creates more than 200 desired targets across target pages in one operation without changing surviving sources', async () => {
  const seed = await f.seed('conversation');
  const orphanId = await message(seed.email.threadId);
  const opportunityIds: string[] = Array.from({ length: 201 }, () =>
    randomUUID(),
  );
  await f.owner.query(
    `INSERT INTO ${table('opportunity')} (id,name,"pointOfContactId")
    SELECT id,'paged opportunity', $1::uuid FROM unnest($2::uuid[]) id`,
    [seed.personId, opportunityIds],
  );
  const retainedSources = async () => {
    const result: unknown[] = [];
    for (const name of [
      'messageThread',
      'messageParticipant',
      'person',
      'company',
      'opportunity',
    ])
      result.push(
        await f.owner.query(
          `SELECT to_jsonb(row)::text AS row FROM ${table(name)} row ORDER BY id`,
        ),
      );
    result.push(
      await f.owner.query(
        `SELECT to_jsonb(row)::text AS row FROM ${table('message')} row WHERE id<>$1 ORDER BY id`,
        [orphanId],
      ),
    );
    return result;
  };
  const beforeSources = await retainedSources();
  const existingTarget = await f.owner.query(
    `SELECT to_jsonb(row)::text AS row FROM ${table('messageThreadTarget')} row WHERE id=$1`,
    [seed.email.targetId],
  );
  const result = await sweep();
  expect(result.deletedMessageIds).toEqual([orphanId]);
  expect(result.affectedThreadIds).toEqual([seed.email.threadId]);
  expect(result.deletedThreadIds).toEqual([]);
  expect(result.createdTargetIds).toHaveLength(201);
  expect(new Set(result.createdTargetIds).size).toBe(201);
  expect(result.updatedTargetIds).toEqual([]);
  expect(result.deletedTargetIds).toEqual([]);
  const targets = await f.owner.query(
    `SELECT id,"targetOpportunityId" FROM ${table('messageThreadTarget')} WHERE "messageThreadId"=$1 ORDER BY id`,
    [seed.email.threadId],
  );
  expect(targets).toHaveLength(202); // One existing Person target plus 201 new Opportunity targets.
  expect(
    targets
      .filter(
        (row: { targetOpportunityId: string | null }) =>
          row.targetOpportunityId !== null,
      )
      .map((row: { targetOpportunityId: string }) => row.targetOpportunityId)
      .sort(),
  ).toEqual([...opportunityIds].sort());
  expect(
    targets
      .filter((row: { id: string }) => row.id !== seed.email.targetId)
      .map((row: { id: string }) => row.id)
      .sort(),
  ).toEqual(result.createdTargetIds);
  expect(
    await f.owner.query(
      `SELECT to_jsonb(row)::text AS row FROM ${table('messageThreadTarget')} row WHERE id=$1`,
      [seed.email.targetId],
    ),
  ).toEqual(existingTarget);
  expect(await retainedSources()).toEqual(beforeSources);
  const entries = await audit();
  expect(entries).toHaveLength(202); // One actual Message delete plus 201 target creates.
  expect(
    entries.filter((row: { action: string }) => row.action === 'create'),
  ).toHaveLength(201);
  expect(
    new Set(entries.map((row: { operationId: string }) => row.operationId))
      .size,
  ).toBe(1);
}, 20000);

it('rolls back an actually deleted first Message page when the second page DELETE fails', async () => {
  const seed = await f.seed('conversation');
  const messageIds: string[] = Array.from(
    { length: 501 },
    (_, index) =>
      `00000000-0000-4000-9000-${(index + 1).toString(16).padStart(12, '0')}`,
  );
  await f.seedNative((scope) =>
    scope
      .getRepository('message', { shouldBypassPermissionChecks: true })
      .insert(
        messageIds.map((id) => ({
          id,
          messageThreadId: seed.email.threadId,
          headerMessageId: randomUUID(),
          text: 'second-page rollback',
          receivedAt: new Date(),
          isDraft: false,
        })),
      ),
  );
  expect(
    (
      await f.owner.query(
        `SELECT id FROM ${table('message')} WHERE "deletedAt" IS NULL ORDER BY id LIMIT 500`,
      )
    ).map((row: { id: string }) => row.id),
  ).toEqual(messageIds.slice(0, 500));
  const before = await snapshot();
  f.eventEmitter.mockClear();
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".sweep_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.id='${messageIds[500]}'::uuid THEN RAISE EXCEPTION 'second Message page failure'; END IF; RETURN OLD; END $$;
    CREATE TRIGGER sweep_test BEFORE DELETE ON ${table('message')} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".sweep_test()`);
  const client = await f.pool.connect(),
    original = client.query.bind(client);
  let firstPageRemainder: number | undefined;
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const text = typeof statement === 'string' ? statement : statement.text;
    const result = await original(statement as string, values);
    if (
      firstPageRemainder === undefined &&
      text.includes('DELETE FROM ' + table('message'))
    ) {
      const observed = await original(
        `SELECT count(*)::int AS count FROM ${table('message')} WHERE id=ANY($1::uuid[])`,
        [messageIds.slice(0, 500)],
      );
      firstPageRemainder = observed.rows[0].count;
    }
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  const failure: unknown = await sweep().then(
    () => undefined,
    (error: unknown) => error,
  );
  const messages: string[] = [];
  let cause: unknown = failure;
  for (let depth = 0; depth < 6 && cause instanceof Error; depth++) {
    messages.push(cause.message);
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  expect(messages.join('\n')).toContain('second Message page failure');
  expect(firstPageRemainder).toBe(0); // Observed on the same connection before the later exception.
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
}, 20000);

it('rolls back earlier Message and target effects when the final empty-thread DELETE fails', async () => {
  const seed = await mixedSeed(),
    before = await snapshot();
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".sweep_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.id='${seed.emptyThreadId}'::uuid THEN RAISE EXCEPTION 'late sweep thread failure'; END IF; RETURN OLD; END $$;
    CREATE TRIGGER sweep_test BEFORE DELETE ON ${table('messageThread')} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".sweep_test()`);
  await expect(sweep()).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('rolls back every stage on the one final audit flush failure', async () => {
  await mixedSeed();
  const before = await snapshot();
  await f.owner.query(
    `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${f.roleName}"`,
  );
  try {
    await expect(sweep()).rejects.toThrow();
  } finally {
    await f.owner.query(
      `GRANT INSERT ON crm_audit."crmAuditEntry" TO "${f.roleName}"`,
    );
  }
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('drains deferred Message resurrection before final verification and rolls back the whole sweep', async () => {
  await mixedSeed();
  const before = await snapshot();
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".sweep_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    INSERT INTO ${table('message')} SELECT OLD.*; RETURN OLD; END $$;
    CREATE CONSTRAINT TRIGGER sweep_test AFTER DELETE ON ${table('message')} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".sweep_test()`);
  expect(
    await f.owner.query(
      `SELECT tgdeferrable,tginitdeferred FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname='sweep_test'`,
      [table('message')],
    ),
  ).toEqual([{ tgdeferrable: true, tginitdeferred: true }]);
  await expect(sweep()).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('rechecks retained ownership after the shared audit flush and rolls back all prior stages', async () => {
  const seed = await mixedSeed(),
    before = await snapshot(),
    conversationId = randomUUID();
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".sweep_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    INSERT INTO core."omniConversation" (id,"workspaceId","bindingId","providerChatId","messageThreadId","policyId","policyVersion")
      VALUES('${conversationId}','${f.workspaceId}','${seed.bindingId}','${conversationId}','${seed.email.threadId}','${seed.policyId}','0')
      ON CONFLICT(id) DO NOTHING;
    RETURN NEW; END $$;
    CREATE TRIGGER sweep_audit_test AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".sweep_test()`);
  await expect(sweep()).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(
    await f.owner.query('SELECT id FROM core."omniConversation" WHERE id=$1', [
      conversationId,
    ]),
  ).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it.each(['message', 'messageThread'] as const)(
  'rolls back when audit flush restores an excluded soft-deleted %s source',
  async (name) => {
    const seed = await f.seed('conversation');
    const excludedId =
      name === 'message' ? seed.email.messageId : seed.email.threadId;
    await f.owner.query(
      `UPDATE ${table(name)} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
      [excludedId],
    );
    // Its deletion guarantees a real audit flush even though the retained source
    // excludes this Thread from target reconciliation at the filtering boundary.
    const orphanId = await message(seed.email.threadId);
    const before = await snapshot();
    expect(await present('message', orphanId)).toBe(true);
    await f.owner
      .query(`CREATE FUNCTION "${f.schemaName}".sweep_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    UPDATE ${table(name)} SET "deletedAt"=NULL WHERE id='${excludedId}'::uuid AND "deletedAt" IS NOT NULL;
    RETURN NEW; END $$;
    CREATE TRIGGER sweep_audit_test AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".sweep_test()`);
    await expect(sweep()).rejects.toThrow(
      'Native message cleanup retained filter sources changed',
    );
    expect(await snapshot()).toEqual(before);
    expect(await present('message', orphanId)).toBe(true);
    expect(await audit()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it('does not reconcile or delete a thread whose only orphan Message was trigger-skipped', async () => {
  const seed = await orphanSeed();
  const before = await snapshot();
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".sweep_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.id='${seed.email.messageId}'::uuid THEN RETURN NULL; END IF; RETURN OLD; END $$;
    CREATE TRIGGER sweep_test BEFORE DELETE ON ${table('message')} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".sweep_test()`);
  const policy = jest.mocked(
    reconciliationPolicy.computeTargetReconciliationOperations,
  );
  policy.mockClear();
  expect(await sweep()).toEqual(emptyResult());
  expect(policy).not.toHaveBeenCalled();
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('counts only actual Thread deletions when one empty root is skipped after its Message was removed', async () => {
  const seed = await orphanSeed();
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".sweep_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.id='${seed.email.threadId}'::uuid THEN RETURN NULL; END IF; RETURN OLD; END $$;
    CREATE TRIGGER sweep_test BEFORE DELETE ON ${table('messageThread')} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".sweep_test()`);
  const result = await sweep();
  expect(result.deletedMessageIds).toEqual([seed.email.messageId]);
  expect(result.affectedThreadIds).toEqual([seed.email.threadId]);
  expect(result.deletedThreadIds).toEqual([]);
  expect(result.deletedTargetIds).toEqual([]);
  expect(await present('messageThread', seed.email.threadId)).toBe(true);
  expect(await present('messageThreadTarget', seed.email.targetId)).toBe(true);
  expect(await audit()).toHaveLength(2);
});

it('rolls back when audit flush inserts a Message into an affected empty Thread retained by a skipped DELETE', async () => {
  const seed = await orphanSeed(),
    newMessageId = randomUUID(),
    before = await snapshot();
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".sweep_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    IF TG_TABLE_NAME='messageThread' THEN RETURN NULL; END IF;
    INSERT INTO ${table('message')} (id,"messageThreadId","headerMessageId",text,"receivedAt","isDraft")
      VALUES('${newMessageId}','${seed.email.threadId}','${newMessageId}','late source',clock_timestamp(),false)
      ON CONFLICT(id) DO NOTHING;
    RETURN NEW; END $$;
    CREATE TRIGGER sweep_test BEFORE DELETE ON ${table('messageThread')} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".sweep_test();
    CREATE TRIGGER sweep_audit_test AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".sweep_test()`);
  await expect(sweep()).rejects.toThrow(
    'Native message cleanup retained filter sources changed',
  );
  expect(await snapshot()).toEqual(before);
  expect(await present('message', newMessageId)).toBe(false);
  expect(await present('message', seed.email.messageId)).toBe(true);
  expect(await present('messageThread', seed.email.threadId)).toBe(true);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('retains tombstoned roots and Messages with even a soft-deleted association', async () => {
  const seed = await f.seed('conversation');
  await f.owner.query(
    `UPDATE ${table('messageChannelMessageAssociation')} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
    [seed.email.associationId],
  );
  const tombstonedThreadId = await insert('messageThread', {
    subject: 'tombstone',
    deletedAt: new Date(),
  });
  const tombstonedMessageId = await message(tombstonedThreadId);
  await f.owner.query(
    `UPDATE ${table('message')} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
    [tombstonedMessageId],
  );
  const before = await snapshot();
  expect(await sweep()).toEqual(emptyResult());
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
});

it('commits the full graph and single audit operation despite lost COMMIT ACK, without replaying after-commit events', async () => {
  const seed = await mixedSeed();
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
      throw new Error('lost whole-sweep COMMIT acknowledgement');
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await expect(sweep()).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(statements).not.toContain('ROLLBACK');
  expect(await present('message', seed.orphanId)).toBe(false);
  expect(await present('messageThread', seed.emptyThreadId)).toBe(false);
  const entries = await audit();
  expect(entries).toHaveLength(5);
  expect(
    new Set(entries.map((row: { operationId: string }) => row.operationId))
      .size,
  ).toBe(1);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it.each(['foreign-operation', 'shared-scope'] as const)(
  'refuses %s before any sweep effects',
  async (kind) => {
    await mixedSeed();
    const before = await snapshot();
    const work =
      kind === 'foreign-operation'
        ? sweep({ ...operation(), workspaceId: randomUUID() })
        : f.withContext(() =>
            f.dataSource.transaction(
              (scope) =>
                cleanOrphanNativeMessagesAndThreadsWithAudit({
                  scope,
                  operation: operation(),
                }),
              { commitOutcome: 'strict' },
            ),
          );
    await expect(work).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toEqual([]);
  },
);
