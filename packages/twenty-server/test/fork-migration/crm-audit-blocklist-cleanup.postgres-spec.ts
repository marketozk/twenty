import { randomUUID } from 'node:crypto';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { deleteOrdinaryBlocklistedMessageAssociationsWithAudit } from 'src/engine/core-modules/crm-audit/delete-ordinary-blocklisted-message-associations-with-audit';
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
const ROOT = 'messageChannelMessageAssociation',
  CHILD = 'messageChannelMessageAssociationMessageFolder';
const table = (name: string) => `"${f.schemaName}"."${name}"`;
const options = { shouldBypassPermissionChecks: true } as const;
const operation = (): CrmAuditOperation => ({
  workspaceId: f.workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'system', id: 'BlocklistItemDeleteMessagesJob' },
});
type Scope = Parameters<
  typeof deleteOrdinaryBlocklistedMessageAssociationsWithAudit
>[0]['scope'];
const execute = <T>(work: (scope: Scope) => Promise<T>) =>
  f.withContext(() =>
    f.dataSource.transaction(work, {
      commitOutcome: 'strict',
      nativeOwnershipLock: 'exclusive',
    }),
  );
const audit = () =>
  f.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "resourceId"',
  );
const snapshot = async () => {
  const rows: unknown[] = [];
  for (const name of [
    ROOT,
    CHILD,
    'message',
    'messageParticipant',
    'messageThread',
    'messageThreadTarget',
    'blocklist',
    'workspaceMember',
  ])
    rows.push(
      await f.owner.query(
        `SELECT to_jsonb(row)::text AS row FROM ${table(name)} row ORDER BY id`,
      ),
    );
  return rows;
};
const exists = async (name: string, id: string) =>
  (await f.owner.query(`SELECT id FROM ${table(name)} WHERE id=$1`, [id]))
    .length === 1;
const protectedRows = async (s: Seed) => {
  const rows: unknown[] = [];
  for (const [name, id] of [
    [ROOT, s.omni.associationId],
    [CHILD, s.omni.junctionId],
    ['message', s.omni.messageId],
    ['messageParticipant', s.omni.participantId],
    ['messageThread', s.omni.threadId],
    ['messageThreadTarget', s.omni.targetId],
  ])
    rows.push(
      await f.owner.query(
        `SELECT to_jsonb(row)::text AS row FROM ${table(name)} row WHERE id=$1`,
        [id],
      ),
    );
  return rows;
};
const insert = async (name: string, fields: Record<string, unknown>) => {
  const id = randomUUID();
  await f.seedNative((scope) =>
    scope.getRepository(name, options).insert({ id, ...fields }),
  );
  f.eventEmitter.mockClear();
  return id;
};
const seed = async (memberScoped = false) => {
  const graph = await f.seed('conversation');
  const userId = randomUUID(),
    userWorkspaceId = randomUUID();
  await f.owner.query(
    'INSERT INTO core."userWorkspace"(id,"userId","workspaceId") VALUES($1,$2,$3)',
    [userWorkspaceId, userId, f.workspaceId],
  );
  const workspaceMemberId = await insert('workspaceMember', {
    userId,
    name: { firstName: 'Blocklist', lastName: 'Owner' },
    userEmail: 'owner@example.test',
  });
  const accountId = await f.coreInsert('connectedAccount', {
    workspaceId: f.workspaceId,
    provider: 'google',
    userWorkspaceId,
    scope: 'USER',
    handleAliases: ['self-alias@example.test'],
  });
  await f.owner.query(
    'UPDATE core."messageChannel" SET "connectedAccountId"=$1,handle=$2 WHERE id=$3',
    [accountId, 'self@example.test', graph.channelId],
  );
  const ordinaryFolderId = await f.coreInsert('messageFolder', {
    workspaceId: f.workspaceId,
    messageChannelId: graph.channelId,
  });
  await f.owner.query(
    `UPDATE ${table(CHILD)} SET "messageFolderId"=$1 WHERE id=$2`,
    [ordinaryFolderId, graph.email.junctionId],
  );
  if (memberScoped)
    await f.owner.query(
      `UPDATE ${table('blocklist')} SET scope='WORKSPACE_MEMBER',"workspaceMemberId"=$1 WHERE id=$2`,
      [workspaceMemberId, graph.blocklistId],
    );
  return { ...graph, userId, userWorkspaceId, workspaceMemberId, accountId };
};
type Seed = Awaited<ReturnType<typeof seed>>;
const remove = async (
  s: Seed,
  candidates = [s.email.associationId],
  rules = [s.blocklistId],
) =>
  execute((scope) =>
    deleteOrdinaryBlocklistedMessageAssociationsWithAudit({
      scope,
      operation: operation(),
      messageChannelId: s.channelId,
      blocklistItemIds: rules,
      candidateAssociationIds: candidates,
    }),
  );
const triggerAudit = (body: string) =>
  f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".blocklist_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN ${body} RETURN NEW; END $$;
  CREATE TRIGGER blocklist_audit_test AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".blocklist_test()`);
const failureMessages = (error: unknown) => {
  const messages: string[] = [];
  for (let depth = 0; depth < 6 && error instanceof Error; depth++) {
    messages.push(error.message);
    error = error.cause;
  }
  return messages.join(' | ');
};

beforeAll(async () => {
  await f.initialize();
  await f.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid,ADD provider text,ADD "applicationId" uuid,ADD "connectionProviderId" uuid,ADD "userWorkspaceId" uuid,ADD scope text',
  );
  // Auth projection uses the real fields queried by the owner. Native member,
  // blocklist, Message and all cascade tables come from standard metadata.
  await f.owner.query(
    'CREATE TABLE core."userWorkspace"(id uuid PRIMARY KEY,"userId" uuid NOT NULL,"workspaceId" uuid NOT NULL REFERENCES core.workspace(id),"deletedAt" timestamptz)',
  );
  await f.owner.query(
    'CREATE UNIQUE INDEX blocklist_member_user_workspace ON core."userWorkspace"("userId","workspaceId") WHERE "deletedAt" IS NULL',
  );
  await f.owner.query(
    `GRANT SELECT,UPDATE ON core."connectedAccount",core."messageChannel",core."userWorkspace" TO "${f.roleName}"`,
  );
});
beforeEach(async () => {
  await f.owner.query(
    'DROP TRIGGER IF EXISTS blocklist_audit_test ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query(
    `DROP TRIGGER IF EXISTS blocklist_test ON ${table(ROOT)}`,
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".blocklist_test()`,
  );
  await f.reset();
  await f.owner.query('TRUNCATE core."userWorkspace"');
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it('commits actual association, junction and orphan graph under one operation while retaining mixed protected sources', async () => {
  const s = await seed();
  const protectedBefore = await protectedRows(s);
  const result = await remove(s, [s.omni.associationId, s.email.associationId]);
  expect(result?.primaryDeletedAssociationIds).toEqual([s.email.associationId]);
  expect(result?.deletedMessageIds).toEqual([s.email.messageId]);
  for (const [name, id] of [
    [ROOT, s.omni.associationId],
    [CHILD, s.omni.junctionId],
    ['message', s.omni.messageId],
    ['messageParticipant', s.omni.participantId],
    ['messageThread', s.omni.threadId],
    ['messageThreadTarget', s.omni.targetId],
  ])
    expect(await exists(name, id)).toBe(true);
  expect(await exists('message', s.email.messageId)).toBe(false);
  const entries = await audit();
  expect(entries).toHaveLength(6);
  expect(
    new Set(entries.map((row: { operationId: string }) => row.operationId))
      .size,
  ).toBe(1);
  expect(
    entries.every(
      (row: { actor: { kind: string; id: string } }) =>
        row.actor.kind === 'system' &&
        row.actor.id === 'BlocklistItemDeleteMessagesJob',
    ),
  ).toBe(true);
  expect(await protectedRows(s)).toEqual(protectedBefore);
});

it.each([
  [
    'exact case-sensitive',
    'Client@example.test',
    'client@example.test',
    'FROM',
    false,
  ],
  [
    'domain case-insensitive',
    '@EXAMPLE.TEST',
    'client@example.test',
    'FROM',
    true,
  ],
  ['subdomain TO', '@example.test', 'client@sub.example.test', 'TO', true],
  ['domain boundary', '@example.test', 'client@notexample.test', 'FROM', false],
  [
    'own channel excluded for domain',
    '@example.test',
    'self@example.test',
    'FROM',
    false,
  ],
  [
    'own alias excluded for domain',
    '@example.test',
    'self-alias@example.test',
    'TO',
    false,
  ],
  [
    'exact own alias still explicit',
    'self-alias@example.test',
    'self-alias@example.test',
    'FROM',
    true,
  ],
  ['CC excluded', 'client@example.test', 'client@example.test', 'CC', false],
  ['null rule ignored', null, 'client@example.test', 'FROM', false],
  ['empty exact handle', '', '', 'FROM', true],
] as const)(
  'preserves persisted policy: %s',
  async (_label, rule, handle, role, matches) => {
    const s = await seed();
    await f.owner.query(
      `UPDATE ${table('blocklist')} SET handle=$1 WHERE id=$2`,
      [rule, s.blocklistId],
    );
    await f.owner.query(
      `UPDATE ${table('messageParticipant')} SET handle=$1,role=$2 WHERE id=$3`,
      [handle, role, s.email.participantId],
    );
    const before = await snapshot(),
      result = await remove(s);
    expect(result?.primaryDeletedAssociationIds ?? []).toEqual(
      matches ? [s.email.associationId] : [],
    );
    if (!matches) {
      expect(await snapshot()).toEqual(before);
      expect(await audit()).toEqual([]);
      expect(f.eventEmitter).not.toHaveBeenCalled();
    } else expect(await exists('message', s.email.messageId)).toBe(false);
  },
);

it.each([null, ''])(
  'selects exact associations even with external ID %p',
  async (externalId) => {
    const s = await seed();
    await f.owner.query(
      `UPDATE ${table(ROOT)} SET "messageExternalId"=$1 WHERE id=$2`,
      [externalId, s.email.associationId],
    );
    expect((await remove(s))?.primaryDeletedAssociationIds).toEqual([
      s.email.associationId,
    ]);
    expect(await audit()).toHaveLength(6);
  },
);

it('does not expand matching external IDs to a different Message with an excluded sender', async () => {
  const s = await seed();
  const messageId = await insert('message', {
    messageThreadId: s.email.threadId,
  });
  await insert('messageParticipant', {
    messageId,
    role: 'FROM',
    handle: 'not-blocked@else.test',
  });
  const associationId = await insert(ROOT, {
    messageId,
    messageChannelId: s.channelId,
    messageExternalId: s.email.externalId,
  });
  expect(
    (await remove(s, [s.email.associationId, associationId]))
      ?.primaryDeletedAssociationIds,
  ).toEqual([s.email.associationId]);
  expect(await exists(ROOT, associationId)).toBe(true);
  expect(await exists('message', messageId)).toBe(true);
});

it.each([
  'participant-trashed',
  'association-trashed',
  'message-trashed',
] as const)('preserves soft deletion selection parity for %s', async (kind) => {
  const s = await seed();
  const [name, id] =
    kind === 'participant-trashed'
      ? ['messageParticipant', s.email.participantId]
      : kind === 'association-trashed'
        ? [ROOT, s.email.associationId]
        : ['message', s.email.messageId];
  await f.owner.query(
    `UPDATE ${table(name)} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
    [id],
  );
  const result = await remove(s);
  expect(result?.primaryDeletedAssociationIds ?? []).toEqual(
    kind === 'message-trashed' ? [s.email.associationId] : [],
  );
  // The orphan owner deliberately preserves a trashed Message even when its live association is removed.
  expect(await exists('message', s.email.messageId)).toBe(true);
});

it('applies member scope only to that current custodian, including a WORKSPACE-shared account', async () => {
  const s = await seed(true);
  await f.owner.query(
    'UPDATE core."connectedAccount" SET scope=$1 WHERE id=$2',
    ['WORKSPACE', s.accountId],
  );
  expect((await remove(s))?.primaryDeletedAssociationIds).toEqual([
    s.email.associationId,
  ]);
  expect(await audit()).toHaveLength(6);
});

it('keeps a current workspace rule applicable when an overlapping member rule no longer owns the account', async () => {
  const s = await seed(true);
  const workspaceRule = await insert('blocklist', {
    handle: 'client@example.test',
    scope: 'WORKSPACE',
  });
  await f.owner.query(
    'UPDATE core."connectedAccount" SET "userWorkspaceId"=$1 WHERE id=$2',
    [randomUUID(), s.accountId],
  );
  expect(
    (await remove(s, [s.email.associationId], [s.blocklistId, workspaceRule]))
      ?.primaryDeletedAssociationIds,
  ).toEqual([s.email.associationId]);
  expect(await audit()).toHaveLength(6);
});

it.each([
  'rule-deleted',
  'member-deleted',
  'member-rebound',
  'membership-deleted',
  'membership-foreign-workspace',
  'custodian-changed',
] as const)('declines stale member policy after %s', async (change) => {
  const s = await seed(true);
  if (change === 'rule-deleted')
    await f.owner.query(
      `UPDATE ${table('blocklist')} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
      [s.blocklistId],
    );
  else if (change === 'member-deleted')
    await f.owner.query(
      `UPDATE ${table('workspaceMember')} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
      [s.workspaceMemberId],
    );
  else if (change === 'member-rebound')
    await f.owner.query(
      `UPDATE ${table('workspaceMember')} SET "userId"=$1 WHERE id=$2`,
      [randomUUID(), s.workspaceMemberId],
    );
  else if (change === 'membership-deleted')
    await f.owner.query(
      'UPDATE core."userWorkspace" SET "deletedAt"=clock_timestamp() WHERE id=$1',
      [s.userWorkspaceId],
    );
  else if (change === 'membership-foreign-workspace') {
    const otherWorkspace = randomUUID();
    await f.owner.query('INSERT INTO core.workspace(id) VALUES($1)', [
      otherWorkspace,
    ]);
    await f.owner.query(
      'UPDATE core."userWorkspace" SET "workspaceId"=$1 WHERE id=$2',
      [otherWorkspace, s.userWorkspaceId],
    );
  } else
    await f.owner.query(
      'UPDATE core."connectedAccount" SET "userWorkspaceId"=$1,scope=$2 WHERE id=$3',
      [randomUUID(), 'WORKSPACE', s.accountId],
    );
  const before = await snapshot();
  expect(await remove(s)).toBeNull();
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it.each(['rule', 'alias', 'excluded-participant'] as const)(
  'rolls back when audit flush changes %s after qualification',
  async (change) => {
    const s = await seed();
    const messageId = await insert('message', {
      messageThreadId: s.email.threadId,
    });
    const participantId = await insert('messageParticipant', {
      messageId,
      role: 'FROM',
      handle: 'excluded@else.test',
    });
    const associationId = await insert(ROOT, {
      messageId,
      messageChannelId: s.channelId,
      messageExternalId: 'excluded',
    });
    const before = await snapshot();
    const [accountBefore] = await f.owner.query(
      'SELECT to_jsonb(row)::text AS row FROM core."connectedAccount" row WHERE id=$1',
      [s.accountId],
    );
    const mutation =
      change === 'rule'
        ? `UPDATE ${table('blocklist')} SET handle='different@else.test' WHERE id='${s.blocklistId}';`
        : change === 'alias'
          ? `UPDATE core."connectedAccount" SET "handleAliases"=ARRAY['changed@example.test'] WHERE id='${s.accountId}';`
          : `UPDATE ${table('messageParticipant')} SET handle='client@example.test' WHERE id='${participantId}';`;
    await triggerAudit(mutation);
    await expect(
      remove(s, [s.email.associationId, associationId]),
    ).rejects.toThrow(
      change === 'rule'
        ? 'Native blocklist cleanup policy sources changed'
        : change === 'alias'
          ? 'Native blocklist cleanup channel policy changed'
          : 'Native ordinary cleanup selection sources changed',
    );
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await f.owner.query(
          'SELECT to_jsonb(row)::text AS row FROM core."connectedAccount" row WHERE id=$1',
          [s.accountId],
        )
      )[0],
    ).toEqual(accountBefore);
    expect(await audit()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it('rolls back the entire native graph when the actual audit insert fails', async () => {
  const s = await seed(),
    before = await snapshot();
  await triggerAudit("RAISE EXCEPTION 'fixture blocklist audit failure';");
  const failure = await remove(s).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failureMessages(failure)).toContain('fixture blocklist audit failure');
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('uses actual RETURNING when a selected association DELETE is skipped', async () => {
  const s = await seed(),
    before = await snapshot();
  await f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".blocklist_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER blocklist_test BEFORE DELETE ON ${table(ROOT)} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".blocklist_test()`,
  );
  expect((await remove(s))?.primaryDeletedAssociationIds).toEqual([]);
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('captures rule and candidate arrays before the first owner await', async () => {
  const s = await seed();
  const rules = [s.blocklistId],
    candidates = [s.email.associationId];
  const result = await execute((scope) => {
    const work = deleteOrdinaryBlocklistedMessageAssociationsWithAudit({
      scope,
      operation: operation(),
      messageChannelId: s.channelId,
      blocklistItemIds: rules,
      candidateAssociationIds: candidates,
    });
    rules[0] = randomUUID();
    candidates[0] = s.omni.associationId;
    return work;
  });
  expect(result?.primaryDeletedAssociationIds).toEqual([s.email.associationId]);
  expect(await exists(ROOT, s.omni.associationId)).toBe(true);
});

it('reports real lost COMMIT acknowledgement without inventing rollback or repeating audit', async () => {
  const s = await seed();
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
      throw new Error('blocklist COMMIT ACK lost');
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await expect(remove(s)).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(await exists(ROOT, s.email.associationId)).toBe(false);
  expect(await audit()).toHaveLength(6);
  expect((await remove(s))?.primaryDeletedAssociationIds ?? []).toEqual([]);
  expect(await audit()).toHaveLength(6);
});

const waitForLock = async (queryFragment: string) => {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const rows = await f.owner.query(
      "SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1",
      ['%' + queryFragment + '%'],
    );
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected actual PostgreSQL lock wait: ' + queryFragment);
};

it('waits for a policy edit already holding its row lock and refuses the changed discovery snapshot', async () => {
  const s = await seed(),
    before = await snapshot();
  const writer = f.owner.createQueryRunner();
  await writer.connect();
  await writer.startTransaction();
  let work: Promise<unknown> | undefined;
  try {
    await writer.query(
      `UPDATE ${table('blocklist')} SET handle='no-longer-blocked@else.test' WHERE id=$1`,
      [s.blocklistId],
    );
    work = remove(s).then(
      () => undefined,
      (error: unknown) => error,
    );
    await waitForLock(table('blocklist'));
    await writer.commitTransaction();
    expect(failureMessages(await work)).toContain(
      'Native blocklist cleanup policy sources changed while locking',
    );
    expect(await exists(ROOT, s.email.associationId)).toBe(true);
    expect((await snapshot()).slice(0, 6)).toEqual(before.slice(0, 6));
    expect(await audit()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  } finally {
    if (writer.isTransactionActive) await writer.rollbackTransaction();
    await writer.release();
    if (work) await Promise.allSettled([work]);
  }
});

it('holds the qualified policy row through native commit and serializes a later policy edit', async () => {
  const s = await seed();
  const client = await f.pool.connect(),
    original = client.query.bind(client);
  let signal!: () => void,
    resume!: () => void,
    held = false;
  const reached = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const sql = typeof statement === 'string' ? statement : statement.text;
    const result = await original(statement as string, values);
    if (
      !held &&
      sql.includes(table('blocklist')) &&
      /FOR (UPDATE|SHARE)/.test(sql)
    ) {
      held = true;
      signal();
      await released;
    }
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  const work = remove(s);
  let update: Promise<unknown> | undefined;
  try {
    await Promise.race([
      reached,
      work.then(() => {
        throw new Error('Cleanup completed without locking the policy row');
      }),
    ]);
    const marker = 'blocklist-later-rule-' + randomUUID();
    update = f.owner.query(
      `/* ${marker} */ UPDATE ${table('blocklist')} SET handle='later@else.test' WHERE id=$1`,
      [s.blocklistId],
    );
    await waitForLock(marker);
    expect(await audit()).toEqual([]);
    expect(await exists(ROOT, s.email.associationId)).toBe(true);
  } finally {
    resume();
    await Promise.allSettled([work, ...(update ? [update] : [])]);
  }
  expect((await work)?.primaryDeletedAssociationIds).toEqual([
    s.email.associationId,
  ]);
  await update;
  expect(await audit()).toHaveLength(6);
  expect(
    (
      await f.owner.query(
        `SELECT handle FROM ${table('blocklist')} WHERE id=$1`,
        [s.blocklistId],
      )
    )[0].handle,
  ).toBe('later@else.test');
});
