import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ForkMigrationRunner } from 'src/database/commands/fork-upgrade/fork-migration-runner';
import { FORK_MIGRATIONS } from 'src/database/commands/fork-upgrade/fork-migrations';
import { FORK_SCHEMA_CHECKS } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-checks';
import { ForkSchemaVerifier } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-verifier';

const url = process.env.FORK_MIGRATION_TEST_URL;
if (!url || !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(url).pathname))
  throw new Error('An isolated migration database is required');
const db = new DataSource({
  type: 'postgres',
  url,
  synchronize: false,
  migrationsRun: false,
  extra: { max: 3, statement_timeout: 10000 },
});
const workspaceId = randomUUID();
const migration = FORK_MIGRATIONS[9];
const apply = () => new ForkMigrationRunner(db, FORK_MIGRATIONS).apply();
const verify = () =>
  new ForkSchemaVerifier(db, FORK_SCHEMA_CHECKS).verifyReady();
const fingerprint = async () =>
  (
    await db.query<{ hash: string }[]>(
      `SELECT md5(string_agg(to_jsonb(entry)::text, '' ORDER BY id)) AS hash FROM crm_audit."crmAuditEntry" entry`,
    )
  )[0].hash;
const seed = (count: number) =>
  db.query(
    `INSERT INTO crm_audit."crmAuditEntry"
  ("workspaceId","eventKey","operationId",actor,initiator,action,"resourceKind","resourceId",outcome,"redactedDiff","payloadHash","securityDescriptor")
  SELECT $1, n::text, uuid_generate_v4(), '{}', 'null', 'update', 'crmRecord', uuid_generate_v4()::text, 'success', '{}', repeat('a',64), '{}'
  FROM generate_series(1,$2::integer) n`,
    [workspaceId, count],
  );

beforeAll(async () => {
  await db.initialize();
  await db.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
});
beforeEach(async () => {
  await db.query('DROP SCHEMA IF EXISTS crm_audit CASCADE');
  await db.query('DROP SCHEMA IF EXISTS core CASCADE');
  await db.query('CREATE SCHEMA core');
  await db.query('CREATE TABLE core.workspace(id uuid PRIMARY KEY)');
  await db.query('CREATE TABLE core."connectedAccount"(id uuid PRIMARY KEY)');
  await db.query('CREATE TABLE core."messageChannel"(id uuid PRIMARY KEY)');
  await new ForkMigrationRunner(db, FORK_MIGRATIONS.slice(0, 9)).apply();
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (db.isInitialized) await db.destroy();
});

it('upgrades a populated nine-step prefix without changing audit or CRM, replays, and uses the operation index', async () => {
  await seed(10000);
  await db.query(
    'CREATE TABLE core.existing_crm(id integer PRIMARY KEY, name text)',
  );
  await db.query("INSERT INTO core.existing_crm VALUES (1,'retained CRM')");
  const before = await fingerprint();
  await expect(verify()).rejects.toThrow('Pending fork migrations');
  expect(await apply()).toEqual([migration.migrationId]);
  expect(await apply()).toEqual([]);
  await verify();
  expect(await fingerprint()).toBe(before);
  expect(await db.query('SELECT * FROM core.existing_crm')).toEqual([
    { id: 1, name: 'retained CRM' },
  ]);
  await db.query('ANALYZE crm_audit."crmAuditEntry"');
  const [{ operationId }] = await db.query<{ operationId: string }[]>(
    'SELECT "operationId" FROM crm_audit."crmAuditEntry" LIMIT 1',
  );
  const plan = await db.query(
    'EXPLAIN (FORMAT JSON) SELECT 1 FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1 AND "operationId"=$2 LIMIT 1',
    [workspaceId, operationId],
  );
  expect(JSON.stringify(plan)).toContain(
    'IDX_crmAuditEntry_workspace_operation',
  );
  expect(JSON.stringify(plan)).not.toContain('Seq Scan');
});

it('preserves several audit rows for one operation because the index is not unique', async () => {
  await seed(2);
  await apply();
  await db.query('UPDATE crm_audit."crmAuditEntry" SET "operationId"=$1', [
    randomUUID(),
  ]);
  expect(
    (await db.query('SELECT * FROM crm_audit."crmAuditEntry"')).length,
  ).toBe(2);
  await verify();
});

it('rolls index DDL and ledger back together on SQL failure before completion', async () => {
  await seed(2);
  const before = await fingerprint();
  const original = migration.command.up.bind(migration.command);
  jest.spyOn(migration.command, 'up').mockImplementation(async (q) => {
    await original(q);
    await q.query('SELECT 1 / 0');
  });
  await expect(apply()).rejects.toThrow();
  expect(await fingerprint()).toBe(before);
  expect(
    await db.query(
      'SELECT 1 FROM core."forkMigrationLedger" WHERE "migrationId"=$1',
      [migration.migrationId],
    ),
  ).toEqual([]);
  await new ForkSchemaVerifier(
    db,
    FORK_SCHEMA_CHECKS.slice(0, 9),
  ).verifyReady();
});

it.each([
  '',
  'CREATE INDEX "IDX_crmAuditEntry_workspace_operation" ON crm_audit."crmAuditEntry" ("operationId", "workspaceId")',
  'CREATE INDEX "IDX_crmAuditEntry_workspace_operation" ON crm_audit."crmAuditEntry" ("workspaceId", "operationId") WHERE outcome=\'success\'',
  'CREATE UNIQUE INDEX "IDX_crmAuditEntry_workspace_operation" ON crm_audit."crmAuditEntry" ("workspaceId", "operationId")',
])('rejects missing or altered operation index %#', async (replacement) => {
  await apply();
  await db.query(
    'DROP INDEX crm_audit."IDX_crmAuditEntry_workspace_operation"',
  );
  if (replacement) await db.query(replacement);
  await expect(verify()).rejects.toThrow('does not match');
});

it('refuses an unexplained index without its committed manifest step', async () => {
  await db.transaction((manager) => migration.command.up(manager.queryRunner!));
  await expect(apply()).rejects.toThrow('does not match');
  expect(
    await db.query(
      'SELECT 1 FROM core."forkMigrationLedger" WHERE "migrationId"=$1',
      [migration.migrationId],
    ),
  ).toEqual([]);
});

it('drops only the index on down and preserves audit data through down/up', async () => {
  await seed(2);
  const before = await fingerprint();
  await apply();
  await db.transaction(async (manager) => {
    await migration.command.down(manager.queryRunner!);
    await manager.query(
      'DELETE FROM core."forkMigrationLedger" WHERE "migrationId"=$1',
      [migration.migrationId],
    );
  });
  expect(await fingerprint()).toBe(before);
  await new ForkSchemaVerifier(
    db,
    FORK_SCHEMA_CHECKS.slice(0, 9),
  ).verifyReady();
  await apply();
  await verify();
  expect(await fingerprint()).toBe(before);
});
