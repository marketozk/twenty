import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { DataSource, EntitySchema } from 'typeorm';
import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { deactivateCoreUserWithAudit } from 'src/engine/core-modules/crm-audit/deactivate-core-user-with-audit';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';

const url = process.env.FORK_MIGRATION_TEST_URL;
if (!url || !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(url).pathname))
  throw new Error('Dedicated test database required');
const userId = randomUUID(),
  workspaceId = randomUUID(),
  secondWorkspaceId = randomUUID();
const role = 'core_user_audit_' + randomUUID().replaceAll('-', '');
const userSchema = new EntitySchema({
  name: 'CoreUserDeactivationFixture',
  schema: 'core',
  tableName: 'user',
  columns: {
    id: { type: 'uuid', primary: true },
    email: { type: 'text' },
    passwordHash: { type: 'text' },
    disabled: { type: 'boolean', default: false },
    deletedAt: { type: 'timestamptz', nullable: true, deleteDate: true },
    updatedAt: { type: 'timestamptz', updateDate: true },
  },
});
const owner = new DataSource({
  type: 'postgres',
  url,
  entities: [userSchema],
  extra: { max: 5, statement_timeout: 12000 },
});
const restrictedUrl = new URL(url);
restrictedUrl.username = role;
restrictedUrl.password = 'isolated-core-user';
const runtime = new DataSource({
  type: 'postgres',
  url: restrictedUrl.toString(),
  entities: [userSchema],
  extra: { max: 5, statement_timeout: 12000 },
});
const invalidate = jest.fn<Promise<unknown>, []>();
const operation = (): CrmAuditOperation => ({
  workspaceId,
  operationId: randomUUID(),
  actor: { kind: 'coreUser', id: userId },
  correlationId: randomUUID(),
});
const deactivate = (
  auditOperations: (CrmAuditOperation | undefined)[] = [operation()],
) =>
  deactivateCoreUserWithAudit({
    dataSource: runtime,
    userEntity: userSchema,
    userId,
    auditOperations,
    invalidate,
  });
const account = async () =>
  (
    await owner.query(
      'SELECT to_jsonb(account) AS snapshot FROM core."user" AS account WHERE id=$1',
      [userId],
    )
  )[0]?.snapshot;
const audits = () => owner.query('SELECT * FROM crm_audit."crmAuditEntry"');
beforeAll(async () => {
  await owner.initialize();
  await owner.query(
    'DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS crm_audit CASCADE; CREATE SCHEMA core',
  );
  await owner.synchronize();
  await owner.query(
    'CREATE TABLE core.workspace(id uuid PRIMARY KEY); CREATE TABLE core."userWorkspace"(id uuid PRIMARY KEY,"userId" uuid REFERENCES core."user"(id) ON DELETE CASCADE,"workspaceId" uuid REFERENCES core.workspace(id),"deletedAt" timestamptz)',
  );
  await owner.transaction((manager) =>
    new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!),
  );
  await owner.query(
    `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated-core-user' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; GRANT USAGE ON SCHEMA core,crm_audit TO "${role}"; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "${role}"; GRANT SELECT,INSERT ON crm_audit."crmAuditEntry" TO "${role}"`,
  );
  await runtime.initialize();
});
beforeEach(async () => {
  jest.restoreAllMocks();
  invalidate.mockReset().mockResolvedValue(undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  await owner.query(
    'DROP TRIGGER IF EXISTS corrupt_audit ON crm_audit."crmAuditEntry"; DROP FUNCTION IF EXISTS crm_audit.corrupt_audit(); DROP TRIGGER IF EXISTS corrupt_user ON core."user"; DROP FUNCTION IF EXISTS core.corrupt_user(); TRUNCATE core."user",core."userWorkspace",core.workspace,crm_audit."crmAuditEntry" CASCADE',
  );
  await owner.query('INSERT INTO core.workspace VALUES($1),($2)', [
    workspaceId,
    secondWorkspaceId,
  ]);
  await owner.query(
    'INSERT INTO core."user"(id,email,"passwordHash") VALUES($1,\'private@example.test\',\'secret-password-hash\')',
    [userId],
  );
});
afterAll(async () => {
  jest.restoreAllMocks();
  await runtime.destroy();
  await owner.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
  await owner.destroy();
});

it.each(['coreUser', 'application', 'apiKey', 'system'] as const)(
  'audits account deactivation with trusted %s and no secret fields',
  async (kind) => {
    const identity = operation();
    identity.actor = {
      kind,
      id: kind === 'system' ? 'DestroySoftDeletedWorkspaceJob' : randomUUID(),
    };
    identity.initiator = { kind: 'coreUser', id: randomUUID() };
    expect(await deactivate([identity])).toBe('deleted');
    expect((await account()).deletedAt).toBeTruthy();
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId,
      operationId: identity.operationId,
      actor: identity.actor,
      initiator: identity.initiator,
      resourceKind: 'coreUser',
      resourceId: userId,
      action: 'update',
    });
    expect(JSON.stringify(rows)).not.toMatch(
      /private@|secret-password|passwordHash|email/,
    );
    expect(invalidate).toHaveBeenCalledTimes(1);
  },
);
it('records all supplied former workspace scopes without sharing an operation ID', async () => {
  const first = operation(),
    second = {
      ...operation(),
      workspaceId: secondWorkspaceId,
      correlationId: first.correlationId,
    };
  await deactivate([first, second]);
  const rows = await audits();
  expect(
    new Set(rows.map((row: { workspaceId: string }) => row.workspaceId)),
  ).toEqual(new Set([workspaceId, secondWorkspaceId]));
  expect(
    new Set(rows.map((row: { operationId: string }) => row.operationId)).size,
  ).toBe(2);
});
it('checks active memberships fresh and does not disable their user', async () => {
  await owner.query('INSERT INTO core."userWorkspace" VALUES($1,$2,$3,NULL)', [
    randomUUID(),
    userId,
    secondWorkspaceId,
  ]);
  expect(await deactivate()).toBe('active-memberships');
  expect((await account()).deletedAt).toBeNull();
  expect(await audits()).toEqual([]);
});
it('retained deleted memberships do not block deactivation', async () => {
  await owner.query('INSERT INTO core."userWorkspace" VALUES($1,$2,$3,now())', [
    randomUUID(),
    userId,
    workspaceId,
  ]);
  expect(await deactivate()).toBe('deleted');
});
it('already deleted and missing accounts are no-ops with cache invalidation', async () => {
  await deactivate();
  const previous = await account();
  expect(await deactivate()).toBe('already-deleted');
  expect(await account()).toEqual(previous);
  expect(await audits()).toHaveLength(1);
  await owner.query('DELETE FROM core."user" WHERE id=$1', [userId]);
  expect(await deactivate()).toBe('not-found');
  expect(invalidate).toHaveBeenCalledTimes(3);
});
it('does not invent a workspace for a workspace-less account', async () => {
  expect(await deactivate([])).toBe('deleted');
  expect(await audits()).toEqual([]);
  expect(Logger.prototype.error).toHaveBeenCalledWith(
    'CORE_USER_DEACTIVATION_AUDIT_UNAVAILABLE',
  );
});
it('rejects duplicate or malformed explicit scope before mutation', async () => {
  const identity = operation();
  await expect(deactivate([identity, { ...operation() }])).rejects.toThrow(
    'Duplicate',
  );
  await expect(
    deactivate([{ ...identity, workspaceId: 'invalid' }]),
  ).rejects.toThrow('UUID');
  expect((await account()).deletedAt).toBeNull();
});
it('copies operations before the connection await', async () => {
  const identity = operation(),
    captured = structuredClone(identity),
    create = runtime.createQueryRunner.bind(runtime);
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
    const runner = create(mode),
      connect = runner.connect.bind(runner);
    jest.spyOn(runner, 'connect').mockImplementation(async () => {
      identity.actor.id = randomUUID();
      identity.workspaceId = secondWorkspaceId;
      return connect();
    });
    return runner;
  });
  await deactivate([identity]);
  expect((await audits())[0]).toMatchObject({
    workspaceId: captured.workspaceId,
    actor: captured.actor,
  });
});
it('journal INSERT failure does not restore account access', async () => {
  await owner.query(
    `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${role}"`,
  );
  try {
    expect(await deactivate()).toBe('deleted');
    expect(await audits()).toEqual([]);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'CORE_USER_DEACTIVATION_AUDIT_UNAVAILABLE',
    );
  } finally {
    await owner.query(`GRANT INSERT ON crm_audit."crmAuditEntry" TO "${role}"`);
  }
});
it.each([
  'RETURN NULL;',
  'UPDATE core."user" SET "deletedAt"="deletedAt"+interval \'1 microsecond\'; RETURN NEW;',
  `INSERT INTO core."userWorkspace" VALUES(gen_random_uuid(),'${userId}','${workspaceId}',NULL); RETURN NEW;`,
])(
  'audit savepoint rolls back corrupt journal effects and preserves deactivation: %s',
  async (body) => {
    await owner.query(
      `CREATE FUNCTION crm_audit.corrupt_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$; CREATE TRIGGER corrupt_audit BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.corrupt_audit()`,
    );
    expect(await deactivate()).toBe('deleted');
    expect((await account()).deletedAt).toBeTruthy();
    expect(await audits()).toEqual([]);
    expect(await owner.query('SELECT id FROM core."userWorkspace"')).toEqual(
      [],
    );
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'CORE_USER_DEACTIVATION_AUDIT_UNAVAILABLE',
    );
  },
);
it.each([
  'RETURN NULL;',
  'NEW."passwordHash" := \'rewritten\'; RETURN NEW;',
  `INSERT INTO core."userWorkspace" VALUES(gen_random_uuid(),'${userId}','${workspaceId}',NULL); RETURN NEW;`,
])(
  'mandatory mutation checks reject corruption outside the journal savepoint: %s',
  async (body) => {
    await owner.query(
      `CREATE FUNCTION core.corrupt_user() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$; CREATE TRIGGER corrupt_user BEFORE UPDATE ON core."user" FOR EACH ROW EXECUTE FUNCTION core.corrupt_user()`,
    );
    await expect(deactivate()).rejects.toThrow(
      /effects mismatch|gained active membership/,
    );
    expect((await account()).deletedAt).toBeNull();
    expect(await audits()).toEqual([]);
  },
);
it('concurrent requests deactivate only once', async () => {
  const results = await Promise.all([deactivate(), deactivate()]);
  expect(results.sort()).toEqual(['already-deleted', 'deleted']);
  expect(await audits()).toHaveLength(1);
});
it('lost COMMIT acknowledgement leaves one committed audit and invalidates cache without retry', async () => {
  const create = runtime.createQueryRunner.bind(runtime);
  let commits = 0;
  jest.spyOn(runtime, 'createQueryRunner').mockImplementation((mode) => {
    const runner = create(mode),
      connect = runner.connect.bind(runner);
    let wrapped = false;
    jest.spyOn(runner, 'connect').mockImplementation(async () => {
      const client = await connect();
      if (!wrapped) {
        wrapped = true;
        const query = client.query.bind(client);
        client.query = async (sql: string, ...args: unknown[]) => {
          const result = await query(sql, ...args);
          if (sql === 'COMMIT') {
            commits++;
            throw new Error('lost commit acknowledgement');
          }
          return result;
        };
      }
      return client;
    });
    return runner;
  });
  await expect(deactivate()).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(commits).toBe(1);
  expect((await account()).deletedAt).toBeTruthy();
  expect(await audits()).toHaveLength(1);
  expect(invalidate).toHaveBeenCalledTimes(1);
});
it('cache failure is explicit and does not mask a committed deactivation', async () => {
  invalidate.mockRejectedValue(new Error('cache unavailable'));
  expect(await deactivate()).toBe('deleted');
  expect(Logger.prototype.error).toHaveBeenCalledWith(
    'Core user deletion cache invalidation failed',
  );
});
it('sees membership committed while waiting for the user lock', async () => {
  const blocker = owner.createQueryRunner();
  await blocker.startTransaction();
  await blocker.query('SELECT id FROM core."user" WHERE id=$1 FOR UPDATE', [
    userId,
  ]);
  const pending = deactivate();
  const settled = pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting =
        (
          await owner.query(
            "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",
            [role],
          )
        ).length > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await blocker.query(
      'INSERT INTO core."userWorkspace" VALUES($1,$2,$3,NULL)',
      [randomUUID(), userId, secondWorkspaceId],
    );
    await blocker.commitTransaction();
    expect(await settled).toEqual({ value: 'active-memberships' });
    expect((await account()).deletedAt).toBeNull();
    expect(await audits()).toEqual([]);
  } finally {
    if (blocker.isTransactionActive) await blocker.rollbackTransaction();
    await blocker.release();
    await settled;
  }
});
