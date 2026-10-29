import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';

import { deleteConnectedAccountsWithAudit } from 'src/engine/core-modules/crm-audit/delete-connected-accounts-with-audit';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { bootstrapOmniAccountBinding } from 'src/modules/omnichannel/services/omni-binding-bootstrap';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';

jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);

const fixture = createOmniNativeMessageFixture({
  additionalTables: ['messageChannelMessageAssociationMessageFolder'],
});
const runtime = new DataSource({
  type: 'postgres',
  url: fixture.runtimeDatabaseUrl,
  entities: [],
  synchronize: false,
  extra: { max: 4, statement_timeout: 12000 },
});
const tables = [
  'connectedAccount',
  'messageChannel',
  'calendarChannel',
  'messageFolder',
] as const;
type Graph = {
  account: string;
  channel: string;
  calendar: string;
  folder: string;
  member: string;
};
let graph: Graph;
const operation = (): CrmAuditOperation => ({
  workspaceId: fixture.workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'system', id: 'account-delete-test' },
});
const remove = (accountIds = [graph.account], audit = operation()) =>
  deleteConnectedAccountsWithAudit({
    dataSource: runtime,
    workspaceId: fixture.workspaceId,
    accountIds,
    operation: audit,
  });
const audits = () =>
  fixture.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "resourceKind","resourceId"',
  );
const seed = async (): Promise<Graph> => {
  const value = {
    account: randomUUID(),
    channel: randomUUID(),
    calendar: randomUUID(),
    folder: randomUUID(),
    member: randomUUID(),
  };
  await fixture.owner.query(
    `INSERT INTO core."connectedAccount" (id,"workspaceId","userWorkspaceId","accessToken","connectionParameters",claims,provider,scope)
    VALUES($1,$2,$3,'test-secret-token','{"password":"test-secret-password"}','{"n":9007199254740993}','app','WORKSPACE')`,
    [value.account, fixture.workspaceId, value.member],
  );
  await fixture.owner.query(
    'INSERT INTO core."messageChannel" (id,"workspaceId","connectedAccountId",type) VALUES($1,$2,$3,\'APP\')',
    [value.channel, fixture.workspaceId, value.account],
  );
  await fixture.owner.query(
    'INSERT INTO core."calendarChannel" (id,"workspaceId","connectedAccountId") VALUES($1,$2,$3)',
    [value.calendar, fixture.workspaceId, value.account],
  );
  await fixture.owner.query(
    'INSERT INTO core."messageFolder" (id,"workspaceId","messageChannelId",name) VALUES($1,$2,$3,\'test-private-folder\')',
    [value.folder, fixture.workspaceId, value.channel],
  );
  return value;
};
const snapshots = async () => {
  const result: unknown[] = [];
  for (const table of tables)
    result.push(
      await fixture.owner.query(
        'SELECT to_jsonb(r)::text AS snapshot FROM core."' +
          table +
          '" r ORDER BY id',
      ),
    );
  return result;
};
const bootstrap = (
  value = graph,
  authorize: Parameters<typeof bootstrapOmniAccountBinding>[3] = async () =>
    undefined,
) =>
  bootstrapOmniAccountBinding(
    runtime,
    { kind: 'system', id: 'account-delete-test' },
    {
      workspaceId: fixture.workspaceId,
      platform: 'telegram',
      connectorInstanceId: 'delete-test',
      accountId: value.account,
      connectedAccountId: value.account,
      messageChannelId: value.channel,
      idempotencyKey: randomUUID(),
      expectedRevision: '0',
    },
    authorize,
  );
const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const capture = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
const blocked = async () => {
  for (let i = 0; i < 300; i++) {
    const [{ count }] = await fixture.owner.query(
      'SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname=current_database())',
    );
    if (count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected actual database lock wait');
};
const pause = (matches: (sql: string) => boolean) => {
  const reached = barrier(),
    resume = barrier();
  const create = runtime.createQueryRunner.bind(runtime);
  let used = false;
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
    const runner = create(mode),
      query = runner.query.bind(runner);
    runner.query = async (...args: Parameters<QueryRunner['query']>) => {
      const result = await query(...args);
      if (!used && matches(args[0])) {
        used = true;
        reached.release();
        await resume.promise;
      }
      return result;
    };
    return runner;
  });
  return { reached: reached.promise, resume: resume.release };
};

beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner
    .query(`ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid, ADD "userWorkspaceId" uuid, ADD "accessToken" text, ADD "refreshToken" text, ADD "connectionParameters" jsonb, ADD claims jsonb, ADD provider text, ADD scope text, ADD "archivedAt" timestamptz, ADD "applicationId" uuid, ADD "connectionProviderId" uuid;
    ALTER TABLE core."messageChannel" ADD "connectedAccountId" uuid REFERENCES core."connectedAccount"(id) ON DELETE CASCADE, ADD "isSyncEnabled" boolean DEFAULT true, ADD "webhookSubscriptionStatus" text;
    CREATE TABLE core."calendarChannel" (id uuid PRIMARY KEY,"workspaceId" uuid,"connectedAccountId" uuid REFERENCES core."connectedAccount"(id) ON DELETE CASCADE,"isSyncEnabled" boolean DEFAULT true,"webhookSubscriptionStatus" text);
    ALTER TABLE core."messageFolder" ADD name text, ADD "isSentFolder" boolean DEFAULT false, ADD "isSynced" boolean DEFAULT true, ADD "pendingSyncAction" text;
    ALTER TABLE core."connectedAccount" ADD UNIQUE(id,"workspaceId");
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "${fixture.roleName}"`);
  await runtime.initialize();
});
beforeEach(async () => {
  await fixture.owner.query(
    'DROP FUNCTION IF EXISTS core.delete_test_trigger() CASCADE; DROP FUNCTION IF EXISTS crm_audit.delete_test_trigger() CASCADE; DROP TABLE IF EXISTS core.delete_extra CASCADE',
  );
  await fixture.reset();
  await fixture.owner.query(
    'TRUNCATE core.workspace,core."connectedAccount",core."messageChannel" CASCADE',
  );
  await fixture.owner.query('INSERT INTO core.workspace(id) VALUES($1)', [
    fixture.workspaceId,
  ]);
  graph = await seed();
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (runtime.isInitialized) await runtime.destroy();
  await fixture.dispose();
});

describe('closed connected account deletion with atomic audit', () => {
  it('deletes the exact four-table graph and redacts secrets, names and provider data', async () => {
    const other = await seed();
    const audit = operation();
    expect(
      await remove([graph.account, graph.account.toUpperCase()], audit),
    ).toEqual({
      accounts: [{ id: graph.account, userWorkspaceId: graph.member }],
      messageChannelIds: [graph.channel],
      calendarChannelIds: [graph.calendar],
      messageFolderIds: [graph.folder],
    });
    const rows = await audits();
    expect(rows).toHaveLength(4);
    expect(
      rows.every(
        (row: { operationId: string; action: string }) =>
          row.operationId !== audit.operationId && row.action === 'delete',
      ),
    ).toBe(true);
    expect(
      new Set(rows.map((row: { resourceId: string }) => row.resourceId)),
    ).toEqual(
      new Set([graph.account, graph.channel, graph.calendar, graph.folder]),
    );
    const text = JSON.stringify(rows);
    for (const secret of [
      'test-secret-token',
      'test-secret-password',
      'test-private-folder',
      '9007199254740993',
    ])
      expect(text).not.toContain(secret);
    expect(
      (await fixture.owner.query('SELECT id FROM core."connectedAccount"')).map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual([other.account]);
  });
  it('allows an empty request without fictitious effects', async () => {
    expect(await remove([])).toEqual({
      accounts: [],
      messageChannelIds: [],
      calendarChannelIds: [],
      messageFolderIds: [],
    });
    expect(await audits()).toHaveLength(0);
  });
  it('captures account IDs and audit attribution before the first await', async () => {
    const ids = [graph.account],
      audit = operation(),
      original = audit.operationId;
    const pending = remove(ids, audit);
    ids[0] = randomUUID();
    audit.actor.id = 'changed';
    audit.operationId = randomUUID();
    await pending;
    const rows = await audits();
    expect(rows[0].operationId).not.toBe(original);
    expect(JSON.stringify(rows)).toContain('account-delete-test');
    expect(
      rows.every(
        (row: { actor: { id: string } }) =>
          row.actor.id === 'account-delete-test',
      ),
    ).toBe(true);
  });
  it('records a new operation after recreating identical records with the same caller operation', async () => {
    const saved: { table: string; snapshot: string }[] = [];
    for (const table of tables)
      for (const row of await fixture.owner.query(
        'SELECT to_jsonb(r)::text AS snapshot FROM core."' + table + '" r',
      ))
        saved.push({ table, snapshot: row.snapshot });
    const audit = operation();
    await remove([graph.account], audit);
    for (const row of saved)
      await fixture.owner.query(
        'INSERT INTO core."' +
          row.table +
          '" SELECT * FROM jsonb_populate_record(NULL::core."' +
          row.table +
          '",$1::jsonb)',
        [row.snapshot],
      );
    await remove([graph.account], audit);
    const rows = await audits();
    expect(rows).toHaveLength(8);
    expect(
      new Set(rows.map((row: { operationId: string }) => row.operationId)).size,
    ).toBe(2);
  });
  it.each([
    'missing-operation',
    'foreign-operation',
    'invalid-operation',
    'missing-account',
    'deleted-workspace',
  ])('refuses %s without deletion', async (kind) => {
    const audit = operation();
    if (kind === 'foreign-operation') audit.workspaceId = randomUUID();
    if (kind === 'invalid-operation') audit.operationId = 'invalid';
    if (kind === 'deleted-workspace')
      await fixture.owner.query('UPDATE core.workspace SET "deletedAt"=now()');
    const before = await snapshots();
    await expect(
      deleteConnectedAccountsWithAudit({
        dataSource: runtime,
        workspaceId: fixture.workspaceId,
        accountIds:
          kind === 'missing-account' ? [randomUUID()] : [graph.account],
        operation:
          kind === 'missing-operation'
            ? (undefined as unknown as CrmAuditOperation)
            : audit,
      }),
    ).rejects.toThrow();
    expect(await snapshots()).toEqual(before);
    expect(await audits()).toHaveLength(0);
  });
  it.each(tables)(
    'refuses foreign-workspace %s rather than silently narrowing the graph',
    async (table) => {
      await fixture.owner.query(
        'UPDATE core."' + table + '" SET "workspaceId"=$1',
        [randomUUID()],
      );
      const before = await snapshots();
      await expect(remove()).rejects.toThrow();
      expect(await snapshots()).toEqual(before);
      expect(await audits()).toHaveLength(0);
    },
  );
  it.each(['CASCADE', 'SET NULL', 'SET DEFAULT'])(
    'refuses populated unsupported %s edges',
    async (action) => {
      await fixture.owner.query(
        'CREATE TABLE core.delete_extra (parent uuid REFERENCES core."messageFolder"(id) ON DELETE ' +
          action +
          '); GRANT SELECT ON core.delete_extra TO "' +
          fixture.roleName +
          '"',
      );
      await fixture.owner.query('INSERT INTO core.delete_extra VALUES($1)', [
        graph.folder,
      ]);
      await expect(remove()).rejects.toThrow('unsupported cascade');
      expect(await audits()).toHaveLength(0);
      expect(
        await fixture.owner.query('SELECT parent FROM core.delete_extra'),
      ).toEqual([{ parent: graph.folder }]);
    },
  );
  it('allows an empty unsupported edge but inspects actual composite FK columns', async () => {
    await fixture.owner.query(
      `CREATE TABLE core.delete_extra (account uuid, workspace uuid, FOREIGN KEY(account,workspace) REFERENCES core."connectedAccount"(id,"workspaceId") ON DELETE CASCADE); GRANT SELECT ON core.delete_extra TO "${fixture.roleName}"`,
    );
    await fixture.owner.query('INSERT INTO core.delete_extra VALUES($1,$2)', [
      graph.account,
      fixture.workspaceId,
    ]);
    await expect(remove()).rejects.toThrow('unsupported cascade');
    await fixture.owner.query('DELETE FROM core.delete_extra');
    await expect(remove()).resolves.toMatchObject({
      messageFolderIds: [graph.folder],
    });
  });
  it('leaves restrictive FK errors to PostgreSQL and rolls audit back', async () => {
    await fixture.owner.query(
      `CREATE TABLE core.delete_extra (parent uuid REFERENCES core."connectedAccount"(id) ON DELETE RESTRICT); GRANT SELECT ON core.delete_extra TO "${fixture.roleName}"`,
    );
    await fixture.owner.query('INSERT INTO core.delete_extra VALUES($1)', [
      graph.account,
    ]);
    const before = await snapshots();
    await expect(remove()).rejects.toThrow();
    expect(await snapshots()).toEqual(before);
    expect(await audits()).toHaveLength(0);
  });
  it.each(['partial', 'all'])(
    'audits only actual DELETE RETURNING for %s skipped roots',
    async (kind) => {
      const other = await seed();
      await fixture.owner
        .query(`CREATE FUNCTION core.delete_test_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${kind === 'all' ? 'true' : `OLD.id='${graph.account}'::uuid`} THEN RETURN NULL; END IF; RETURN OLD; END $$;
      CREATE TRIGGER delete_test BEFORE DELETE ON core."connectedAccount" FOR EACH ROW EXECUTE FUNCTION core.delete_test_trigger()`);
      const before = await snapshots();
      const result = await remove([graph.account, other.account]);
      expect(result.accounts.map((row) => row.id)).toEqual(
        kind === 'all' ? [] : [other.account],
      );
      expect(await audits()).toHaveLength(kind === 'all' ? 0 : 4);
      if (kind === 'all') expect(await snapshots()).toEqual(before);
    },
  );
  it('detects exact JSONB corruption of a skipped root beyond JS integer precision', async () => {
    await fixture.owner
      .query(`CREATE FUNCTION core.delete_test_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE core."connectedAccount" SET claims='{"n":9007199254740992}' WHERE id=OLD.id; RETURN NULL; END $$;
      CREATE TRIGGER delete_test BEFORE DELETE ON core."connectedAccount" FOR EACH ROW EXECUTE FUNCTION core.delete_test_trigger()`);
    const before = await snapshots();
    await expect(remove()).rejects.toThrow('effects mismatch');
    expect(await snapshots()).toEqual(before);
    expect(await audits()).toHaveLength(0);
  });
  it.each(['reparent-folder', 'skip-folder'])(
    'rolls back unexpected %s cascade effects',
    async (kind) => {
      const other = await seed();
      await fixture.owner
        .query(`CREATE FUNCTION core.delete_test_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${kind === 'reparent-folder' ? `UPDATE core."messageFolder" SET "messageChannelId"='${other.channel}' WHERE id=OLD.id;` : ''} RETURN NULL; END $$;
      CREATE TRIGGER delete_test BEFORE DELETE ON core."messageFolder" FOR EACH ROW EXECUTE FUNCTION core.delete_test_trigger()`);
      const before = await snapshots();
      await expect(remove()).rejects.toThrow('effects mismatch');
      expect(await snapshots()).toEqual(before);
      expect(await audits()).toHaveLength(0);
    },
  );
  it.each(['omit', 'duplicate', 'foreign'])(
    'rejects %s DELETE result corruption even after real DELETE',
    async (kind) => {
      const create = runtime.createQueryRunner.bind(runtime);
      jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
        const runner = create(mode),
          query = runner.query.bind(runner);
        runner.query = async (...args: Parameters<QueryRunner['query']>) => {
          const result = await query(...args);
          return args[0].startsWith('WITH deleted AS')
            ? kind === 'omit'
              ? []
              : kind === 'duplicate'
                ? [...result, ...result]
                : [{ id: randomUUID() }]
            : result;
        };
        return runner;
      });
      const before = await snapshots();
      await expect(remove()).rejects.toThrow();
      expect(await snapshots()).toEqual(before);
      expect(await audits()).toHaveLength(0);
    },
  );
  it.each(['reject', 'recreate-account', 'change-skipped-folder'])(
    'rolls back %s audit-trigger effects',
    async (kind) => {
      const other = await seed();
      if (kind === 'change-skipped-folder')
        await fixture.owner
          .query(`CREATE FUNCTION core.delete_test_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='${other.account}' THEN RETURN NULL; END IF; RETURN OLD; END $$;
      CREATE TRIGGER delete_test BEFORE DELETE ON core."connectedAccount" FOR EACH ROW EXECUTE FUNCTION core.delete_test_trigger()`);
      const body =
        kind === 'reject'
          ? "RAISE EXCEPTION 'test-audit-unavailable';"
          : kind === 'recreate-account'
            ? `INSERT INTO core."connectedAccount"(id,"workspaceId") VALUES('${graph.account}','${fixture.workspaceId}') ON CONFLICT DO NOTHING;`
            : `UPDATE core."messageFolder" SET name='corrupt' WHERE id='${other.folder}';`;
      await fixture.owner
        .query(`CREATE FUNCTION crm_audit.delete_test_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$;
      CREATE TRIGGER delete_test AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.delete_test_trigger()`);
      const before = await snapshots();
      await expect(remove([graph.account, other.account])).rejects.toThrow();
      expect(await snapshots()).toEqual(before);
      expect(await audits()).toHaveLength(0);
    },
  );
  it('rejects retained account ownership including inactive bindings', async () => {
    await bootstrap();
    expect(
      await fixture.owner.query('SELECT status FROM core."omniAccountBinding"'),
    ).toEqual([{ status: 'inactive' }]);
    const before = await snapshots(),
      auditBefore = await audits();
    await expect(remove()).rejects.toThrow('retained omni');
    expect(await snapshots()).toEqual(before);
    expect(await audits()).toEqual(auditBefore);
  });
  it('rejects folder-only ownership through a protected message from another channel', async () => {
    const protectedGraph = await seed();
    await bootstrap(protectedGraph);
    const thread = randomUUID(),
      message = randomUUID(),
      association = randomUUID();
    await fixture.owner.query(
      `INSERT INTO "${fixture.schemaName}"."messageThread"(id) VALUES($1)`,
      [thread],
    );
    await fixture.owner.query(
      `INSERT INTO "${fixture.schemaName}"."message"(id,"messageThreadId") VALUES($1,$2)`,
      [message, thread],
    );
    await fixture.owner.query(
      `INSERT INTO "${fixture.schemaName}"."messageChannelMessageAssociation"(id,"messageId","messageChannelId") VALUES($1,$2,$3)`,
      [association, message, protectedGraph.channel],
    );
    await fixture.owner.query(
      `INSERT INTO "${fixture.schemaName}"."messageChannelMessageAssociationMessageFolder"(id,"messageChannelMessageAssociationId","messageFolderId") VALUES($1,$2,$3)`,
      [randomUUID(), association, graph.folder],
    );
    const before = await snapshots(),
      auditBefore = await audits();
    await expect(remove()).rejects.toThrow('retained omni');
    expect(await snapshots()).toEqual(before);
    expect(await audits()).toEqual(auditBefore);
  });
  it('fails closed when ownership SQL is unavailable', async () => {
    await fixture.owner.query(
      `REVOKE SELECT ON core."omniAccountBinding" FROM "${fixture.roleName}"`,
    );
    try {
      const before = await snapshots();
      await expect(remove()).rejects.toThrow();
      expect(await snapshots()).toEqual(before);
      expect(await audits()).toHaveLength(0);
    } finally {
      await fixture.owner.query(
        `GRANT SELECT ON core."omniAccountBinding" TO "${fixture.roleName}"`,
      );
    }
  });
  it('bootstrap first blocks deletion and protects retained records after commit', async () => {
    const ready = barrier(),
      resume = barrier();
    const first = capture(
      bootstrap(graph, async () => {
        ready.release();
        await resume.promise;
      }),
    );
    await ready.promise;
    const second = capture(remove());
    try {
      await blocked();
    } finally {
      resume.release();
    }
    expect(await first).toHaveProperty('value');
    expect(await second).toHaveProperty('error');
    expect(
      await fixture.owner.query(
        'SELECT id FROM core."connectedAccount" WHERE id=$1',
        [graph.account],
      ),
    ).toHaveLength(1);
  });
  it('deletion first blocks bootstrap and prevents a binding on deleted metadata', async () => {
    const hold = pause((sql) => sql.startsWith('WITH deleted AS'));
    const first = capture(remove());
    await hold.reached;
    const second = capture(bootstrap());
    try {
      await blocked();
    } finally {
      hold.resume();
    }
    expect(await first).toHaveProperty('value');
    expect(await second).toHaveProperty('error');
    expect(
      await fixture.owner.query('SELECT id FROM core."omniAccountBinding"'),
    ).toHaveLength(0);
  });
  it('table locks prevent concurrent FK DDL from escaping inventory', async () => {
    const hold = pause((sql) => sql.startsWith('LOCK TABLE'));
    const first = capture(remove());
    await hold.reached;
    const second = capture(
      fixture.owner.query(
        'CREATE TABLE core.delete_extra (parent uuid REFERENCES core."messageFolder"(id) ON DELETE CASCADE)',
      ),
    );
    try {
      await blocked();
    } finally {
      hold.resume();
    }
    expect(await first).toHaveProperty('value');
    expect(await second).toHaveProperty('value');
  });
  it.each(['insert-child', 'reparent-folder'] as const)(
    'deletion first fences concurrent %s',
    async (kind) => {
      const other = await seed(),
        newFolder = randomUUID();
      const hold = pause(
        (sql) =>
          sql.includes('to_jsonb(record)') &&
          sql.includes('core."messageFolder"') &&
          sql.endsWith('FOR UPDATE'),
      );
      const first = capture(remove());
      await hold.reached;
      const second = capture(
        kind === 'insert-child'
          ? fixture.owner.query(
              'INSERT INTO core."messageFolder"(id,"workspaceId","messageChannelId") VALUES($1,$2,$3)',
              [newFolder, fixture.workspaceId, graph.channel],
            )
          : fixture.owner.query(
              'WITH moved AS (UPDATE core."messageFolder" SET "messageChannelId"=$1 WHERE id=$2 RETURNING id) SELECT * FROM moved',
              [other.channel, graph.folder],
            ),
      );
      try {
        await blocked();
      } finally {
        hold.resume();
      }
      expect(await first).toHaveProperty('value');
      if (kind === 'insert-child') expect(await second).toHaveProperty('error');
      else expect(await second).toEqual({ value: [] });
      expect(await audits()).toHaveLength(4);
    },
  );
  it.each(['insert-child', 'reparent-folder'] as const)(
    'concurrent %s first is reflected in the locked deletion graph',
    async (kind) => {
      const other = await seed(),
        newFolder = randomUUID();
      const writer = fixture.owner.createQueryRunner();
      await writer.connect();
      await writer.startTransaction();
      await writer.query(
        kind === 'insert-child'
          ? 'INSERT INTO core."messageFolder"(id,"workspaceId","messageChannelId") VALUES($1,$2,$3)'
          : 'UPDATE core."messageFolder" SET "messageChannelId"=$1 WHERE id=$2',
        kind === 'insert-child'
          ? [newFolder, fixture.workspaceId, graph.channel]
          : [other.channel, graph.folder],
      );
      const pending = remove();
      try {
        await blocked();
      } finally {
        await writer.commitTransaction();
        await writer.release();
      }
      const result = await pending;
      expect(new Set(result.messageFolderIds)).toEqual(
        new Set(kind === 'insert-child' ? [graph.folder, newFolder] : []),
      );
      expect(await audits()).toHaveLength(kind === 'insert-child' ? 5 : 3);
      if (kind === 'reparent-folder')
        expect(
          await fixture.owner.query(
            'SELECT "messageChannelId" FROM core."messageFolder" WHERE id=$1',
            [graph.folder],
          ),
        ).toEqual([{ messageChannelId: other.channel }]);
    },
  );
  it('reports confirmed postcommit failure while preserving deletion and audit', async () => {
    const subscriber = {
      afterTransactionCommit() {
        throw new Error('delete-postcommit-fault');
      },
    };
    runtime.subscribers.push(subscriber);
    try {
      await expect(remove()).rejects.toBeInstanceOf(CoreAuditPostCommitError);
    } finally {
      runtime.subscribers.splice(runtime.subscribers.indexOf(subscriber), 1);
    }
    expect(
      await fixture.owner.query('SELECT id FROM core."connectedAccount"'),
    ).toHaveLength(0);
    expect(await audits()).toHaveLength(4);
  });
  it('never reports success or replays when COMMIT acknowledgement is lost', async () => {
    const create = runtime.createQueryRunner.bind(runtime);
    jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
      const runner = create(mode);
      if (mode === 'master') {
        const connect = runner.connect.bind(runner);
        let installed = false;
        runner.connect = async () => {
          const connection = await connect();
          if (!installed) {
            installed = true;
            const query = connection.query.bind(connection);
            connection.query = async (...args: unknown[]) => {
              const result = await query(...args);
              if (args[0] === 'COMMIT') throw new Error('lost-commit-ack');
              return result;
            };
          }
          return connection;
        };
      }
      return runner;
    });
    await expect(remove()).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
    expect(
      await fixture.owner.query('SELECT id FROM core."connectedAccount"'),
    ).toHaveLength(0);
    expect(await audits()).toHaveLength(4);
  });
});
