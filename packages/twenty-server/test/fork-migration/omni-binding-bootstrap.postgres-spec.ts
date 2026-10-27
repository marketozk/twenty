import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { OmniAuditBootstrapFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration';
import { OmniConversationFoundationFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-conversation-foundation.migration';
import {
  bootstrapOmniAccountBinding,
  BootstrapOutcomeUnknownError,
  type BootstrapAuthorizer,
} from 'src/modules/omnichannel/services/omni-binding-bootstrap';

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;

if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
) {
  throw new Error(
    'A dedicated twenty_rob764_test_<16 hex> database is required',
  );
}

const roleName = `bootstrap_runtime_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const password = randomUUID();
const runtimeUrl = new URL(databaseUrl);

runtimeUrl.username = roleName;
runtimeUrl.password = password;

const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  migrationsRun: false,
  extra: { max: 4, statement_timeout: 10000 },
});
const runtime = new DataSource({
  type: 'postgres',
  url: runtimeUrl.toString(),
  synchronize: false,
  migrationsRun: false,
  extra: { max: 8, statement_timeout: 10000 },
});
const actor = { kind: 'workspaceMember' as const, id: randomUUID() };
type Input = Parameters<typeof bootstrapOmniAccountBinding>[2];
let input: Input;
let authorize: BootstrapAuthorizer;

const bootstrap = (changes: Partial<Input> = {}, authorizer = authorize) =>
  bootstrapOmniAccountBinding(
    runtime,
    actor,
    { ...input, ...changes },
    authorizer,
  );

beforeAll(async () => {
  await owner.initialize();
  await owner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await owner.query(
    `CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  await runtime.initialize();
});

beforeEach(async () => {
  await owner.query('DROP SCHEMA IF EXISTS crm_audit CASCADE');
  await owner.query('DROP SCHEMA IF EXISTS core CASCADE');
  await owner.query('CREATE SCHEMA core');
  await owner.query(
    'CREATE TABLE core.workspace (id uuid PRIMARY KEY, "deletedAt" timestamptz)',
  );
  await owner.query(
    'CREATE TABLE core."connectedAccount" (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL, "archivedAt" timestamptz, "applicationId" uuid, "connectionProviderId" uuid, provider text NOT NULL DEFAULT \'app\')',
  );
  await owner.query(
    'CREATE TABLE core."messageChannel" (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL, "connectedAccountId" uuid NOT NULL, type text NOT NULL)',
  );
  await owner.transaction(async (manager) => {
    await new OmniConversationFoundationFastInstanceCommand().up(
      manager.queryRunner!,
    );
    await new OmniAuditBootstrapFastInstanceCommand().up(manager.queryRunner!);
  });
  await owner.query(`GRANT USAGE ON SCHEMA core, crm_audit TO "${roleName}"`);
  await owner.query(
    `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA core TO "${roleName}"`,
  );
  await owner.query(
    `GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA crm_audit TO "${roleName}"`,
  );
  input = {
    workspaceId: randomUUID(),
    platform: 'telegram',
    connectorInstanceId: 'fixture-connector',
    accountId: '90071992547409930001',
    connectedAccountId: randomUUID(),
    messageChannelId: randomUUID(),
    idempotencyKey: randomUUID(),
    expectedRevision: '0',
  };
  await owner.query('INSERT INTO core.workspace(id) VALUES ($1)', [
    input.workspaceId,
  ]);
  await owner.query(
    'INSERT INTO core."connectedAccount" (id, "workspaceId") VALUES ($1,$2)',
    [input.connectedAccountId, input.workspaceId],
  );
  await owner.query(
    'INSERT INTO core."messageChannel" VALUES ($1,$2,$3,\'APP\')',
    [input.messageChannelId, input.workspaceId, input.connectedAccountId],
  );
  authorize = async (queryRunner, request) => {
    expect(queryRunner.isTransactionActive).toBe(true);
    expect(request.workspaceId).toBe(input.workspaceId);
    expect(request.actor).toEqual(actor);
    expect(request.action).toBe('binding.create');
  };
});

afterAll(async () => {
  if (runtime.isInitialized) await runtime.destroy();
  if (owner.isInitialized) {
    await owner.query(`DROP OWNED BY "${roleName}"`);
    await owner.query(`DROP ROLE "${roleName}"`);
    await owner.destroy();
  }
});

afterEach(() => jest.restoreAllMocks());

const counts = async () => {
  const result: Record<string, number> = {};
  for (const table of [
    'omniWorkspacePolicyState',
    'omniAccountBinding',
    'omniAutomationPolicy',
    'omniAutomationPolicyVersion',
    'omniPolicyMutationReceipt',
  ]) {
    const [{ count }] = await owner.query(
      `SELECT count(*)::integer AS count FROM core."${table}"`,
    );
    result[table] = count;
  }
  const [{ count }] = await owner.query(
    'SELECT count(*)::integer AS count FROM crm_audit."crmAuditEntry"',
  );
  result.audit = count;

  return result;
};

describe('inactive binding bootstrap on PostgreSQL', () => {
  it('atomically creates disabled v0, private defaults, audit and receipt', async () => {
    const result = await bootstrap();
    const [binding] = await owner.query(
      'SELECT * FROM core."omniAccountBinding" WHERE id=$1',
      [result.bindingId],
    );
    expect(binding).toMatchObject({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      status: 'inactive',
      defaultQueueId: null,
      defaultConversationMode: 'human',
      autoCreatePersonEnabled: false,
      capabilities: {},
      capabilitiesVersion: 'unverified',
      routeGeneration: '1',
      revision: '1',
    });
    const [policy] = await owner.query(
      'SELECT * FROM core."omniAutomationPolicy" WHERE id=$1',
      [result.policyId],
    );
    const [version] = await owner.query(
      'SELECT * FROM core."omniAutomationPolicyVersion" WHERE "policyId"=$1',
      [result.policyId],
    );
    expect(policy.currentVersion).toBe('0');
    expect(version.settings).toEqual({
      enabled: false,
      maxReplies: 0,
      maxCrmEffects: 0,
      maxHops: 0,
    });
    expect(await counts()).toEqual({
      omniWorkspacePolicyState: 1,
      omniAccountBinding: 1,
      omniAutomationPolicy: 1,
      omniAutomationPolicyVersion: 1,
      omniPolicyMutationReceipt: 1,
      audit: 4,
    });
    const [receipt] = await owner.query(
      'SELECT * FROM core."omniPolicyMutationReceipt"',
    );
    expect(receipt.operationId).toBe(result.operationId);
    const [policyState] = await owner.query(
      'SELECT epoch FROM core."omniWorkspacePolicyState"',
    );
    expect(policyState.epoch).toBe('2');
    const [stateAudit] = await owner.query(
      'SELECT "redactedDiff" FROM crm_audit."crmAuditEntry" WHERE "resourceKind" = \'omniWorkspacePolicyState\'',
    );
    expect(stateAudit.redactedDiff.values.epoch).toEqual({
      before: null,
      after: '2',
    });
    expect(
      JSON.stringify(
        await owner.query('SELECT * FROM crm_audit."crmAuditEntry"'),
      ),
    ).not.toContain(input.accountId);
  });

  it('returns the same result after a lost response without repeating mutation or epoch bump', async () => {
    const first = await bootstrap();
    const before = await counts();
    const second = await bootstrap({
      connectedAccountId: input.connectedAccountId.toUpperCase(),
    });

    expect(second).toEqual(first);
    expect(await counts()).toEqual(before);
    const [state] = await owner.query(
      'SELECT epoch FROM core."omniWorkspacePolicyState"',
    );
    expect(state.epoch).toBe('2');
  });

  it('serializes concurrent identical requests to one committed mutation', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => bootstrap()),
    );

    expect(new Set(results.map((result) => result.operationId)).size).toBe(1);
    expect((await counts()).omniAccountBinding).toBe(1);
    expect((await counts()).audit).toBe(4);
  });

  it('rejects a reused key with changed payload or action', async () => {
    await bootstrap();
    await expect(bootstrap({ accountId: 'different' })).rejects.toThrow(
      'idempotency conflict',
    );
    await owner.query(
      'UPDATE core."omniPolicyMutationReceipt" SET action=\'queue.create\'',
    );
    await expect(bootstrap()).rejects.toThrow('idempotency conflict');
    expect((await counts()).omniAccountBinding).toBe(1);
  });

  it('checks current authorization again before revealing replay results', async () => {
    await bootstrap();
    const denied = async () => {
      throw new Error('Current authorization denied');
    };

    await expect(bootstrap({}, denied)).rejects.toThrow(
      'Current authorization denied',
    );
    const [state] = await owner.query(
      'SELECT epoch FROM core."omniWorkspacePolicyState"',
    );
    expect(state.epoch).toBe('2');
  });

  it('authorizes the stored resource descriptor before returning the retained result', async () => {
    const first = await bootstrap();
    const authorizer: BootstrapAuthorizer = async (_runner, request) => {
      if (request.resourceDescriptor.bindingId === first.bindingId)
        throw new Error('Binding access revoked');
    };

    await expect(bootstrap({}, authorizer)).rejects.toThrow(
      'Binding access revoked',
    );
  });

  it('does not rerun a receipt whose public result expired', async () => {
    await bootstrap();
    await owner.query(
      'UPDATE core."omniPolicyMutationReceipt" SET "resultPublic"=NULL',
    );
    await expect(bootstrap()).rejects.toThrow('result expired');
    expect((await counts()).omniAccountBinding).toBe(1);
  });

  it('does not silently reset a missing policy fence for an existing binding', async () => {
    await bootstrap();
    await owner.query('DELETE FROM core."omniWorkspacePolicyState"');
    await expect(bootstrap()).rejects.toThrow('explicit recovery');
    expect((await counts()).omniWorkspacePolicyState).toBe(0);
    expect((await counts()).omniAccountBinding).toBe(1);
  });

  it.each([
    'account-workspace',
    'channel-workspace',
    'channel-account',
    'archived',
    'application-owned',
    'provider-owned',
    'email',
  ])('rejects invalid native ownership: %s', async (kind) => {
    if (kind === 'account-workspace')
      await owner.query('UPDATE core."connectedAccount" SET "workspaceId"=$1', [
        randomUUID(),
      ]);
    if (kind === 'application-owned')
      await owner.query(
        'UPDATE core."connectedAccount" SET "applicationId"=$1',
        [randomUUID()],
      );
    if (kind === 'provider-owned')
      await owner.query(
        'UPDATE core."connectedAccount" SET "connectionProviderId"=$1',
        [randomUUID()],
      );
    if (kind === 'channel-workspace')
      await owner.query('UPDATE core."messageChannel" SET "workspaceId"=$1', [
        randomUUID(),
      ]);
    if (kind === 'channel-account')
      await owner.query(
        'UPDATE core."messageChannel" SET "connectedAccountId"=$1',
        [randomUUID()],
      );
    if (kind === 'archived')
      await owner.query(
        'UPDATE core."connectedAccount" SET "archivedAt"=now()',
      );
    if (kind === 'email')
      await owner.query('UPDATE core."messageChannel" SET type=\'EMAIL\'');

    await expect(bootstrap()).rejects.toThrow(
      'native account/channel mismatch',
    );
    const { audit, ...business } = await counts();
    expect(Object.values(business).every((count) => count === 0)).toBe(true);
    expect(audit).toBe(1);
    const [attempt] = await owner.query(
      'SELECT outcome, "reasonCode", "attemptId" FROM crm_audit."crmAuditEntry"',
    );
    expect(attempt.outcome).toBe('failed');
    expect(attempt.reasonCode).toBe('bootstrap.failed');
    expect(attempt.attemptId).not.toBeNull();
  });

  it('rolls back every new row when audit insertion is unavailable', async () => {
    await owner.query(
      `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${roleName}"`,
    );
    await expect(bootstrap()).rejects.toThrow(
      'BOOTSTRAP_FAILURE_AUDIT_UNCONFIRMED',
    );
    expect(Object.values(await counts()).every((count) => count === 0)).toBe(
      true,
    );
  });

  it('does not leave policy state behind after denied initial authorization', async () => {
    await expect(
      bootstrap({}, async () => {
        throw new Error('Denied');
      }),
    ).rejects.toThrow('Denied');
    const { audit, ...business } = await counts();
    expect(Object.values(business).every((count) => count === 0)).toBe(true);
    expect(audit).toBe(1);
    const [attempt] = await owner.query(
      'SELECT outcome, "reasonCode" FROM crm_audit."crmAuditEntry"',
    );
    expect(attempt).toEqual({
      outcome: 'denied',
      reasonCode: 'bootstrap.authorization_denied',
    });
  });

  it('rejects an existing natural key under a new request without partial audit or receipt', async () => {
    await bootstrap();
    const before = await counts();
    await expect(bootstrap({ idempotencyKey: randomUUID() })).rejects.toThrow();
    expect(await counts()).toEqual({ ...before, audit: before.audit + 1 });
  });

  it('rejects stale create revision before opening a transaction', async () => {
    await expect(bootstrap({ expectedRevision: '1' as '0' })).rejects.toThrow(
      'Invalid bootstrap input',
    );
    expect(Object.values(await counts()).every((count) => count === 0)).toBe(
      true,
    );
  });

  it('rejects undeclared bootstrap controls instead of silently ignoring activation', async () => {
    const extended = { ...input, status: 'active' };
    await expect(
      bootstrapOmniAccountBinding(runtime, actor, extended, authorize),
    ).rejects.toThrow('Invalid bootstrap input');
    expect(Object.values(await counts()).every((count) => count === 0)).toBe(
      true,
    );
  });

  it('retains the original authorization error and surfaces failed negative audit', async () => {
    await owner.query(
      `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${roleName}"`,
    );
    const original = new Error('fixture authorization unavailable');
    const error = await bootstrap({}, async () => {
      throw original;
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe(
      'BOOTSTRAP_FAILURE_AUDIT_UNCONFIRMED',
    );
    expect((error as AggregateError).errors[0]).toBe(original);
    expect(Object.values(await counts()).every((count) => count === 0)).toBe(
      true,
    );
  });

  it('does not persist raw authorization failure text in the denied audit', async () => {
    await expect(
      bootstrap({}, async () => {
        throw new Error('fixture-secret-do-not-log');
      }),
    ).rejects.toThrow('fixture-secret-do-not-log');
    const attempts = await owner.query(
      'SELECT * FROM crm_audit."crmAuditEntry"',
    );
    expect(attempts).toHaveLength(1);
    expect(JSON.stringify(attempts)).not.toContain('fixture-secret-do-not-log');
  });

  it('reports unknown after lost commit acknowledgement without a false failed audit', async () => {
    const queryRunner = runtime.createQueryRunner('master');
    const commit = queryRunner.commitTransaction.bind(queryRunner);
    jest.spyOn(runtime, 'createQueryRunner').mockReturnValueOnce(queryRunner);
    jest
      .spyOn(queryRunner, 'commitTransaction')
      .mockImplementationOnce(async () => {
        await commit();
        throw new Error('fixture lost commit ACK');
      });
    const error = await bootstrap().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BootstrapOutcomeUnknownError);
    const replay = await bootstrap();
    expect(replay.operationId).toBe(
      (error as BootstrapOutcomeUnknownError).operationId,
    );
    expect((await counts()).audit).toBe(4);
    const failures = await owner.query(
      'SELECT id FROM crm_audit."crmAuditEntry" WHERE outcome <> \'success\'',
    );
    expect(failures).toHaveLength(0);
  });

  it('conservatively reports unknown when commit submission fails before acknowledgement', async () => {
    const queryRunner = runtime.createQueryRunner('master');
    jest.spyOn(runtime, 'createQueryRunner').mockReturnValueOnce(queryRunner);
    jest
      .spyOn(queryRunner, 'commitTransaction')
      .mockRejectedValueOnce(new Error('fixture commit unavailable'));
    await expect(bootstrap()).rejects.toBeInstanceOf(
      BootstrapOutcomeUnknownError,
    );
    expect(Object.values(await counts()).every((count) => count === 0)).toBe(
      true,
    );
  });

  it('does not claim a failed mutation when rollback acknowledgement is unconfirmed', async () => {
    const queryRunner = runtime.createQueryRunner('master');
    const rollback = queryRunner.rollbackTransaction.bind(queryRunner);
    jest.spyOn(runtime, 'createQueryRunner').mockReturnValueOnce(queryRunner);
    jest
      .spyOn(queryRunner, 'rollbackTransaction')
      .mockImplementationOnce(async () => {
        await rollback();
        throw new Error('fixture lost rollback ACK');
      });
    await expect(
      bootstrap({}, async () => {
        throw new Error('Denied');
      }),
    ).rejects.toThrow('BOOTSTRAP_ROLLBACK_UNCONFIRMED');
    expect(Object.values(await counts()).every((count) => count === 0)).toBe(
      true,
    );
  });

  it('preserves unknown commit outcome when releasing the connection fails after commit', async () => {
    const queryRunner = runtime.createQueryRunner('master');
    const release = queryRunner.release.bind(queryRunner);
    jest.spyOn(runtime, 'createQueryRunner').mockReturnValueOnce(queryRunner);
    jest.spyOn(queryRunner, 'release').mockImplementationOnce(async () => {
      await release();
      throw new Error('fixture release unavailable');
    });
    await expect(bootstrap()).rejects.toBeInstanceOf(
      BootstrapOutcomeUnknownError,
    );
    expect((await counts()).audit).toBe(4);
    expect((await counts()).omniPolicyMutationReceipt).toBe(1);
  });
});
