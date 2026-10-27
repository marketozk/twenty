import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { ForkMigrationRunner } from 'src/database/commands/fork-upgrade/fork-migration-runner';
import { FORK_MIGRATIONS } from 'src/database/commands/fork-upgrade/fork-migrations';
import { OmniTrustedCaptureFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-trusted-capture.migration';
import { FORK_SCHEMA_CHECKS } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-checks';
import { ForkSchemaVerifier } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-verifier';

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
  extra: { max: 3, statement_timeout: 10000 },
});
const HASH = 'a'.repeat(64);
const historicalMigrations = FORK_MIGRATIONS.slice(0, 4);
const captureMigrations = FORK_MIGRATIONS.slice(0, 5);
let receiptId: string;
let originalReceipt: Record<string, unknown>;

const receipts = (): Promise<Record<string, unknown>[]> =>
  dataSource.query('SELECT * FROM core."omniIncomingReceipt" ORDER BY id');
const insert = async (
  table: string,
  fields: Record<string, unknown>,
): Promise<string> => {
  const row = { id: randomUUID(), ...fields };
  const keys = Object.keys(row);
  const result: { id: string }[] = await dataSource.query(
    `INSERT INTO core."${table}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(',')}) RETURNING id`,
    Object.values(row),
  );
  return result[0].id;
};

beforeAll(async () => {
  await dataSource.initialize();
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
});
beforeEach(async () => {
  await dataSource.query('DROP SCHEMA IF EXISTS crm_audit CASCADE');
  await dataSource.query('DROP SCHEMA IF EXISTS core CASCADE');
  await dataSource.query('CREATE SCHEMA core');
  await dataSource.query('CREATE TABLE core.workspace (id uuid PRIMARY KEY)');
  await dataSource.query(
    'CREATE TABLE core."connectedAccount" (id uuid PRIMARY KEY)',
  );
  await dataSource.query(
    'CREATE TABLE core."messageChannel" (id uuid PRIMARY KEY)',
  );
  await new ForkMigrationRunner(dataSource, historicalMigrations).apply();
  const workspaceId = await insert('workspace', {});
  const connectedAccountId = await insert('connectedAccount', {});
  const messageChannelId = await insert('messageChannel', {});
  const bindingId = await insert('omniAccountBinding', {
    workspaceId,
    platform: 'telegram',
    connectorInstanceId: 'fixture',
    accountId: randomUUID(),
    connectedAccountId,
    messageChannelId,
    capabilitiesVersion: 'fixture-v1',
    capabilities: '{}',
  });
  receiptId = await insert('omniIncomingReceipt', {
    workspaceId,
    bindingId,
    eventId: randomUUID(),
    kind: 'message.received',
    schemaVersion: 1,
    routeGeneration: '1',
    canonicalPayloadHash: HASH,
    validatedEnvelope: '{"fixture":"retained"}',
    state: 'retryable_error',
    attempts: 2,
    errorCode: 'fixture_retry',
  });
  [originalReceipt] = await receipts();
});
afterAll(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});

const apply = () =>
  new ForkMigrationRunner(dataSource, captureMigrations).apply();
const ready = () =>
  new ForkSchemaVerifier(
    dataSource,
    FORK_SCHEMA_CHECKS.slice(0, 5),
  ).verifyReady();
const setCapture = (context: string | null, hash: string | null) =>
  dataSource.query(
    'UPDATE core."omniIncomingReceipt" SET "trustedCaptureContext"=$1::jsonb,"trustedCaptureContextHash"=$2 WHERE id=$3',
    [context, hash, receiptId],
  );

describe('trusted capture context schema on PostgreSQL', () => {
  it('upgrades populated prefix four without inventing provenance and replays without changes', async () => {
    await new ForkSchemaVerifier(
      dataSource,
      FORK_SCHEMA_CHECKS.slice(0, 4),
    ).verifyReady();
    await expect(ready()).rejects.toThrow('Pending fork migrations');
    expect(await apply()).toEqual([FORK_MIGRATIONS[4].migrationId]);
    expect(await receipts()).toEqual([
      {
        ...originalReceipt,
        trustedCaptureContext: null,
        trustedCaptureContextHash: null,
      },
    ]);
    expect(await apply()).toEqual([]);
    await ready();
  });

  it('down restores the exact populated previous table and up preserves legacy receipt state', async () => {
    await apply();
    await dataSource.transaction(async (manager) => {
      const migration = new OmniTrustedCaptureFastInstanceCommand();
      await migration.down(manager.queryRunner!);
      expect(
        await manager.query(
          'SELECT * FROM core."omniIncomingReceipt" ORDER BY id',
        ),
      ).toEqual([originalReceipt]);
      await migration.up(manager.queryRunner!);
    });
    expect(await receipts()).toEqual([
      {
        ...originalReceipt,
        trustedCaptureContext: null,
        trustedCaptureContextHash: null,
      },
    ]);
    await ready();
  });

  it('accepts an object and lowercase SHA-256 pair or an entirely absent legacy pair', async () => {
    await apply();
    await setCapture('{"schemaVersion":1,"fixture":true}', HASH);
    expect((await receipts())[0]).toMatchObject({
      trustedCaptureContext: { schemaVersion: 1, fixture: true },
      trustedCaptureContextHash: HASH,
    });
    await setCapture(null, null);
    expect((await receipts())[0]).toMatchObject({
      trustedCaptureContext: null,
      trustedCaptureContextHash: null,
    });
  });

  it.each([
    ['{}', null],
    [null, HASH],
    ['null', HASH],
    ['[]', HASH],
    ['"scalar"', HASH],
    ['42', HASH],
    ['true', HASH],
    ['{}', 'A'.repeat(64)],
    ['{}', 'a'.repeat(63)],
    ['{}', 'g'.repeat(64)],
  ])('rejects malformed context/hash pairs (%s, %s)', async (context, hash) => {
    await apply();
    await expect(setCapture(context, hash)).rejects.toMatchObject({
      driverError: {
        code: '23514',
        constraint: 'CHK_omniIncomingReceipt_trusted_capture',
      },
    });
    expect(await receipts()).toEqual([
      {
        ...originalReceipt,
        trustedCaptureContext: null,
        trustedCaptureContextHash: null,
      },
    ]);
  });

  it('refuses an unrecorded fifth schema even when the ledger is a valid older prefix', async () => {
    await dataSource.transaction(async (manager) =>
      new OmniTrustedCaptureFastInstanceCommand().up(manager.queryRunner!),
    );
    await expect(apply()).rejects.toThrow(
      'message persistence schema does not match',
    );
  });

  it('refuses a completed fifth ledger entry whose constraint was removed', async () => {
    await apply();
    await dataSource.query(
      'ALTER TABLE core."omniIncomingReceipt" DROP CONSTRAINT "CHK_omniIncomingReceipt_trusted_capture"',
    );
    await expect(ready()).rejects.toThrow(
      'message persistence schema does not match',
    );
    await expect(apply()).rejects.toThrow(
      'message persistence schema does not match',
    );
  });
});
