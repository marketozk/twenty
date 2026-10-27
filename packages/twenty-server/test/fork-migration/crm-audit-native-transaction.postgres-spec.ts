import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { DataSource } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import {
  appendCrmAuditAttempt,
  CrmAuditTransactionContext,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import {
  type CrmAuditMutation,
  type CrmAuditOperation,
} from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  NativeTransactionOutcomeUnknownError,
  runInRollbackSafeTransaction,
} from 'src/engine/twenty-orm/datasource/utils/run-in-rollback-safe-transaction.util';
import {
  type WorkspaceTransactionLifecycle,
  type WorkspaceTransactionScope,
} from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;

if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
) {
  throw new Error(
    'A dedicated twenty_rob764_test_<16 hex> database is required',
  );
}

const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  migrationsRun: false,
  extra: { max: 3, statement_timeout: 10000 },
});
const runtimeRole = `native_audit_${randomUUID().replaceAll('-', '')}`;
const runtimeUrl = new URL(databaseUrl);

runtimeUrl.username = runtimeRole;
runtimeUrl.password = 'isolated-native-audit-fixture';

const pool = new Pool({
  connectionString: runtimeUrl.toString(),
  max: 3,
  statement_timeout: 10000,
});
const workspaceId = randomUUID();
const resourceId = randomUUID();
const operation = (): CrmAuditOperation => ({
  workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'system', id: 'isolated-native-audit-fixture' },
});
const mutation = (before = '1', after = '2'): CrmAuditMutation => ({
  resourceKind: 'omniAccountBinding',
  resourceId,
  action: 'update',
  before: { revision: before, capabilities: { token: 'old-private-value' } },
  after: { revision: after, capabilities: { token: 'new-private-value' } },
  securityDescriptor: {
    resourceKind: 'omniAccountBinding',
    resourceId,
    bindingId: resourceId,
  },
});

// Exercises the actual native transaction runner; metadata repositories are not fixtures here.
const scopeFor = (
  client: PoolClient,
  transactionLifecycle: WorkspaceTransactionLifecycle,
): WorkspaceTransactionScope => ({
  workspaceId,
  transactionLifecycle,
  executeRawQuery: async (sql, parameters = []) =>
    (await client.query(sql, parameters)).rows,
  getRepository: () => {
    throw new Error('Native metadata repositories are outside this fixture');
  },
  afterCommit: () => {
    throw new Error('After-commit callbacks are outside this fixture');
  },
});
const transaction = <T>(
  work: (scope: WorkspaceTransactionScope) => Promise<T>,
) =>
  runInRollbackSafeTransaction({
    pool,
    commitOutcome: 'strict',
    work: (client, lifecycle) => work(scopeFor(client, lifecycle)),
  });
const mutateAndAudit = async (scope: WorkspaceTransactionScope) => {
  const executor = createCrmAuditWorkspaceExecutor(scope);
  const audit = new CrmAuditTransactionContext(executor, operation());

  await scope.executeRawQuery(
    'UPDATE core."nativeAuditProbe" SET value=2 WHERE id=1',
  );
  audit.record(mutation());
  await audit.flush();

  return audit;
};
const readState = async () => ({
  probe: (
    await owner.query('SELECT value FROM core."nativeAuditProbe" WHERE id=1')
  )[0].value,
  audit: await owner.query('SELECT * FROM crm_audit."crmAuditEntry"'),
});

beforeAll(async () => {
  await owner.initialize();
  await owner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await owner.query(
    `CREATE ROLE "${runtimeRole}" LOGIN PASSWORD 'isolated-native-audit-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
});

beforeEach(async () => {
  await owner.query('DROP SCHEMA IF EXISTS crm_audit CASCADE');
  await owner.query('DROP SCHEMA IF EXISTS core CASCADE');
  await owner.query('CREATE SCHEMA core');
  await owner.query('CREATE TABLE core.workspace (id uuid PRIMARY KEY)');
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(
    'CREATE TABLE core."nativeAuditProbe" (id integer PRIMARY KEY, value integer NOT NULL)',
  );
  await owner.query('INSERT INTO core."nativeAuditProbe" VALUES (1,1)');
  await owner.query(
    `GRANT USAGE ON SCHEMA core, crm_audit TO "${runtimeRole}"`,
  );
  await owner.query(
    `GRANT SELECT, UPDATE ON core."nativeAuditProbe" TO "${runtimeRole}"`,
  );
  await owner.query(
    `GRANT SELECT, INSERT ON crm_audit."crmAuditEntry" TO "${runtimeRole}"`,
  );
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  await pool.end();
  if (owner.isInitialized) {
    await owner.query('DROP SCHEMA IF EXISTS crm_audit CASCADE');
    await owner.query('DROP SCHEMA IF EXISTS core CASCADE');
    await owner.query(`DROP ROLE "${runtimeRole}"`);
    await owner.destroy();
  }
});

describe('native pg transaction and CRM audit adapter', () => {
  it('uses one backend connection and commits the mutation and audit together', async () => {
    await transaction(async (scope) => {
      const executor = createCrmAuditWorkspaceExecutor(scope);

      expect(await executor.query('SELECT pg_backend_pid() AS pid')).toEqual(
        await scope.executeRawQuery('SELECT pg_backend_pid() AS pid'),
      );
      await mutateAndAudit(scope);
      expect(await readState()).toEqual({ probe: 1, audit: [] });
    });

    const state = await readState();

    expect(state.probe).toBe(2);
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0].outcome).toBe('success');
  });

  it('retains aggregation and redaction through the native executor', async () => {
    await transaction(async (scope) => {
      const audit = new CrmAuditTransactionContext(
        createCrmAuditWorkspaceExecutor(scope),
        operation(),
      );

      audit.record(mutation('1', '2'));
      audit.record(mutation('2', '3'));
      await audit.flush();
    });

    const { audit } = await readState();

    expect(audit).toHaveLength(1);
    expect(audit[0].redactedDiff.values).toEqual({
      revision: { before: '1', after: '3' },
    });
    expect(audit[0].redactedDiff.changedFields).toEqual([
      'capabilities',
      'revision',
    ]);
    expect(JSON.stringify(audit)).not.toContain('private-value');
  });

  it('rolls back both writes when work fails after audit flush', async () => {
    await expect(
      transaction(async (scope) => {
        await mutateAndAudit(scope);
        throw new Error('failure after audit flush');
      }),
    ).rejects.toThrow('failure after audit flush');

    expect(await readState()).toEqual({ probe: 1, audit: [] });
  });

  it('fails closed and rolls back business changes when insert privilege is missing', async () => {
    await owner.query(
      `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${runtimeRole}"`,
    );

    await expect(transaction(mutateAndAudit)).rejects.toThrow(
      'append-only privileges',
    );
    expect(await readState()).toEqual({ probe: 1, audit: [] });
  });

  it('fails closed when the native runtime role can modify audit rows', async () => {
    await owner.query(
      `GRANT UPDATE ON crm_audit."crmAuditEntry" TO "${runtimeRole}"`,
    );

    await expect(transaction(mutateAndAudit)).rejects.toThrow(
      'append-only privileges',
    );
    expect(await readState()).toEqual({ probe: 1, audit: [] });
  });

  it('rolls back the business change when the audit insertion fails', async () => {
    await owner.query(
      'ALTER TABLE crm_audit."crmAuditEntry" ADD CONSTRAINT "reject_fixture_insert" CHECK (false)',
    );

    await expect(transaction(mutateAndAudit)).rejects.toThrow();
    expect(await readState()).toEqual({ probe: 1, audit: [] });
  });

  it('refuses a retained executor and context after commit', async () => {
    const retained = await transaction(async (scope) => ({
      executor: createCrmAuditWorkspaceExecutor(scope),
      audit: await mutateAndAudit(scope),
    }));

    expect(retained.executor.isTransactionActive).toBe(false);
    expect(retained.executor.isReleased).toBe(true);
    await expect(retained.executor.query('SELECT 1')).rejects.toThrow();
    expect(() => retained.audit.record(mutation())).toThrow('must be open');
    await expect(retained.audit.flush()).rejects.toThrow('must be open');
    expect((await readState()).audit).toHaveLength(1);
  });

  it('refuses a retained unflushed context after rollback', async () => {
    let retained: CrmAuditTransactionContext | undefined;

    await expect(
      transaction(async (scope) => {
        retained = new CrmAuditTransactionContext(
          createCrmAuditWorkspaceExecutor(scope),
          operation(),
        );
        retained.record(mutation());
        throw new Error('rollback fixture');
      }),
    ).rejects.toThrow('rollback fixture');
    if (!retained) throw new Error('Context was not captured');

    await expect(retained.flush()).rejects.toThrow('must be open');
    expect(await readState()).toEqual({ probe: 1, audit: [] });
  });

  it('refuses a scope with no lifecycle rather than assuming a transaction', async () => {
    await transaction(async (scope) => {
      const { transactionLifecycle: _lifecycle, ...untracked } = scope;

      expect(() => createCrmAuditWorkspaceExecutor(untracked)).toThrow();
    });
    expect(await readState()).toEqual({ probe: 1, audit: [] });
  });

  it('requires strict outcome handling on the native transaction path', async () => {
    await runInRollbackSafeTransaction({
      pool,
      work: async (client, lifecycle) => {
        expect(() =>
          createCrmAuditWorkspaceExecutor(scopeFor(client, lifecycle)),
        ).toThrow();
      },
    });
    expect(await readState()).toEqual({ probe: 1, audit: [] });
  });

  it('rejects an audit operation for another workspace', async () => {
    await transaction(async (scope) => {
      const executor = createCrmAuditWorkspaceExecutor(scope);

      expect(
        () =>
          new CrmAuditTransactionContext(executor, {
            ...operation(),
            workspaceId: randomUUID(),
          }),
      ).toThrow();
      await expect(
        appendCrmAuditAttempt(
          executor,
          { ...operation(), workspaceId: randomUUID() },
          {
            ...mutation(),
            attemptId: randomUUID(),
            outcome: 'denied',
            reasonCode: 'test_denied',
          },
        ),
      ).rejects.toThrow();
    });
    expect(await readState()).toEqual({ probe: 1, audit: [] });
  });

  it('reports unknown after a real COMMIT with a lost response without adding failure audit', async () => {
    const client = await pool.connect();
    const query = client.query.bind(client);
    const statements: string[] = [];

    jest.spyOn(client, 'query').mockImplementation((async (
      sql: string,
      values?: unknown[],
    ) => {
      statements.push(sql);
      const result = await query(sql, values);

      if (sql === 'COMMIT') throw new Error('lost commit response');

      return result;
    }) as typeof client.query);
    jest
      .spyOn(pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));

    await expect(transaction(mutateAndAudit)).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
    expect(statements).not.toContain('ROLLBACK');

    const state = await readState();

    expect(state.probe).toBe(2);
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0].outcome).toBe('success');
  });

  it('reports unknown on release failure after a confirmed real COMMIT', async () => {
    const client = await pool.connect();
    const release = client.release.bind(client);

    jest
      .spyOn(client, 'release')
      .mockImplementation((destroy?: boolean | Error) => {
        release(destroy);
        throw new Error('release failed after commit');
      });
    jest
      .spyOn(pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));

    await expect(transaction(mutateAndAudit)).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );

    const state = await readState();

    expect(state.probe).toBe(2);
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0].outcome).toBe('success');
  });
});
