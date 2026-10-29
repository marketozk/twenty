import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema, type QueryRunner } from 'typeorm';

// Entity metadata and the unrelated migration planner are boundary adapters.
// executeForMetadata, its locks, real TypeORM DELETE, and PostgreSQL FKs are real.
jest.mock(
  'src/engine/core-modules/application/connection-provider/connection-provider.entity',
  () => ({ ConnectionProviderEntity: class ConnectionProviderEntity {} }),
);
jest.mock(
  'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/interfaces/workspace-migration-runner-action-handler-service.interface',
  () => ({ WorkspaceMigrationRunnerActionHandler: () => class {} }),
);

const { ConnectionProviderEntity } =
  require('src/engine/core-modules/application/connection-provider/connection-provider.entity') as typeof import('src/engine/core-modules/application/connection-provider/connection-provider.entity');
const { DeleteConnectionProviderActionHandlerService } =
  require('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/connection-provider/services/delete-connection-provider-action-handler.service') as typeof import('src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/connection-provider/services/delete-connection-provider-action-handler.service');

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;
if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
)
  throw new Error('Dedicated fork test database required');
const role = `provider_delete_${randomUUID().replaceAll('-', '')}`;
const providerSchema = new EntitySchema({
  name: 'ConnectionProviderEntity',
  target: ConnectionProviderEntity,
  tableName: 'connectionProvider',
  schema: 'core',
  columns: {
    id: { type: 'uuid', primary: true },
    workspaceId: { type: 'uuid' },
  },
});
const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  extra: { max: 4, statement_timeout: 10000 },
});
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = role;
runtimeUrl.password = 'isolated-provider-fixture';
const runtime = new DataSource({
  type: 'postgres',
  url: runtimeUrl.toString(),
  entities: [providerSchema],
  extra: { max: 4, statement_timeout: 10000 },
});
const workspaceId = randomUUID();
const foreignWorkspaceId = randomUUID();
const providerId = randomUUID();
const otherProviderId = randomUUID();
const accountId = randomUUID();
const handler = new DeleteConnectionProviderActionHandlerService();
type HandlerContext = Parameters<typeof handler.executeForMetadata>[0];
const execute = (queryRunner: QueryRunner, scope: string = workspaceId) =>
  handler.executeForMetadata({
    queryRunner,
    workspaceId: scope,
    flatAction: { entityId: providerId },
  } as HandlerContext);
const executeAndCommit = async (runner: QueryRunner) => {
  await runner.startTransaction();
  try {
    await execute(runner);
    await runner.commitTransaction();
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  }
};
const close = async (runner: QueryRunner) => {
  if (runner.isTransactionActive) await runner.rollbackTransaction();
  if (!runner.isReleased) await runner.release();
};
const providers = () =>
  owner.query('SELECT id FROM core."connectionProvider" ORDER BY id');
const accounts = () =>
  owner.query('SELECT * FROM core."connectedAccount" ORDER BY id');
const capture = (pending: Promise<unknown>) =>
  pending.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const pid = async (runner: QueryRunner): Promise<number> => {
  const [row] = await runner.query('SELECT pg_backend_pid() AS pid');
  return row.pid;
};
const waitForBlocker = async (waiting: number, blocking: number) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    const [row] = await owner.query(
      'SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',
      [waiting, blocking],
    );
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected the exact PostgreSQL backend to block');
};
const insertAccount = (runner: QueryRunner, scope: string = workspaceId) =>
  runner.query(
    'INSERT INTO core."connectedAccount"(id,"workspaceId","connectionProviderId") VALUES($1,$2,$3)',
    [accountId, scope, providerId],
  );

beforeAll(async () => {
  await owner.initialize();
  await owner.query('DROP SCHEMA IF EXISTS core CASCADE; CREATE SCHEMA core');
  await owner.query(`
    CREATE TABLE core."connectionProvider" (id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL);
    CREATE TABLE core."connectedAccount" (
      id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL,
      "connectionProviderId" uuid REFERENCES core."connectionProvider"(id) ON DELETE CASCADE
    );
    CREATE ROLE "${role}" LOGIN PASSWORD 'isolated-provider-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    GRANT USAGE ON SCHEMA core TO "${role}";
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "${role}";
  `);
  await runtime.initialize();
});
beforeEach(async () => {
  await owner.query(
    'TRUNCATE core."connectedAccount",core."connectionProvider"',
  );
  await owner.query(
    'INSERT INTO core."connectionProvider"(id,"workspaceId") VALUES($1,$3),($2,$3)',
    [providerId, otherProviderId, workspaceId],
  );
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (runtime.isInitialized) await runtime.destroy();
  if (owner.isInitialized) {
    await owner.query('DROP SCHEMA IF EXISTS core CASCADE');
    await owner.query(`DROP ROLE IF EXISTS "${role}"`);
    await owner.destroy();
  }
});

describe('actual provider metadata deletion refuses unaudited account cascades', () => {
  it('pins provider identity before waiting for its lock', async () => {
    const runner = runtime.createQueryRunner();
    const action = { entityId: providerId };
    const query = runner.query.bind(runner);
    jest
      .spyOn(runner, 'query')
      .mockImplementation(async (...args: Parameters<QueryRunner['query']>) => {
        const result = await query(...args);
        if (args[0].includes('FOR UPDATE')) action.entityId = otherProviderId;
        return result;
      });
    try {
      await runner.startTransaction();
      await handler.executeForMetadata({
        queryRunner: runner,
        workspaceId,
        flatAction: action,
      } as HandlerContext);
      await runner.commitTransaction();
      expect(await providers()).toEqual([{ id: otherProviderId }]);
    } finally {
      await close(runner);
    }
  });
  it('requires an active transaction before any provider read or delete', async () => {
    const runner = runtime.createQueryRunner();
    await runner.connect();
    const query = jest.spyOn(runner, 'query');
    try {
      await expect(execute(runner)).rejects.toThrow('active transaction');
      expect(query).not.toHaveBeenCalled();
      expect(await providers()).toHaveLength(2);
    } finally {
      await close(runner);
    }
  });

  it.each(['same', 'foreign'] as const)(
    'refuses a remaining %s-workspace account',
    async (scope) => {
      const runner = runtime.createQueryRunner();
      try {
        await insertAccount(
          runner,
          scope === 'same' ? workspaceId : foreignWorkspaceId,
        );
        const before = await accounts();
        await expect(executeAndCommit(runner)).rejects.toThrow(
          'still has connected accounts',
        );
        expect(await accounts()).toEqual(before);
        expect(await providers()).toHaveLength(2);
      } finally {
        await close(runner);
      }
    },
  );

  it('deletes only the empty provider selected in the current workspace', async () => {
    const runner = runtime.createQueryRunner();
    try {
      await executeAndCommit(runner);
      expect(await providers()).toEqual([{ id: otherProviderId }]);
      expect(await accounts()).toEqual([]);
    } finally {
      await close(runner);
    }
  });

  it('does not delete a provider from a foreign workspace', async () => {
    const runner = runtime.createQueryRunner();
    try {
      await runner.startTransaction();
      await execute(runner, foreignWorkspaceId);
      await runner.commitTransaction();
      expect(await providers()).toHaveLength(2);
    } finally {
      await close(runner);
    }
  });

  it('refuses a new account committed between account cleanup and provider migration', async () => {
    const cleanup = runtime.createQueryRunner();
    const migration = runtime.createQueryRunner();
    try {
      await insertAccount(cleanup);
      // The preceding owner has committed its account deletion; no lock survives it.
      await cleanup.startTransaction();
      await cleanup.query('DELETE FROM core."connectedAccount" WHERE id=$1', [
        accountId,
      ]);
      await cleanup.commitTransaction();
      await insertAccount(cleanup);
      const before = await accounts();
      await expect(executeAndCommit(migration)).rejects.toThrow(
        'still has connected accounts',
      );
      expect(await accounts()).toEqual(before);
      expect(await providers()).toHaveLength(2);
    } finally {
      await close(cleanup);
      await close(migration);
    }
  });

  it.each(['insert', 'reparent'] as const)(
    'waits for a prior FK %s, then refuses the committed reference',
    async (kind) => {
      const writer = runtime.createQueryRunner();
      const deleting = runtime.createQueryRunner();
      await writer.connect();
      await deleting.connect();
      const writerPid = await pid(writer),
        deletingPid = await pid(deleting);
      if (kind === 'reparent')
        await writer.query(
          'INSERT INTO core."connectedAccount" VALUES($1,$2,$3)',
          [accountId, workspaceId, otherProviderId],
        );
      await writer.startTransaction();
      if (kind === 'insert') await insertAccount(writer);
      else
        await writer.query(
          'UPDATE core."connectedAccount" SET "connectionProviderId"=$1 WHERE id=$2',
          [providerId, accountId],
        );
      const pending = capture(executeAndCommit(deleting));
      try {
        await waitForBlocker(deletingPid, writerPid);
        await writer.commitTransaction();
        const outcome = await pending;
        expect(outcome).toMatchObject({
          ok: false,
          error: expect.objectContaining({
            message: expect.stringContaining('still has connected accounts'),
          }),
        });
        expect(await accounts()).toEqual([
          { id: accountId, workspaceId, connectionProviderId: providerId },
        ]);
        expect(await providers()).toHaveLength(2);
      } finally {
        await close(writer);
        await pending;
        await close(deleting);
      }
    },
  );

  it.each(['insert', 'reparent'] as const)(
    'provider deletion first blocks FK %s, which fails after commit',
    async (kind) => {
      const writer = runtime.createQueryRunner();
      const deleting = runtime.createQueryRunner();
      await writer.connect();
      await deleting.connect();
      const writerPid = await pid(writer),
        deletingPid = await pid(deleting);
      if (kind === 'reparent')
        await writer.query(
          'INSERT INTO core."connectedAccount" VALUES($1,$2,$3)',
          [accountId, workspaceId, otherProviderId],
        );
      const reached = barrier(),
        resume = barrier();
      const original = deleting.query.bind(deleting);
      jest
        .spyOn(deleting, 'query')
        .mockImplementation(
          async (...args: Parameters<QueryRunner['query']>) => {
            const result = await original(...args);
            if (
              args[0].includes('FROM core."connectionProvider"') &&
              args[0].includes('FOR UPDATE')
            ) {
              reached.release();
              await resume.promise;
            }
            return result;
          },
        );
      const deletion = capture(executeAndCommit(deleting));
      let mutation: ReturnType<typeof capture> | undefined;
      try {
        await Promise.race([
          reached.promise,
          deletion.then(() => {
            throw new Error('Deletion settled before its lock barrier');
          }),
        ]);
        mutation = capture(
          kind === 'insert'
            ? insertAccount(writer)
            : writer.query(
                'UPDATE core."connectedAccount" SET "connectionProviderId"=$1 WHERE id=$2',
                [providerId, accountId],
              ),
        );
        await waitForBlocker(writerPid, deletingPid);
        resume.release();
        expect(await deletion).toEqual({ ok: true });
        expect(await mutation).toMatchObject({
          ok: false,
          error: expect.objectContaining({
            driverError: expect.objectContaining({ code: '23503' }),
          }),
        });
        expect(await providers()).toEqual([{ id: otherProviderId }]);
        expect(await accounts()).toEqual(
          kind === 'insert'
            ? []
            : [
                {
                  id: accountId,
                  workspaceId,
                  connectionProviderId: otherProviderId,
                },
              ],
        );
      } finally {
        resume.release();
        await deletion;
        if (mutation) await mutation;
        await close(writer);
        await close(deleting);
      }
    },
  );
});
