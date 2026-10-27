import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { ForkMigrationRunner } from 'src/database/commands/fork-upgrade/fork-migration-runner';
import { FORK_MIGRATIONS } from 'src/database/commands/fork-upgrade/fork-migrations';
import { isOmniOwnedMessageChannel } from 'src/modules/omnichannel/services/is-omni-owned-message-channel';

const databaseUrl = process.env.FORK_MIGRATION_TEST_URL;

if (
  !databaseUrl ||
  !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(databaseUrl).pathname)
) {
  throw new Error(
    'A dedicated twenty_rob764_test_<16 hex> database is required',
  );
}

const roleName = `channel_ownership_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const password = randomUUID();
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = roleName;
runtimeUrl.password = password;
const owner = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  migrationsRun: false,
  extra: { max: 2, statement_timeout: 10000 },
});
const runtime = new DataSource({
  type: 'postgres',
  url: runtimeUrl.toString(),
  synchronize: false,
  migrationsRun: false,
  extra: { max: 2, statement_timeout: 10000 },
});
const query = {
  executeRawQuery: (
    sql: string,
    parameters?: unknown[],
  ): Promise<Record<string, unknown>[]> => runtime.query(sql, parameters),
};
let workspaceId: string;
let messageChannelId: string;
let bindingId: string;

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
  await owner.query('CREATE TABLE core.workspace (id uuid PRIMARY KEY)');
  await owner.query(
    'CREATE TABLE core."connectedAccount" (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL, "archivedAt" timestamptz, "applicationId" uuid, "connectionProviderId" uuid)',
  );
  await owner.query(
    'CREATE TABLE core."messageChannel" (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL, "connectedAccountId" uuid NOT NULL, type text NOT NULL)',
  );
  await new ForkMigrationRunner(owner, FORK_MIGRATIONS).apply();
  await owner.query(`GRANT USAGE ON SCHEMA core TO "${roleName}"`);
  await owner.query(
    `GRANT SELECT ON core."omniAccountBinding" TO "${roleName}"`,
  );
  workspaceId = randomUUID();
  messageChannelId = randomUUID();
  bindingId = randomUUID();
  const connectedAccountId = randomUUID();
  const queueId = randomUUID();
  await owner.query('INSERT INTO core.workspace VALUES ($1)', [workspaceId]);
  await owner.query(
    'INSERT INTO core."connectedAccount" (id,"workspaceId") VALUES ($1,$2)',
    [connectedAccountId, workspaceId],
  );
  await owner.query(
    'INSERT INTO core."messageChannel" VALUES ($1,$2,$3,\'APP\')',
    [messageChannelId, workspaceId, connectedAccountId],
  );
  await owner.query(
    `INSERT INTO core."omniAccountBinding"
    (id,"workspaceId",platform,"connectorInstanceId","accountId","connectedAccountId","messageChannelId","capabilitiesVersion",capabilities)
    VALUES ($1,$2,'telegram','fixture',$3,$4,$5,'fixture-v1','{}')`,
    [
      bindingId,
      workspaceId,
      randomUUID(),
      connectedAccountId,
      messageChannelId,
    ],
  );
  await owner.query(
    'INSERT INTO core."omniQueue" (id,"workspaceId","bindingId",name) VALUES ($1,$2,$3,\'fixture\')',
    [queueId, workspaceId, bindingId],
  );
  await owner.query(
    'UPDATE core."omniAccountBinding" SET "defaultQueueId"=$1 WHERE id=$2',
    [queueId, bindingId],
  );
});

afterAll(async () => {
  if (runtime.isInitialized) await runtime.destroy();
  if (owner.isInitialized) {
    await owner.query(`DROP OWNED BY "${roleName}"`);
    await owner.query(`DROP ROLE "${roleName}"`);
    await owner.destroy();
  }
});

describe('persisted channel ownership query on PostgreSQL', () => {
  it.each(['inactive', 'active', 'disconnected'])(
    'recognizes binding ownership regardless of %s status',
    async (status) => {
      await owner.query(
        'UPDATE core."omniAccountBinding" SET status=$1 WHERE id=$2',
        [status, bindingId],
      );
      expect(
        await isOmniOwnedMessageChannel(query, workspaceId, messageChannelId),
      ).toBe(true);
    },
  );

  it('does not confuse the same channel ID in another workspace with ownership', async () => {
    expect(
      await isOmniOwnedMessageChannel(query, randomUUID(), messageChannelId),
    ).toBe(false);
  });

  it('does not classify an unrelated ordinary APP channel as owned', async () => {
    const ordinaryChannelId = randomUUID();
    const [account]: { connectedAccountId: string }[] = await owner.query(
      'SELECT "connectedAccountId" FROM core."messageChannel" WHERE id=$1',
      [messageChannelId],
    );
    await owner.query(
      'INSERT INTO core."messageChannel" VALUES ($1,$2,$3,\'APP\')',
      [ordinaryChannelId, workspaceId, account.connectedAccountId],
    );
    expect(
      await isOmniOwnedMessageChannel(query, workspaceId, ordinaryChannelId),
    ).toBe(false);
  });

  it('fails closed when the runtime cannot read ownership', async () => {
    await owner.query(
      `REVOKE SELECT ON core."omniAccountBinding" FROM "${roleName}"`,
    );
    await expect(
      isOmniOwnedMessageChannel(query, workspaceId, messageChannelId),
    ).rejects.toMatchObject({ driverError: { code: '42501' } });
  });

  it('does not silently allow ingestion when the ownership table is unavailable', async () => {
    await owner.query(
      'ALTER TABLE core."omniAccountBinding" RENAME TO "fixtureUnavailableBinding"',
    );
    await expect(
      isOmniOwnedMessageChannel(query, workspaceId, messageChannelId),
    ).rejects.toMatchObject({ driverError: { code: '42P01' } });
  });
});
