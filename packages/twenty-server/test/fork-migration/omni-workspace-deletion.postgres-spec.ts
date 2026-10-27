import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import {
  admitOmniWorkspaceDeletion,
  dropOmniUnownedWorkspaceSchema,
  OmniWorkspaceLifecycleOutcomeUnknownError,
} from 'src/modules/omnichannel/services/omni-workspace-deletion';
import { bootstrapOmniAccountBinding } from 'src/modules/omnichannel/services/omni-binding-bootstrap';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';

jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);

const fixture = createOmniNativeMessageFixture();
const runtime = new DataSource({
  type: 'postgres',
  url: fixture.runtimeDatabaseUrl,
  synchronize: false,
  migrationsRun: false,
  extra: { max: 4, statement_timeout: 10000 },
});
let input: Parameters<typeof bootstrapOmniAccountBinding>[2];
const deny = 'OMNI_WORKSPACE_DELETE_REQUIRES_CONTROLLED_PURGE';
const actor = { kind: 'system' as const, id: 'workspace-fixture' };
const bootstrap = (
  authorize: Parameters<typeof bootstrapOmniAccountBinding>[3] = async () =>
    undefined,
) => bootstrapOmniAccountBinding(runtime, actor, input, authorize);
const tombstone = async () =>
  (
    await fixture.owner.query(
      'SELECT "deletedAt"::text AS value FROM core.workspace WHERE id=$1',
      [fixture.workspaceId],
    )
  )[0].value;
const schemaName = (id: string) =>
  `workspace_${BigInt(`0x${id.replaceAll('-', '')}`).toString(36)}`;
const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, promise };
};
const blocked = async () => {
  for (let i = 0; i < 200; i++) {
    const [{ count }] = await fixture.owner.query(
      "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
    );
    if (count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected genuine ownership fence wait');
};

beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid, ADD "archivedAt" timestamptz, ADD "applicationId" uuid, ADD "connectionProviderId" uuid, ADD provider text NOT NULL DEFAULT \'app\'',
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageChannel" ADD "connectedAccountId" uuid',
  );
  await fixture.owner.query(
    `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA core TO "${fixture.roleName}"`,
  );
  await runtime.initialize();
});
beforeEach(async () => {
  await fixture.reset();
  await fixture.owner.query(
    'TRUNCATE core.workspace, core."connectedAccount", core."messageChannel" CASCADE',
  );
  input = {
    workspaceId: fixture.workspaceId,
    platform: 'telegram',
    connectorInstanceId: 'workspace-fixture',
    accountId: 'test-account',
    connectedAccountId: randomUUID(),
    messageChannelId: randomUUID(),
    idempotencyKey: randomUUID(),
    expectedRevision: '0',
  };
  await fixture.owner.query('INSERT INTO core.workspace(id) VALUES ($1)', [
    fixture.workspaceId,
  ]);
  await fixture.owner.query(
    'INSERT INTO core."connectedAccount"(id,"workspaceId") VALUES ($1,$2)',
    [input.connectedAccountId, fixture.workspaceId],
  );
  await fixture.owner.query(
    'INSERT INTO core."messageChannel"(id,"workspaceId",type,"connectedAccountId") VALUES ($1,$2,\'APP\',$3)',
    [input.messageChannelId, fixture.workspaceId, input.connectedAccountId],
  );
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (runtime.isInitialized) await runtime.destroy();
  await fixture.dispose();
});

describe('workspace deletion admission and schema safety', () => {
  it('admits an ordinary workspace once and preserves the exact timestamp on replay', async () => {
    const first = await admitOmniWorkspaceDeletion(
      runtime,
      fixture.workspaceId,
    );
    const exact = await tombstone();
    expect(first).toBeInstanceOf(Date);
    const second = await admitOmniWorkspaceDeletion(
      runtime,
      fixture.workspaceId,
    );
    expect(second).toEqual(first);
    expect(await tombstone()).toBe(exact);
  });
  it.each(['inactive', 'disabled', 'disconnected'])(
    'rejects retained %s binding before marking deletion',
    async (status) => {
      await bootstrap();
      await fixture.owner.query(
        'UPDATE core."omniAccountBinding" SET status=$1',
        [status],
      );
      await expect(
        admitOmniWorkspaceDeletion(runtime, fixture.workspaceId),
      ).rejects.toThrow(deny);
      expect(await tombstone()).toBeNull();
      expect(
        await fixture.owner.query(`SELECT to_regnamespace($1) AS schema`, [
          fixture.schemaName,
        ]),
      ).toEqual([{ schema: fixture.schemaName }]);
    },
  );
  it('protects policy-only retention and has no active-binding shortcut', async () => {
    await fixture.owner.query(
      'INSERT INTO core."omniWorkspacePolicyState"("workspaceId") VALUES ($1)',
      [fixture.workspaceId],
    );
    await expect(
      admitOmniWorkspaceDeletion(runtime, fixture.workspaceId),
    ).rejects.toThrow(deny);
    expect(await tombstone()).toBeNull();
  });
  it('includes additional retained workspace tables from the catalog', async () => {
    await fixture.owner.query(
      'CREATE TABLE core."omniRetentionFixture" ("workspaceId" uuid NOT NULL)',
    );
    try {
      await fixture.owner.query(
        `GRANT SELECT ON core."omniRetentionFixture" TO "${fixture.roleName}"`,
      );
      await fixture.owner.query(
        'INSERT INTO core."omniRetentionFixture" VALUES ($1)',
        [fixture.workspaceId],
      );
      await expect(
        admitOmniWorkspaceDeletion(runtime, fixture.workspaceId),
      ).rejects.toThrow(deny);
    } finally {
      await fixture.owner.query('DROP TABLE core."omniRetentionFixture"');
    }
  });
  it('does not confuse another workspace retention with the requested workspace', async () => {
    const other = randomUUID();
    await fixture.owner.query('INSERT INTO core.workspace(id) VALUES ($1)', [
      other,
    ]);
    await fixture.owner.query(
      'INSERT INTO core."omniWorkspacePolicyState"("workspaceId") VALUES ($1)',
      [other],
    );
    await expect(
      admitOmniWorkspaceDeletion(runtime, fixture.workspaceId),
    ).resolves.toBeInstanceOf(Date);
  });
  it('fails closed when a retained table is unreadable', async () => {
    await fixture.owner.query(
      `REVOKE SELECT ON core."omniWorkspacePolicyState" FROM "${fixture.roleName}"`,
    );
    try {
      await expect(
        admitOmniWorkspaceDeletion(runtime, fixture.workspaceId),
      ).rejects.toThrow();
    } finally {
      await fixture.owner.query(
        `GRANT SELECT ON core."omniWorkspacePolicyState" TO "${fixture.roleName}"`,
      );
    }
    expect(await tombstone()).toBeNull();
  });
  it('fails closed on a missing retention schema', async () => {
    await fixture.owner.query(
      'ALTER TABLE core."omniAccountBinding" RENAME TO "heldAccountBinding"',
    );
    try {
      await expect(
        admitOmniWorkspaceDeletion(runtime, fixture.workspaceId),
      ).rejects.toThrow('OMNI_WORKSPACE_RETENTION_SCHEMA_MISSING');
    } finally {
      await fixture.owner.query(
        'ALTER TABLE core."heldAccountBinding" RENAME TO "omniAccountBinding"',
      );
    }
    expect(await tombstone()).toBeNull();
  });
  it('rejects a missing workspace and invalid workspace ID', async () => {
    await expect(
      admitOmniWorkspaceDeletion(runtime, randomUUID()),
    ).rejects.toThrow('OMNI_WORKSPACE_NOT_FOUND');
    await expect(admitOmniWorkspaceDeletion(runtime, 'bad')).rejects.toThrow(
      'OMNI_INVALID_WORKSPACE_LIFECYCLE_SCOPE',
    );
  });
  it('rejects bootstrap after deletion admission without creating policy', async () => {
    await admitOmniWorkspaceDeletion(runtime, fixture.workspaceId);
    await expect(bootstrap()).rejects.toThrow(
      'OMNI_WORKSPACE_NOT_ACCEPTING_BINDINGS',
    );
    expect(
      await fixture.owner.query(
        'SELECT id FROM core."omniWorkspacePolicyState"',
      ),
    ).toEqual([]);
    expect(
      await fixture.owner.query('SELECT id FROM core."omniAccountBinding"'),
    ).toEqual([]);
  });
  it('releases its ownership fence before nested native cleanup', async () => {
    await admitOmniWorkspaceDeletion(runtime, fixture.workspaceId);
    await fixture.withContext(() =>
      fixture.dataSource.transaction(async (scope) => {
        await scope
          .getRepository('person', { shouldBypassPermissionChecks: true })
          .insert({
            id: randomUUID(),
            name: { firstName: 'Native cleanup context' },
          });
      }),
    );
  });
  it.each(['bootstrap-first', 'delete-first'] as const)(
    'serializes the first binding with deletion: %s',
    async (order) => {
      const entered = barrier();
      const release = barrier();
      const runner = runtime.createQueryRunner('master');
      const query = runner.query.bind(runner);
      if (order === 'delete-first') {
        jest.spyOn(runner, 'query').mockImplementation((async (
          ...args: Parameters<typeof runner.query>
        ) => {
          const result = await query(...args);
          if (args[0].startsWith('UPDATE core.workspace SET')) {
            entered.release();
            await release.promise;
          }
          return result;
        }) as typeof runner.query);
        jest.spyOn(runtime, 'createQueryRunner').mockReturnValueOnce(runner);
      }
      const create = () =>
        bootstrap(async () => {
          if (order === 'bootstrap-first') {
            entered.release();
            await release.promise;
          }
        });
      const remove = () =>
        admitOmniWorkspaceDeletion(runtime, fixture.workspaceId);
      const first = (order === 'bootstrap-first' ? create() : remove()).then(
        (result) => ({ result }),
        (error: Error) => ({ error }),
      );
      await entered.promise;
      const second = (order === 'bootstrap-first' ? remove() : create()).then(
        (result) => ({ result }),
        (error: Error) => ({ error }),
      );
      try {
        await blocked();
      } finally {
        release.release();
      }
      const [one, two] = await Promise.all([first, second]);
      expect(one).toHaveProperty('result');
      expect(two).toMatchObject({
        error: {
          message:
            order === 'bootstrap-first'
              ? deny
              : 'OMNI_WORKSPACE_NOT_ACCEPTING_BINDINGS',
        },
      });
      expect((await tombstone()) === null).toBe(order === 'bootstrap-first');
    },
  );
  it('reports unknown admission on a lost COMMIT ACK and preserves durable retry state', async () => {
    const runner = runtime.createQueryRunner('master');
    const commit = runner.commitTransaction.bind(runner);
    jest.spyOn(runner, 'commitTransaction').mockImplementation(async () => {
      await commit();
      throw new Error('lost ACK');
    });
    jest.spyOn(runtime, 'createQueryRunner').mockReturnValueOnce(runner);
    await expect(
      admitOmniWorkspaceDeletion(runtime, fixture.workspaceId),
    ).rejects.toBeInstanceOf(OmniWorkspaceLifecycleOutcomeUnknownError);
    const exact = await tombstone();
    expect(exact).not.toBeNull();
    await admitOmniWorkspaceDeletion(runtime, fixture.workspaceId);
    expect(await tombstone()).toBe(exact);
  });
  it('destroys a connection with unconfirmed rollback instead of returning its locks to the pool', async () => {
    await fixture.owner.query(
      'INSERT INTO core."omniWorkspacePolicyState"("workspaceId") VALUES ($1)',
      [fixture.workspaceId],
    );
    const runner = runtime.createQueryRunner('master');
    jest
      .spyOn(runner, 'rollbackTransaction')
      .mockRejectedValue(new Error('rollback transport failure'));
    jest.spyOn(runtime, 'createQueryRunner').mockReturnValueOnce(runner);
    await expect(
      admitOmniWorkspaceDeletion(runtime, fixture.workspaceId),
    ).rejects.toThrow('OMNI_CORE_ROLLBACK_UNCONFIRMED');
    expect(runner.isReleased).toBe(true);
    await fixture.owner.query(
      'UPDATE core.workspace SET "deletedAt"=NULL WHERE id=$1',
      [fixture.workspaceId],
    );
    expect(await tombstone()).toBeNull();
  });
  it('denies direct schema deletion before admission or with retained omni data', async () => {
    await expect(
      dropOmniUnownedWorkspaceSchema(runtime, fixture.workspaceId),
    ).rejects.toThrow('OMNI_WORKSPACE_DELETION_NOT_ADMITTED');
    await bootstrap();
    await fixture.owner.query(
      'UPDATE core.workspace SET "deletedAt"=now() WHERE id=$1',
      [fixture.workspaceId],
    );
    await expect(
      dropOmniUnownedWorkspaceSchema(runtime, fixture.workspaceId),
    ).rejects.toThrow(deny);
    expect(
      (
        await fixture.owner.query('SELECT to_regnamespace($1) AS schema', [
          fixture.schemaName,
        ])
      )[0].schema,
    ).toBe(fixture.schemaName);
  });
  it('drops only an admitted ordinary workspace schema and preserves unrelated schemas', async () => {
    const id = randomUUID();
    const schema = schemaName(id);
    await fixture.owner.query('INSERT INTO core.workspace(id) VALUES ($1)', [
      id,
    ]);
    await fixture.owner.query(
      `CREATE SCHEMA "${schema}" AUTHORIZATION "${fixture.roleName}"`,
    );
    try {
      await admitOmniWorkspaceDeletion(runtime, id);
      await dropOmniUnownedWorkspaceSchema(runtime, id);
      expect(
        (
          await fixture.owner.query('SELECT to_regnamespace($1) AS schema', [
            schema,
          ])
        )[0].schema,
      ).toBeNull();
      expect(
        (
          await fixture.owner.query('SELECT to_regnamespace($1) AS schema', [
            fixture.schemaName,
          ])
        )[0].schema,
      ).toBe(fixture.schemaName);
    } finally {
      await fixture.owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });
});
