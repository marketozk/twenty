import { createHash, randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { OmniConversationFoundationFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-conversation-foundation.migration';
import { verifyConversationFoundation } from 'src/engine/core-modules/omnichannel-storage/migrations/conversation-foundation.check';
import schema from 'src/engine/core-modules/omnichannel-storage/migrations/conversation-foundation.schema.json';
import { snapshotForkTables } from 'src/engine/core-modules/omnichannel-storage/migrations/snapshot-fork-tables';

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;

if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
) {
  throw new Error(
    'A dedicated twenty_rob764_test_<16 hex> database is required',
  );
}

const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  migrationsRun: false,
  extra: { max: 4, statement_timeout: 10000 },
});
const migration = new OmniConversationFoundationFastInstanceCommand();
type SqlExecutor = {
  query: (sql: string, parameters?: unknown[]) => Promise<unknown>;
};
type BindingFixture = {
  workspaceId: string;
  bindingId: string;
  connectedAccountId: string;
  messageChannelId: string;
};

const seedBinding = async (
  workspaceId: string = randomUUID(),
  executor: SqlExecutor = dataSource,
): Promise<BindingFixture> => {
  const bindingId = randomUUID();
  const connectedAccountId = randomUUID();
  const messageChannelId = randomUUID();

  await executor.query(
    'INSERT INTO core.workspace VALUES ($1) ON CONFLICT DO NOTHING',
    [workspaceId],
  );
  await executor.query('INSERT INTO core."connectedAccount" VALUES ($1)', [
    connectedAccountId,
  ]);
  await executor.query('INSERT INTO core."messageChannel" VALUES ($1)', [
    messageChannelId,
  ]);
  await executor.query(
    `INSERT INTO core."omniAccountBinding"
      (id, "workspaceId", platform, "connectorInstanceId", "accountId",
       "connectedAccountId", "messageChannelId", "capabilitiesVersion", capabilities)
      VALUES ($1, $2, 'telegram', 'fixture', $3, $4, $5, 'fixture-v1', '{}')`,
    [
      bindingId,
      workspaceId,
      randomUUID(),
      connectedAccountId,
      messageChannelId,
    ],
  );

  return { workspaceId, bindingId, connectedAccountId, messageChannelId };
};

const seedQueue = async (binding: BindingFixture): Promise<string> => {
  const queueId = randomUUID();

  await dataSource.query(
    `INSERT INTO core."omniQueue" (id, "workspaceId", "bindingId", name)
      VALUES ($1, $2, $3, 'fixture-queue')`,
    [queueId, binding.workspaceId, binding.bindingId],
  );

  return queueId;
};

const seedPolicy = async (
  binding: BindingFixture,
  executor: SqlExecutor = dataSource,
): Promise<string> => {
  const policyId = randomUUID();
  const settings = JSON.stringify({
    enabled: false,
    maxReplies: 0,
    maxCrmEffects: 0,
    maxHops: 0,
  });

  await executor.query(
    `INSERT INTO core."omniAutomationPolicy" (id, "workspaceId", "bindingId")
      VALUES ($1, $2, $3)`,
    [policyId, binding.workspaceId, binding.bindingId],
  );
  await executor.query(
    `INSERT INTO core."omniAutomationPolicyVersion"
      ("workspaceId", "policyId", version, settings, "settingsHash", "publishedBy", "publishedAt")
      VALUES ($1, $2, 0, $3::jsonb, $4, $5::jsonb, now())`,
    [
      binding.workspaceId,
      policyId,
      settings,
      createHash('sha256').update(settings).digest('hex'),
      JSON.stringify({ kind: 'system', id: 'isolated-fixture' }),
    ],
  );
  await executor.query(
    `UPDATE core."omniAutomationPolicy" SET "currentVersion" = 0
      WHERE "workspaceId" = $1 AND id = $2`,
    [binding.workspaceId, policyId],
  );

  return policyId;
};

const seedConversation = async (
  binding: BindingFixture,
  policyId: string,
  queueId: string | null = null,
): Promise<string> => {
  const conversationId = randomUUID();

  await dataSource.query(
    `INSERT INTO core."omniConversation"
      (id, "workspaceId", "bindingId", "providerChatId", "messageThreadId", "queueId", "policyId", "policyVersion")
      VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
    [
      conversationId,
      binding.workspaceId,
      binding.bindingId,
      randomUUID(),
      randomUUID(),
      queueId,
      policyId,
    ],
  );

  return conversationId;
};

beforeAll(async () => {
  await dataSource.initialize();
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
});

beforeEach(async () => {
  await dataSource.query('DROP SCHEMA IF EXISTS core CASCADE');
  await dataSource.query('CREATE SCHEMA core');
  // These parents only exercise FK targets, not native account validation.
  await dataSource.query('CREATE TABLE core.workspace (id uuid PRIMARY KEY)');
  await dataSource.query(
    'CREATE TABLE core."connectedAccount" (id uuid PRIMARY KEY)',
  );
  await dataSource.query(
    'CREATE TABLE core."messageChannel" (id uuid PRIMARY KEY)',
  );
  await dataSource.transaction(async (manager) =>
    migration.up(manager.queryRunner!),
  );
});

afterAll(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});

describe('generated conversation foundation schema on PostgreSQL', () => {
  it('bootstraps an inactive binding and disabled v0 through a nullable head atomically', async () => {
    const binding = await dataSource.transaction(async (manager) => {
      const created = await seedBinding(randomUUID(), manager.queryRunner!);

      await seedPolicy(created, manager.queryRunner!);

      return created;
    });

    expect(
      await dataSource.query(
        `SELECT binding.status, binding."defaultQueueId", binding."defaultConversationMode",
              binding."autoCreatePersonEnabled", policy."currentVersion", version.settings
       FROM core."omniAccountBinding" binding
       JOIN core."omniAutomationPolicy" policy ON policy."bindingId" = binding.id
       JOIN core."omniAutomationPolicyVersion" version
         ON version."policyId" = policy.id AND version.version = policy."currentVersion"
       WHERE binding.id = $1`,
        [binding.bindingId],
      ),
    ).toEqual([
      {
        status: 'inactive',
        defaultQueueId: null,
        defaultConversationMode: 'human',
        autoCreatePersonEnabled: false,
        currentVersion: '0',
        settings: {
          enabled: false,
          maxReplies: 0,
          maxCrmEffects: 0,
          maxHops: 0,
        },
      },
    ]);
  });

  it('requires a default queue for active binding and rejects a queue belonging to another binding', async () => {
    const first = await seedBinding();
    const second = await seedBinding(first.workspaceId);
    const firstQueue = await seedQueue(first);
    const secondQueue = await seedQueue(second);

    await expect(
      dataSource.query(
        `UPDATE core."omniAccountBinding" SET status = 'active' WHERE id = $1`,
        [first.bindingId],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
    await expect(
      dataSource.query(
        `UPDATE core."omniAccountBinding" SET "defaultQueueId" = $2 WHERE id = $1`,
        [first.bindingId, secondQueue],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
    await dataSource.query(
      'UPDATE core."omniQueue" SET active = true WHERE id = $1',
      [firstQueue],
    );
    await dataSource.query(
      `UPDATE core."omniAccountBinding" SET status = 'active', "defaultQueueId" = $2 WHERE id = $1`,
      [first.bindingId, firstQueue],
    );
  });

  it('rejects cross-workspace binding references in queues and external identities', async () => {
    const first = await seedBinding();
    const second = await seedBinding();

    await expect(
      dataSource.query(
        `INSERT INTO core."omniQueue" ("workspaceId", "bindingId", name) VALUES ($1, $2, 'wrong-tenant')`,
        [second.workspaceId, first.bindingId],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
    await expect(
      dataSource.query(
        `INSERT INTO core."omniExternalIdentity" ("workspaceId", "bindingId", "providerPeerId", "verificationSource")
       VALUES ($1, $2, 'peer', 'fixture')`,
        [second.workspaceId, first.bindingId],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
  });

  it('rejects another binding queue or policy even inside the same workspace', async () => {
    const first = await seedBinding();
    const second = await seedBinding(first.workspaceId);
    const firstPolicy = await seedPolicy(first);
    const secondPolicy = await seedPolicy(second);
    const secondQueue = await seedQueue(second);

    await expect(
      seedConversation(first, firstPolicy, secondQueue),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
    await expect(seedConversation(first, secondPolicy)).rejects.toMatchObject({
      driverError: { code: '23503' },
    });
  });

  it('requires an existing policy version for both head and conversation', async () => {
    const binding = await seedBinding();
    const policyId = await seedPolicy(binding);
    const conversationId = await seedConversation(binding, policyId);

    await expect(
      dataSource.query(
        'UPDATE core."omniAutomationPolicy" SET "currentVersion" = 1 WHERE id = $1',
        [policyId],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
    await expect(
      dataSource.query(
        'UPDATE core."omniConversation" SET "policyVersion" = 1 WHERE id = $1',
        [conversationId],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
    const other = await seedBinding();

    await expect(
      dataSource.query(
        `INSERT INTO core."omniAutomationPolicyVersion"
       ("workspaceId", "policyId", version, settings, "settingsHash", "publishedBy", "publishedAt")
       VALUES ($1, $2, 1, '{}', $3, '{}', now())`,
        [other.workspaceId, policyId, 'a'.repeat(64)],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
  });

  it('enforces account and channel natural keys independently', async () => {
    const binding = await seedBinding();
    const other = await seedBinding(binding.workspaceId);

    await expect(
      dataSource.query(
        `UPDATE core."omniAccountBinding" SET "accountId" =
        (SELECT "accountId" FROM core."omniAccountBinding" WHERE id = $2) WHERE id = $1`,
        [other.bindingId, binding.bindingId],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
    await expect(
      dataSource.query(
        'UPDATE core."omniAccountBinding" SET "messageChannelId" = $2 WHERE id = $1',
        [other.bindingId, binding.messageChannelId],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });

  it('enforces conversation and policy natural keys without requiring an application cache lock', async () => {
    const binding = await seedBinding();
    const policyId = await seedPolicy(binding);
    const first = await seedConversation(binding, policyId);
    const second = await seedConversation(binding, policyId);

    await expect(
      dataSource.query(
        `UPDATE core."omniConversation" SET "providerChatId" =
       (SELECT "providerChatId" FROM core."omniConversation" WHERE id = $2) WHERE id = $1`,
        [second, first],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
    await expect(
      dataSource.query(
        'INSERT INTO core."omniAutomationPolicy" ("workspaceId", "bindingId") VALUES ($1, $2)',
        [binding.workspaceId, binding.bindingId],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });

  it('admits exactly one concurrent identity insert for the same provider peer', async () => {
    const binding = await seedBinding();
    const insert = () =>
      dataSource.query(
        `INSERT INTO core."omniExternalIdentity" ("workspaceId", "bindingId", "providerPeerId", "verificationSource")
       VALUES ($1, $2, 'same-peer', 'fixture')`,
        [binding.workspaceId, binding.bindingId],
      );
    const results = await Promise.allSettled([insert(), insert()]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({
      status: 'rejected',
      reason: { driverError: { code: '23505' } },
    });
  });

  it('enforces singleton policy state and per-binding queue and policy-version keys', async () => {
    const binding = await seedBinding();
    const policyId = await seedPolicy(binding);

    await seedQueue(binding);
    await dataSource.query(
      'INSERT INTO core."omniWorkspacePolicyState" ("workspaceId") VALUES ($1)',
      [binding.workspaceId],
    );
    expect(
      await dataSource.query(
        'SELECT epoch, "restoreIncarnation" FROM core."omniWorkspacePolicyState"',
      ),
    ).toEqual([
      {
        epoch: '1',
        restoreIncarnation: expect.stringMatching(/^[a-f0-9-]{36}$/),
      },
    ]);
    await expect(
      dataSource.query(
        'INSERT INTO core."omniWorkspacePolicyState" ("workspaceId") VALUES ($1)',
        [binding.workspaceId],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
    await expect(seedQueue(binding)).rejects.toMatchObject({
      driverError: { code: '23505' },
    });
    await expect(
      dataSource.query(
        `INSERT INTO core."omniAutomationPolicyVersion"
       ("workspaceId", "policyId", version, settings, "settingsHash", "publishedBy", "publishedAt")
       SELECT "workspaceId", "policyId", version, settings, "settingsHash", "publishedBy", "publishedAt"
       FROM core."omniAutomationPolicyVersion" WHERE "policyId" = $1`,
        [policyId],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });

  it('retains bigint precision and treats provider identifiers as text', async () => {
    const binding = await seedBinding();
    const big = '9007199254740993';
    const providerId = '9223372036854775808';

    await dataSource.query(
      'UPDATE core."omniAccountBinding" SET "routeGeneration" = $2, "accountId" = $3 WHERE id = $1',
      [binding.bindingId, big, providerId],
    );
    expect(
      await dataSource.query(
        'SELECT "routeGeneration", "accountId" FROM core."omniAccountBinding" WHERE id = $1',
        [binding.bindingId],
      ),
    ).toEqual([{ routeGeneration: big, accountId: providerId }]);
  });

  it('keeps read cursors separate from membership and preserves dynamic record IDs as references', async () => {
    const binding = await seedBinding();
    const policyId = await seedPolicy(binding);
    const conversationId = await seedConversation(binding, policyId);
    const workspaceMemberId = randomUUID();

    // No dynamic workspace record tables exist in this fixture; domain validation is a later obligation.
    await dataSource.query(
      `INSERT INTO core."omniConversationReadCursor" ("workspaceId", "conversationId", "workspaceMemberId", "lastReadSequence")
       VALUES ($1, $2, $3, 4)`,
      [binding.workspaceId, conversationId, workspaceMemberId],
    );
    expect(
      await dataSource.query(
        'SELECT count(*)::integer AS count FROM core."omniConversationMember"',
      ),
    ).toEqual([{ count: 0 }]);
    await dataSource.query(
      'INSERT INTO core."omniConversationMember" ("workspaceId", "conversationId", "workspaceMemberId") VALUES ($1, $2, $3)',
      [binding.workspaceId, conversationId, workspaceMemberId],
    );
    await expect(
      dataSource.query(
        'INSERT INTO core."omniConversationMember" ("workspaceId", "conversationId", "workspaceMemberId") VALUES ($1, $2, $3)',
        [binding.workspaceId, conversationId, workspaceMemberId],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
    await dataSource.query(
      'DELETE FROM core."omniConversationMember" WHERE "conversationId" = $1',
      [conversationId],
    );
    expect(
      await dataSource.query(
        'SELECT "lastReadSequence" FROM core."omniConversationReadCursor"',
      ),
    ).toEqual([{ lastReadSequence: '4' }]);
    await dataSource.query(
      'UPDATE core."omniConversation" SET "assigneeMemberId" = $2 WHERE id = $1',
      [conversationId, workspaceMemberId],
    );
    await dataSource.query(
      `INSERT INTO core."omniExternalIdentity" ("workspaceId", "bindingId", "providerPeerId", "personId", "verificationSource")
       VALUES ($1, $2, 'peer', $3, 'unverified-fixture')`,
      [binding.workspaceId, binding.bindingId, randomUUID()],
    );
    await expect(
      dataSource.query(
        'INSERT INTO core."omniConversationReadCursor" ("workspaceId", "conversationId", "workspaceMemberId") VALUES ($1, $2, $3)',
        [binding.workspaceId, conversationId, workspaceMemberId],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });

  it('rejects cross-tenant membership and cursor references', async () => {
    const first = await seedBinding();
    const second = await seedBinding();
    const conversationId = await seedConversation(
      first,
      await seedPolicy(first),
    );

    await expect(
      dataSource.query(
        'INSERT INTO core."omniConversationMember" ("workspaceId", "conversationId", "workspaceMemberId") VALUES ($1, $2, $3)',
        [second.workspaceId, conversationId, randomUUID()],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
    await expect(
      dataSource.query(
        'INSERT INTO core."omniConversationReadCursor" ("workspaceId", "conversationId", "workspaceMemberId") VALUES ($1, $2, $3)',
        [second.workspaceId, conversationId, randomUUID()],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
  });

  it('restricts deletion of native account/channel/workspace parents while a binding exists', async () => {
    const binding = await seedBinding();

    await expect(
      dataSource.query('DELETE FROM core."connectedAccount" WHERE id = $1', [
        binding.connectedAccountId,
      ]),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
    await expect(
      dataSource.query('DELETE FROM core."messageChannel" WHERE id = $1', [
        binding.messageChannelId,
      ]),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
    await expect(
      dataSource.query('DELETE FROM core.workspace WHERE id = $1', [
        binding.workspaceId,
      ]),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
  });

  it('rolls back the complete bootstrap transaction after a CHECK violation', async () => {
    const workspaceId = randomUUID();

    await expect(
      dataSource.transaction(async (manager) => {
        const binding = await seedBinding(workspaceId, manager.queryRunner!);

        await seedPolicy(binding, manager.queryRunner!);
        await manager.query(
          'UPDATE core."omniAccountBinding" SET "routeGeneration" = 0 WHERE id = $1',
          [binding.bindingId],
        );
      }),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
    expect(
      await dataSource.query(
        'SELECT count(*)::integer AS count FROM core.workspace WHERE id = $1',
        [workspaceId],
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await dataSource.query(
        'SELECT count(*)::integer AS count FROM core."omniAutomationPolicyVersion"',
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await dataSource.query(
        'SELECT count(*)::integer AS count FROM core."omniAccountBinding"',
      ),
    ).toEqual([{ count: 0 }]);
  });

  it('accepts the generated schema and rejects a changed column default', async () => {
    const queryRunner = dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      expect(
        await snapshotForkTables(
          queryRunner,
          schema.map((table) => table.name),
        ),
      ).toEqual(schema);
      await expect(
        verifyConversationFoundation(queryRunner),
      ).resolves.toBeUndefined();
      await queryRunner.query(
        'ALTER TABLE core."omniAccountBinding" ALTER COLUMN status SET DEFAULT \'active\'',
      );
      await expect(verifyConversationFoundation(queryRunner)).rejects.toThrow(
        'does not match',
      );
    } finally {
      await queryRunner.release();
    }
  });

  it('rejects a composite index with changed column order', async () => {
    const queryRunner = dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.query('DROP INDEX core."IDX_omniConversation_queue"');
      await queryRunner.query(
        'CREATE INDEX "IDX_omniConversation_queue" ON core."omniConversation" ("queueId", "bindingId", "workspaceId")',
      );
      await expect(verifyConversationFoundation(queryRunner)).rejects.toThrow(
        'does not match',
      );
    } finally {
      await queryRunner.release();
    }
  });

  it.each(['NOT VALID', 'DEFERRABLE'])(
    'rejects an otherwise matching foreign key declared %s',
    async (modifier) => {
      const queryRunner = dataSource.createQueryRunner();

      try {
        await queryRunner.connect();
        const constraints: { name: string; definition: string }[] =
          await queryRunner.query(
            `SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid = 'core."omniAccountBinding"'::regclass AND contype = 'f' LIMIT 1`,
          );
        const constraint = constraints[0];
        const identifier = '"' + constraint.name.replace(/"/g, '""') + '"';

        await queryRunner.query(
          `ALTER TABLE core."omniAccountBinding" DROP CONSTRAINT ${identifier}`,
        );
        await queryRunner.query(
          `ALTER TABLE core."omniAccountBinding" ADD CONSTRAINT ${identifier} ${constraint.definition} ${modifier}`,
        );
        await expect(verifyConversationFoundation(queryRunner)).rejects.toThrow(
          'not ready',
        );
      } finally {
        await queryRunner.release();
      }
    },
  );

  it('reverses empty new tables using generated down while preserving native fixture data', async () => {
    const workspaceId = randomUUID();

    await dataSource.query('INSERT INTO core.workspace VALUES ($1)', [
      workspaceId,
    ]);
    await dataSource.transaction(async (manager) =>
      migration.down(manager.queryRunner!),
    );
    expect(
      await dataSource.query(
        `SELECT count(*)::integer AS count FROM pg_tables WHERE schemaname = 'core' AND tablename LIKE 'omni%'`,
      ),
    ).toEqual([{ count: 0 }]);
    expect(await dataSource.query('SELECT * FROM core.workspace')).toEqual([
      { id: workspaceId },
    ]);
    await dataSource.transaction(async (manager) =>
      migration.up(manager.queryRunner!),
    );
    expect(
      await dataSource.query(
        `SELECT count(*)::integer AS count FROM pg_tables WHERE schemaname = 'core' AND tablename LIKE 'omni%'`,
      ),
    ).toEqual([{ count: 9 }]);
  });
});
