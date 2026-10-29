import { randomUUID } from 'node:crypto';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { deleteOrdinarySyncMessageAssociationsWithAudit } from 'src/engine/core-modules/crm-audit/delete-ordinary-sync-message-associations-with-audit';
import { deleteOrdinaryGroupEmailMessageAssociationsWithAudit } from 'src/engine/core-modules/crm-audit/delete-ordinary-group-email-message-associations-with-audit';
import { deleteOrdinaryFolderMessagePageWithAudit } from 'src/engine/core-modules/crm-audit/delete-ordinary-folder-message-page-with-audit';
import { deleteSentDraftMessageWithAudit } from 'src/engine/core-modules/crm-audit/delete-sent-draft-message-with-audit';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
import { captureOrdinaryGroupEmailAction } from 'src/modules/omnichannel/services/ordinary-group-email-action';
import { captureOrdinaryFolderAction } from 'src/modules/omnichannel/services/ordinary-folder-action';
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
const operation = (): CrmAuditOperation => ({
  workspaceId: f.workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'system', id: 'MessagingMessageCleanerService' },
});
type Scope = Parameters<
  typeof deleteOrdinarySyncMessageAssociationsWithAudit
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
const present = async (name: string, id: string) =>
  (await f.owner.query(`SELECT id FROM ${table(name)} WHERE id=$1`, [id]))
    .length === 1;
const snapshot = async () => {
  const rows: unknown[] = [];
  for (const name of [
    ROOT,
    CHILD,
    'message',
    'messageParticipant',
    'messageThread',
    'messageThreadTarget',
  ])
    rows.push(
      await f.owner.query(
        `SELECT to_jsonb(row)::text AS row FROM ${table(name)} row ORDER BY id`,
      ),
    );
  return rows;
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
const seedBoundary = async () => {
  const seed = await f.seed('conversation');
  const userId = randomUUID(),
    userWorkspaceId = randomUUID();
  await f.owner.query('INSERT INTO core."user"(id) VALUES($1)', [userId]);
  await f.owner.query(
    'INSERT INTO core."userWorkspace"(id,"userId","workspaceId") VALUES($1,$2,$3)',
    [userWorkspaceId, userId, f.workspaceId],
  );
  const accountId = await f.coreInsert('connectedAccount', {
    workspaceId: f.workspaceId,
    provider: 'google',
    userWorkspaceId,
    scope: 'USER',
  });
  await f.owner.query(
    `UPDATE core."messageChannel" SET "connectedAccountId"=$2,"isSyncEnabled"=true,"syncStage"='MESSAGE_LIST_FETCH_ONGOING',"syncStageStartedAt"=clock_timestamp(),
    "pendingGroupEmailsAction"='GROUP_EMAILS_DELETION',"excludeGroupEmails"=true,"updatedAt"=clock_timestamp() WHERE id=$1`,
    [seed.channelId, accountId],
  );
  // Current run/action eligibility excludes derived ownership at account scope.
  await f.owner.query(
    `UPDATE ${table(ROOT)} SET "messageChannelId"=$1 WHERE id=$2`,
    [seed.protectedChannelId, seed.omni.associationId],
  );
  const folderId = await f.coreInsert('messageFolder', {
    workspaceId: f.workspaceId,
    messageChannelId: seed.channelId,
    pendingSyncAction: 'FOLDER_DELETION',
    isSynced: true,
    externalId: 'current-label',
    name: 'Current folder',
    parentFolderId: null,
  });
  await f.owner.query(
    `UPDATE ${table(CHILD)} SET "messageFolderId"=$1 WHERE id=$2`,
    [folderId, seed.email.junctionId],
  );
  const [channel] = await f.owner.query(
    `SELECT to_char("syncStageStartedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "startedAt" FROM core."messageChannel" WHERE id=$1`,
    [seed.channelId],
  );
  const expectedRun: OrdinaryMetadataSyncRun = {
    workspaceId: f.workspaceId,
    channelId: seed.channelId,
    connectedAccountId: accountId,
    kind: 'message',
    stage: 'MESSAGE_LIST_FETCH_ONGOING',
    startedAt: channel.startedAt,
  };
  const groupAction = await captureOrdinaryGroupEmailAction(
    f.coreReader.manager,
    f.workspaceId,
    seed.channelId,
    accountId,
    'GROUP_EMAILS_DELETION',
  );
  const folderAction = await captureOrdinaryFolderAction(f.coreReader.manager, {
    workspaceId: f.workspaceId,
    messageChannelId: seed.channelId,
    connectedAccountId: accountId,
    messageFolderId: folderId,
    action: 'FOLDER_DELETION',
  });
  if (!groupAction || !folderAction)
    throw new Error('Expected real captured cleanup action');
  return {
    ...seed,
    accountId,
    userId,
    userWorkspaceId,
    folderId,
    expectedRun,
    groupAction,
    folderAction,
  };
};
type Seed = Awaited<ReturnType<typeof seedBoundary>>;
const sync = (seed: Seed) =>
  execute((scope) =>
    deleteOrdinarySyncMessageAssociationsWithAudit({
      scope,
      operation: operation(),
      expectedRun: seed.expectedRun,
      messageExternalIds: [seed.email.externalId],
    }),
  );
const group = (seed: Seed, candidates = [seed.email.associationId]) =>
  execute((scope) =>
    deleteOrdinaryGroupEmailMessageAssociationsWithAudit({
      scope,
      operation: operation(),
      action: seed.groupAction,
      candidateAssociationIds: candidates,
    }),
  );
const folder = (seed: Seed, cursor?: string) =>
  execute((scope) =>
    deleteOrdinaryFolderMessagePageWithAudit({
      scope,
      operation: operation(),
      action: seed.folderAction,
      ...(cursor ? { cursor } : {}),
    }),
  );
const draft = (seed: Seed) =>
  execute((scope) =>
    deleteSentDraftMessageWithAudit({
      scope,
      operation: operation(),
      caller: { userId: seed.userId, userWorkspaceId: seed.userWorkspaceId },
      connectedAccountId: seed.accountId,
      draftMessageId: seed.email.messageId,
      target: {
        associationId: seed.email.associationId,
        messageChannelId: seed.channelId,
        messageExternalId: seed.email.externalId,
      },
    }),
  );
const triggerAudit = (body: string) =>
  f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".boundary_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN ${body} RETURN NEW; END $$;
  CREATE TRIGGER boundary_audit_test AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".boundary_test()`);

beforeAll(async () => {
  await f.initialize();
  await f.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid,ADD provider text,ADD "applicationId" uuid,ADD "connectionProviderId" uuid,ADD "userWorkspaceId" uuid,ADD scope text',
  );
  await f.owner.query(
    'ALTER TABLE core."messageChannel" ADD "isSyncEnabled" boolean,ADD "syncStage" text,ADD "syncStageStartedAt" timestamptz,ADD "pendingGroupEmailsAction" text,ADD "excludeGroupEmails" boolean,ADD "updatedAt" timestamptz NOT NULL DEFAULT now()',
  );
  await f.owner.query(
    'ALTER TABLE core."messageFolder" ADD "pendingSyncAction" text,ADD "isSynced" boolean,ADD "externalId" text,ADD name text,ADD "parentFolderId" text,ADD "updatedAt" timestamptz NOT NULL DEFAULT now()',
  );
  // Minimal auth projections queried by the actual draft owner; native objects
  // and their FK graph remain generated from real standard metadata.
  await f.owner.query(
    'CREATE TABLE core."user"(id uuid PRIMARY KEY,"deletedAt" timestamptz,disabled boolean NOT NULL DEFAULT false); CREATE TABLE core."userWorkspace"(id uuid PRIMARY KEY,"userId" uuid REFERENCES core."user"(id),"workspaceId" uuid REFERENCES core.workspace(id),"deletedAt" timestamptz)',
  );
  await f.owner.query(
    `GRANT SELECT,UPDATE ON core."connectedAccount",core."messageChannel",core."messageFolder",core."user",core."userWorkspace" TO "${f.roleName}"`,
  );
});
beforeEach(async () => {
  for (const name of [ROOT, CHILD, 'message', 'messageParticipant'])
    await f.owner.query(
      `DROP TRIGGER IF EXISTS boundary_test ON ${table(name)}`,
    );
  await f.owner.query(
    'DROP TRIGGER IF EXISTS boundary_audit_test ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".boundary_test()`,
  );
  await f.reset();
  await f.owner.query('TRUNCATE core."user" CASCADE');
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => f.dispose());

it('uses the current provider run and commits the full targeted graph with one audit operation', async () => {
  const seed = await seedBoundary();
  const result = await sync(seed);
  expect(result?.primaryDeletedAssociationIds).toEqual([
    seed.email.associationId,
  ]);
  expect(await present('message', seed.email.messageId)).toBe(false);
  const rows = await audit();
  expect(rows).toHaveLength(6);
  expect(
    new Set(rows.map((row: { operationId: string }) => row.operationId)).size,
  ).toBe(1);
});

it('declines a replaced provider run without native writes, audit or events', async () => {
  const seed = await seedBoundary();
  await f.owner.query(
    'UPDATE core."messageChannel" SET "syncStageStartedAt"="syncStageStartedAt"+interval \'1 microsecond\' WHERE id=$1',
    [seed.channelId],
  );
  const before = await snapshot();
  expect(await sync(seed)).toBeNull();
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('rolls back native cleanup if audit flush changes the accepted provider run', async () => {
  const seed = await seedBoundary(),
    before = await snapshot();
  await triggerAudit(
    `UPDATE core."messageChannel" SET "syncStageStartedAt"="syncStageStartedAt"+interval '1 microsecond' WHERE id='${seed.channelId}';`,
  );
  await expect(sync(seed)).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('captures a mutable provider proof at leaf entry before metadata awaits', async () => {
  const seed = await seedBoundary();
  const mutable = { ...seed.expectedRun };
  const pending = execute((scope) => {
    const work = deleteOrdinarySyncMessageAssociationsWithAudit({
      scope,
      operation: operation(),
      expectedRun: mutable,
      messageExternalIds: [seed.email.externalId],
    });
    mutable.startedAt = '2000-01-01T00:00:00.000001Z';
    mutable.connectedAccountId = randomUUID();
    return work;
  });
  expect((await pending)?.primaryDeletedAssociationIds).toEqual([
    seed.email.associationId,
  ]);
  expect(await audit()).toHaveLength(6);
});

it.each(['handle', 'role', 'deletedAt', 'messageId'] as const)(
  'rechecks the current group sender %s rather than trusting a previous outer selection',
  async (field) => {
    const seed = await seedBoundary();
    await f.owner.query(
      `UPDATE ${table('messageParticipant')} SET handle='support@example.test' WHERE id=$1`,
      [seed.email.participantId],
    );
    if (field === 'handle')
      await f.owner.query(
        `UPDATE ${table('messageParticipant')} SET handle='alice@example.test' WHERE id=$1`,
        [seed.email.participantId],
      );
    else if (field === 'role')
      await f.owner.query(
        `UPDATE ${table('messageParticipant')} SET role='TO' WHERE id=$1`,
        [seed.email.participantId],
      );
    else if (field === 'deletedAt')
      await f.owner.query(
        `UPDATE ${table('messageParticipant')} SET "deletedAt"=clock_timestamp() WHERE id=$1`,
        [seed.email.participantId],
      );
    else
      await f.owner.query(
        `UPDATE ${table('messageParticipant')} SET "messageId"=$2 WHERE id=$1`,
        [seed.email.participantId, seed.omni.messageId],
      );
    const before = await snapshot();
    const result = await group(seed);
    expect(result).not.toBeNull();
    expect(result?.primaryDeletedAssociationIds).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toEqual([]);
  },
);

it('deletes only the eligible association when an excluded Message has the same external ID', async () => {
  const seed = await seedBoundary();
  await f.owner.query(
    `UPDATE ${table('messageParticipant')} SET handle='support@example.test' WHERE id=$1`,
    [seed.email.participantId],
  );
  const messageId = await insert('message', {
    messageThreadId: seed.email.threadId,
    headerMessageId: randomUUID(),
    text: 'personal sender',
    receivedAt: new Date(),
    isDraft: false,
  });
  const participantId = await insert('messageParticipant', {
    messageId,
    personId: null,
    role: 'FROM',
    handle: 'alice@example.test',
    displayName: null,
  });
  const associationId = await insert(ROOT, {
    messageId,
    messageChannelId: seed.channelId,
    messageExternalId: seed.email.externalId,
    messageThreadExternalId: 'same-external',
    direction: 'INCOMING',
  });
  const result = await group(seed, [seed.email.associationId, associationId]);
  expect(result?.primaryDeletedAssociationIds).toEqual([
    seed.email.associationId,
  ]);
  expect(result?.deletedMessageIds).toEqual([seed.email.messageId]);
  expect(await present(ROOT, associationId)).toBe(true);
  expect(await present('message', messageId)).toBe(true);
  expect(await present('messageParticipant', participantId)).toBe(true);
  expect(await present('messageThread', seed.email.threadId)).toBe(true);
});

it.each([
  'handle',
  'role',
  'deletedAt',
  'reparent',
  'new-participant',
] as const)(
  'rolls back when audit flush changes an excluded group source via %s',
  async (mutation) => {
    const seed = await seedBoundary();
    await f.owner.query(
      `UPDATE ${table('messageParticipant')} SET handle='support@example.test' WHERE id=$1`,
      [seed.email.participantId],
    );
    const messageId = await insert('message', {
      messageThreadId: seed.email.threadId,
      headerMessageId: randomUUID(),
      text: 'excluded',
      receivedAt: new Date(),
      isDraft: false,
    });
    const participantId = await insert('messageParticipant', {
      messageId,
      personId: null,
      role: mutation === 'role' ? 'TO' : 'FROM',
      handle:
        mutation === 'role' || mutation === 'deletedAt'
          ? 'support@example.test'
          : 'alice@example.test',
      displayName: null,
      ...(mutation === 'deletedAt' ? { deletedAt: new Date() } : {}),
    });
    const associationId = await insert(ROOT, {
      messageId,
      messageChannelId: seed.channelId,
      messageExternalId: 'excluded',
      messageThreadExternalId: 'excluded',
      direction: 'INCOMING',
    });
    const before = await snapshot(),
      addedId = randomUUID();
    const sql =
      mutation === 'new-participant'
        ? `INSERT INTO ${table('messageParticipant')}(id,"messageId",role,handle) VALUES('${addedId}','${messageId}','FROM','support@example.test') ON CONFLICT(id) DO NOTHING;`
        : mutation === 'handle'
          ? `UPDATE ${table('messageParticipant')} SET handle='support@example.test' WHERE id='${participantId}';`
          : mutation === 'role'
            ? `UPDATE ${table('messageParticipant')} SET role='FROM' WHERE id='${participantId}';`
            : mutation === 'deletedAt'
              ? `UPDATE ${table('messageParticipant')} SET "deletedAt"=NULL WHERE id='${participantId}';`
              : `UPDATE ${table('messageParticipant')} SET "messageId"='${seed.omni.messageId}' WHERE id='${participantId}';`;
    await triggerAudit(sql);
    await expect(
      group(seed, [seed.email.associationId, associationId]),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it('declines an obsolete group action even when current sender classification would permit deletion', async () => {
  const seed = await seedBoundary();
  await f.owner.query(
    `UPDATE ${table('messageParticipant')} SET handle='support@example.test' WHERE id=$1`,
    [seed.email.participantId],
  );
  await f.owner.query(
    'UPDATE core."messageChannel" SET "updatedAt"="updatedAt"+interval \'1 microsecond\' WHERE id=$1',
    [seed.channelId],
  );
  const before = await snapshot();
  expect(await group(seed)).toBeNull();
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
});

it('rolls back live graph cleanup when the remaining soft-parent folder junction DELETE fails', async () => {
  const seed = await seedBoundary();
  const messageId = await insert('message', {
    messageThreadId: seed.email.threadId,
    headerMessageId: randomUUID(),
    text: 'historical folder source',
    receivedAt: new Date(),
    isDraft: false,
  });
  const associationId = await insert(ROOT, {
    messageId,
    messageChannelId: seed.channelId,
    messageExternalId: 'historical',
    messageThreadExternalId: 'historical',
    direction: 'INCOMING',
    deletedAt: new Date(),
  });
  const junctionId = await insert(CHILD, {
    messageChannelMessageAssociationId: associationId,
    messageFolderId: seed.folderId,
  });
  const before = await snapshot();
  await f.owner
    .query(`CREATE FUNCTION "${f.schemaName}".boundary_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.id='${junctionId}'::uuid THEN RAISE EXCEPTION 'remaining folder junction failure'; END IF; RETURN OLD; END $$;
    CREATE TRIGGER boundary_test BEFORE DELETE ON ${table(CHILD)} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".boundary_test()`);
  await expect(folder(seed)).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('counts only actual live associations and audits the remaining historical folder junction separately', async () => {
  const seed = await seedBoundary();
  const messageId = await insert('message', {
    messageThreadId: seed.email.threadId,
    headerMessageId: randomUUID(),
    text: 'historical folder source',
    receivedAt: new Date(),
    isDraft: false,
  });
  const associationId = await insert(ROOT, {
    messageId,
    messageChannelId: seed.channelId,
    messageExternalId: 'historical',
    messageThreadExternalId: 'historical',
    direction: 'INCOMING',
    deletedAt: new Date(),
  });
  const junctionId = await insert(CHILD, {
    messageChannelMessageAssociationId: associationId,
    messageFolderId: seed.folderId,
  });
  const result = await folder(seed);
  expect(result).toMatchObject({ deletedAssociationCount: 1, done: true });
  expect(await present(CHILD, junctionId)).toBe(false);
  expect(await present(ROOT, associationId)).toBe(true);
  expect(await present('message', messageId)).toBe(true);
  const entries = await audit();
  expect(
    entries.some(
      (row: { resourceId: string; action: string }) =>
        row.resourceId === junctionId && row.action === 'delete',
    ),
  ).toBe(true);
  expect(
    new Set(entries.map((row: { operationId: string }) => row.operationId))
      .size,
  ).toBe(1);
});

it('preserves a folder association with null external ID while deleting and auditing only its eligible junction', async () => {
  const seed = await seedBoundary();
  await f.owner.query(
    `UPDATE ${table(ROOT)} SET "messageExternalId"=NULL WHERE id=$1`,
    [seed.email.associationId],
  );
  const result = await folder(seed);
  expect(result).toMatchObject({ done: true, deletedAssociationCount: 0 });
  expect(await present(CHILD, seed.email.junctionId)).toBe(false);
  for (const [name, id] of [
    [ROOT, seed.email.associationId],
    ['message', seed.email.messageId],
    ['messageParticipant', seed.email.participantId],
    ['messageThread', seed.email.threadId],
    ['messageThreadTarget', seed.email.targetId],
  ])
    expect(await present(name, id)).toBe(true);
  expect(
    (await audit()).map((row: { resourceId: string }) => row.resourceId),
  ).toEqual([seed.email.junctionId]);
});

it('rolls back a late junction inserted into the inspected underfull folder page during audit flush', async () => {
  const seed = await seedBoundary();
  const messageId = await insert('message', {
    messageThreadId: seed.email.threadId,
    headerMessageId: randomUUID(),
    text: 'late page source',
    receivedAt: new Date(),
    isDraft: false,
  });
  const associationId = await insert(ROOT, {
    messageId,
    messageChannelId: seed.channelId,
    messageExternalId: 'late-folder-source',
    messageThreadExternalId: 'late-folder-source',
    direction: 'INCOMING',
    deletedAt: new Date(),
  });
  const junctionId = randomUUID(),
    before = await snapshot();
  await triggerAudit(
    `INSERT INTO ${table(CHILD)}(id,"messageChannelMessageAssociationId","messageFolderId") VALUES('${junctionId}','${associationId}','${seed.folderId}') ON CONFLICT(id) DO NOTHING;`,
  );
  await expect(folder(seed)).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  expect(await present(CHILD, junctionId)).toBe(false);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('refuses a folder junction moved by another connection after page discovery without undoing that committed move', async () => {
  const seed = await seedBoundary();
  const otherFolderId = await f.coreInsert('messageFolder', {
    workspaceId: f.workspaceId,
    messageChannelId: seed.channelId,
  });
  const client = await f.pool.connect(),
    original = client.query.bind(client);
  let intercepted = false;
  let afterExternalMove: Awaited<ReturnType<typeof snapshot>> | undefined;
  jest.spyOn(client, 'query').mockImplementation((async (
    statement: string | { text: string },
    values?: unknown[],
  ) => {
    const sql = typeof statement === 'string' ? statement : statement.text;
    const result = await original(statement as string, values);
    if (
      !intercepted &&
      sql.startsWith('SELECT id FROM ') &&
      sql.includes(CHILD) &&
      sql.includes('ORDER BY id LIMIT 200')
    ) {
      intercepted = true;
      expect(result.rows.map((row: { id: string }) => row.id)).toEqual([
        seed.email.junctionId,
      ]);
      // f.owner uses a separate real connection. Its autocommitted change occurs
      // after page discovery and before the owner's first row snapshot/lock.
      await f.owner.query(
        `UPDATE ${table(CHILD)} SET "messageFolderId"=$1 WHERE id=$2`,
        [otherFolderId, seed.email.junctionId],
      );
      afterExternalMove = await snapshot();
    }
    return result;
  }) as typeof client.query);
  jest
    .spyOn(f.pool, 'connect')
    .mockImplementationOnce(() => Promise.resolve(client));
  await expect(folder(seed)).rejects.toThrow(
    'Native folder cleanup page range changed',
  );
  expect(intercepted).toBe(true);
  expect(afterExternalMove).toBeDefined();
  expect(await snapshot()).toEqual(afterExternalMove);
  expect(await present(ROOT, seed.email.associationId)).toBe(true);
  expect(await present('message', seed.email.messageId)).toBe(true);
  expect(
    (
      await f.owner.query(
        `SELECT "messageFolderId" FROM ${table(CHILD)} WHERE id=$1`,
        [seed.email.junctionId],
      )
    )[0].messageFolderId,
  ).toBe(otherFolderId);
  expect(await audit()).toEqual([]);
  expect(f.eventEmitter).not.toHaveBeenCalled();
});

it('advances past 200 protected folder junctions and counts only the ordinary later association', async () => {
  const seed = await seedBoundary();
  const ids: string[] = Array.from(
    { length: 200 },
    (_, index) =>
      `00000000-0000-4000-b000-${(index + 1).toString(16).padStart(12, '0')}`,
  );
  await f.seedNative(async (scope) => {
    const options = { shouldBypassPermissionChecks: true } as const;
    await scope.getRepository(ROOT, options).insert(
      ids.map((id) => ({
        id,
        messageId: null,
        messageThreadId: seed.omni.threadId,
        messageChannelId: seed.channelId,
        messageExternalId: id,
        messageThreadExternalId: 'protected',
        direction: 'INCOMING',
      })),
    );
    await scope.getRepository(CHILD, options).insert(
      ids.map((id) => ({
        id,
        messageChannelMessageAssociationId: id,
        messageFolderId: seed.folderId,
      })),
    );
  });
  f.eventEmitter.mockClear();
  const first = await folder(seed);
  expect(first).toEqual({
    cursor: ids[199],
    done: false,
    deletedAssociationCount: 0,
  });
  expect(await audit()).toEqual([]);
  if (!first?.cursor)
    throw new Error('Expected complete protected page cursor');
  const second = await folder(seed, first.cursor);
  expect(second).toMatchObject({ done: true, deletedAssociationCount: 1 });
  for (const name of [ROOT, CHILD])
    expect(
      await f.owner.query(
        `SELECT count(*)::int AS count FROM ${table(name)} WHERE id=ANY($1::uuid[])`,
        [ids],
      ),
    ).toEqual([{ count: 200 }]);
  expect(await audit()).toHaveLength(6);
}, 20000);

it.each(['initial', 'during-audit'] as const)(
  'refuses a changed folder action %s without committing native deletion',
  async (when) => {
    const seed = await seedBoundary(),
      before = await snapshot();
    const sql = `UPDATE core."messageFolder" SET "updatedAt"="updatedAt"+interval '1 microsecond' WHERE id='${seed.folderId}';`;
    if (when === 'initial') {
      await f.owner.query(sql);
      expect(await folder(seed)).toBeNull();
    } else {
      await triggerAudit(sql);
      await expect(folder(seed)).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it.each(['owned', 'workspace-shared'] as const)(
  'deletes a sent draft using fresh active membership and %s account usability',
  async (access) => {
    const seed = await seedBoundary();
    await f.owner.query(
      `UPDATE ${table('message')} SET "isDraft"=true WHERE id=$1`,
      [seed.email.messageId],
    );
    if (access === 'workspace-shared')
      await f.owner.query(
        'UPDATE core."connectedAccount" SET scope=$2,"userWorkspaceId"=$3 WHERE id=$1',
        [seed.accountId, 'WORKSPACE', randomUUID()],
      );
    const result = await draft(seed);
    expect(result?.primaryDeletedAssociationIds).toEqual([
      seed.email.associationId,
    ]);
    expect(await audit()).toHaveLength(6);
  },
);

it('cleans only the association actually sent when the same draft has another eligible channel association', async () => {
  const seed = await seedBoundary();
  await f.owner.query(
    `UPDATE ${table('message')} SET "isDraft"=true WHERE id=$1`,
    [seed.email.messageId],
  );
  const otherChannelId = await f.coreInsert('messageChannel', {
    workspaceId: f.workspaceId,
    connectedAccountId: seed.accountId,
    type: 'EMAIL',
  });
  const otherId = await insert(ROOT, {
    messageId: seed.email.messageId,
    messageChannelId: otherChannelId,
    messageExternalId: 'another-draft',
    messageThreadExternalId: 'another-draft',
    direction: 'INCOMING',
  });
  const result = await draft(seed);
  expect(result?.primaryDeletedAssociationIds).toEqual([
    seed.email.associationId,
  ]);
  expect(result?.deletedMessageIds).toEqual([]);
  expect(await present(ROOT, otherId)).toBe(true);
  expect(await present('message', seed.email.messageId)).toBe(true);
  expect(
    (await audit()).map((row: { resourceId: string }) => row.resourceId).sort(),
  ).toEqual([seed.email.associationId, seed.email.junctionId].sort());
});

it.each(['externalId', 'messageId', 'channelId'] as const)(
  'never selects a replacement association after the provider-selected draft target changes %s',
  async (field) => {
    const seed = await seedBoundary();
    await f.owner.query(
      `UPDATE ${table('message')} SET "isDraft"=true WHERE id=$1`,
      [seed.email.messageId],
    );
    const otherChannelId = await f.coreInsert('messageChannel', {
      workspaceId: f.workspaceId,
      connectedAccountId: seed.accountId,
      type: 'EMAIL',
    });
    const otherId = await insert(ROOT, {
      messageId: seed.email.messageId,
      messageChannelId: otherChannelId,
      messageExternalId: 'replacement-draft',
      messageThreadExternalId: 'replacement',
      direction: 'INCOMING',
    });
    if (field === 'externalId')
      await f.owner.query(
        `UPDATE ${table(ROOT)} SET "messageExternalId"='changed-after-send' WHERE id=$1`,
        [seed.email.associationId],
      );
    else if (field === 'messageId') {
      const otherMessageId = await insert('message', {
        messageThreadId: seed.email.threadId,
        headerMessageId: randomUUID(),
        text: 'different draft',
        receivedAt: new Date(),
        isDraft: true,
      });
      await f.owner.query(
        `UPDATE ${table(ROOT)} SET "messageId"=$2 WHERE id=$1`,
        [seed.email.associationId, otherMessageId],
      );
    } else {
      const thirdChannelId = await f.coreInsert('messageChannel', {
        workspaceId: f.workspaceId,
        connectedAccountId: seed.accountId,
        type: 'EMAIL',
      });
      await f.owner.query(
        `UPDATE ${table(ROOT)} SET "messageChannelId"=$2 WHERE id=$1`,
        [seed.email.associationId, thirdChannelId],
      );
    }
    const before = await snapshot();
    expect(await draft(seed)).toBeNull();
    expect(await snapshot()).toEqual(before);
    expect(await present(ROOT, otherId)).toBe(true);
    expect(await audit()).toEqual([]);
  },
);

it.each([
  'membership-revoked',
  'membership-rebound',
  'user-deleted',
  'user-disabled',
  'custodian',
  'scope',
  'parent',
  'not-draft',
] as const)(
  'declines draft cleanup after provider work when %s changed',
  async (mutation) => {
    const seed = await seedBoundary();
    await f.owner.query(
      `UPDATE ${table('message')} SET "isDraft"=true WHERE id=$1`,
      [seed.email.messageId],
    );
    if (mutation === 'membership-revoked')
      await f.owner.query(
        'UPDATE core."userWorkspace" SET "deletedAt"=clock_timestamp() WHERE id=$1',
        [seed.userWorkspaceId],
      );
    else if (mutation === 'membership-rebound') {
      const otherUser = randomUUID();
      await f.owner.query('INSERT INTO core."user"(id) VALUES($1)', [
        otherUser,
      ]);
      await f.owner.query(
        'UPDATE core."userWorkspace" SET "userId"=$2 WHERE id=$1',
        [seed.userWorkspaceId, otherUser],
      );
    } else if (mutation === 'user-deleted')
      await f.owner.query(
        'UPDATE core."user" SET "deletedAt"=clock_timestamp() WHERE id=$1',
        [seed.userId],
      );
    else if (mutation === 'user-disabled')
      await f.owner.query('UPDATE core."user" SET disabled=true WHERE id=$1', [
        seed.userId,
      ]);
    else if (mutation === 'custodian' || mutation === 'scope') {
      // A captured shared account can become private to another member while the
      // provider request is in flight; only the current scope is authoritative.
      const otherMemberId = randomUUID();
      if (mutation === 'scope') {
        await f.owner.query(
          'UPDATE core."connectedAccount" SET "userWorkspaceId"=$2,scope=$3 WHERE id=$1',
          [seed.accountId, otherMemberId, 'WORKSPACE'],
        );
        expect(
          await f.owner.query(
            'SELECT scope FROM core."connectedAccount" WHERE id=$1',
            [seed.accountId],
          ),
        ).toEqual([{ scope: 'WORKSPACE' }]);
      }
      await f.owner.query(
        'UPDATE core."connectedAccount" SET "userWorkspaceId"=$2,scope=$3 WHERE id=$1',
        [seed.accountId, otherMemberId, 'USER'],
      );
    } else if (mutation === 'parent')
      await f.owner.query(
        'UPDATE core."messageChannel" SET "connectedAccountId"=(SELECT "connectedAccountId" FROM core."messageChannel" WHERE id=$2) WHERE id=$1',
        [seed.channelId, seed.protectedChannelId],
      );
    else
      await f.owner.query(
        `UPDATE ${table('message')} SET "isDraft"=false WHERE id=$1`,
        [seed.email.messageId],
      );
    const before = await snapshot();
    expect(await draft(seed)).toBeNull();
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(f.eventEmitter).not.toHaveBeenCalled();
  },
);

it('rolls back when audit flush changes the caller membership after draft qualification', async () => {
  const seed = await seedBoundary();
  await f.owner.query(
    `UPDATE ${table('message')} SET "isDraft"=true WHERE id=$1`,
    [seed.email.messageId],
  );
  const before = await snapshot();
  await triggerAudit(
    `UPDATE core."userWorkspace" SET "deletedAt"=clock_timestamp() WHERE id='${seed.userWorkspaceId}';`,
  );
  await expect(draft(seed)).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  expect(await audit()).toEqual([]);
  expect(
    await f.owner.query(
      'SELECT "deletedAt" FROM core."userWorkspace" WHERE id=$1',
      [seed.userWorkspaceId],
    ),
  ).toEqual([{ deletedAt: null }]);
});
