import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { ForkMigrationRunner } from 'src/database/commands/fork-upgrade/fork-migration-runner';
import { FORK_MIGRATIONS } from 'src/database/commands/fork-upgrade/fork-migrations';
import { OmniBindingConfigWakeupFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-binding-config-wakeup.migration';
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
const priorMigrations = FORK_MIGRATIONS.slice(0, 5);
let workspaceId: string;
let bindingId: string;
let eventId: string;
let priorRows: unknown[];

const insert = async (
  table: string,
  fields: Record<string, unknown>,
): Promise<string> => {
  const row = { id: randomUUID(), ...fields };
  const keys = Object.keys(row);
  const rows: { id: string }[] = await dataSource.query(
    `INSERT INTO core."${table}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(',')}) RETURNING id`,
    Object.values(row),
  );
  return rows[0].id;
};
const addBinding = async (tenantId: string) =>
  insert('omniAccountBinding', {
    workspaceId: tenantId,
    platform: 'telegram',
    connectorInstanceId: 'schema-fixture',
    accountId: randomUUID(),
    connectedAccountId: await insert('connectedAccount', {}),
    messageChannelId: await insert('messageChannel', {}),
    capabilitiesVersion: 'fixture-v1',
    capabilities: '{}',
  });
const addEvent = (tenantId: string) =>
  insert('omniDomainEvent', {
    workspaceId: tenantId,
    kind: 'binding.config_changed',
    origin: 'configuration_change',
    payloadVersion: 1,
    payload: '{}',
  });
const wakeup = (fields: Record<string, unknown> = {}) =>
  insert('omniBindingConfigWakeup', {
    workspaceId,
    bindingId,
    eventId,
    ...fields,
  });
const apply = () =>
  new ForkMigrationRunner(dataSource, FORK_MIGRATIONS.slice(0, 6)).apply();
const ready = () =>
  new ForkSchemaVerifier(
    dataSource,
    FORK_SCHEMA_CHECKS.slice(0, 6),
  ).verifyReady();
const readPrior = () =>
  Promise.all(
    ['omniAccountBinding', 'omniDomainEvent', 'omniIncomingReceipt'].map(
      (table) => dataSource.query(`SELECT * FROM core."${table}" ORDER BY id`),
    ),
  );

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
  await new ForkMigrationRunner(dataSource, priorMigrations).apply();
  workspaceId = await insert('workspace', {});
  bindingId = await addBinding(workspaceId);
  eventId = await addEvent(workspaceId);
  await insert('omniIncomingReceipt', {
    workspaceId,
    bindingId,
    eventId: randomUUID(),
    kind: 'message.received',
    schemaVersion: 1,
    routeGeneration: '1',
    canonicalPayloadHash: 'a'.repeat(64),
    validatedEnvelope: '{}',
    state: 'blocked_config',
    errorCode: 'configuration_missing',
  });
  priorRows = await readPrior();
});
afterAll(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});

describe('binding config wakeup sixth schema migration', () => {
  it('upgrades populated prefix five without inventing wakeups and replays safely', async () => {
    await new ForkSchemaVerifier(
      dataSource,
      FORK_SCHEMA_CHECKS.slice(0, 5),
    ).verifyReady();
    await expect(ready()).rejects.toThrow('Pending fork migrations');
    expect(FORK_MIGRATIONS[5].migrationId).toBe(
      'omni-1793116941052-binding-config-wakeup',
    );
    expect(await apply()).toEqual([FORK_MIGRATIONS[5].migrationId]);
    expect(
      await dataSource.query('SELECT * FROM core."omniBindingConfigWakeup"'),
    ).toEqual([]);
    expect(await readPrior()).toEqual(priorRows);
    expect(await apply()).toEqual([]);
    await ready();
  });

  it('supports down/up without changing any previous table', async () => {
    await apply();
    await dataSource.transaction(async (manager) => {
      const migration = new OmniBindingConfigWakeupFastInstanceCommand();
      await migration.down(manager.queryRunner!);
      expect(
        await manager.query(
          `SELECT to_regclass('core."omniBindingConfigWakeup"') AS present`,
        ),
      ).toEqual([{ present: null }]);
      await migration.up(manager.queryRunner!);
    });
    expect(await readPrior()).toEqual(priorRows);
    await ready();
  });

  it('sets safe defaults and allows retained future handler versions', async () => {
    await apply();
    const id = await wakeup();
    const [row] = await dataSource.query(
      'SELECT * FROM core."omniBindingConfigWakeup" WHERE id=$1',
      [id],
    );
    expect(row).toMatchObject({
      state: 'pending',
      handlerVersion: 1,
      attempts: 0,
      leaseToken: '0',
      leaseOwner: null,
      leaseUntil: null,
      cursorNextAttemptAt: null,
      cursorReceiptId: null,
      needsRescan: false,
      observedRouteGeneration: null,
      errorCode: null,
    });
    await dataSource.query(
      'UPDATE core."omniBindingConfigWakeup" SET "handlerVersion"=2 WHERE id=$1',
      [id],
    );
    await ready();
  });

  it('retains exact cursor precision and token after a running lease finishes', async () => {
    await apply();
    const id = await wakeup({
      state: 'running',
      leaseOwner: 'fixture-worker',
      leaseToken: '1',
      leaseUntil: '2026-10-27T12:00:00.123456Z',
      cursorNextAttemptAt: '2026-10-27T11:00:00.123456Z',
      cursorReceiptId: randomUUID(),
      needsRescan: true,
      observedRouteGeneration: '9',
    });
    await dataSource.query(
      'UPDATE core."omniBindingConfigWakeup" SET state=\'completed\',"leaseOwner"=NULL,"leaseUntil"=NULL WHERE id=$1',
      [id],
    );
    const [row] = await dataSource.query(
      `SELECT state,"leaseToken",to_char("cursorNextAttemptAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor FROM core."omniBindingConfigWakeup" WHERE id=$1`,
      [id],
    );
    expect(row).toEqual({
      state: 'completed',
      leaseToken: '1',
      cursor: '2026-10-27T11:00:00.123456Z',
    });
  });

  it.each([
    [{ state: 'unknown' }, 'state'],
    [{ handlerVersion: 0 }, 'counters'],
    [{ handlerVersion: -1 }, 'counters'],
    [{ attempts: -1 }, 'counters'],
    [{ leaseToken: '-1' }, 'counters'],
    [{ observedRouteGeneration: '0' }, 'generation'],
    [{ observedRouteGeneration: '-1' }, 'generation'],
    [{ cursorNextAttemptAt: '2026-10-27T12:00:00Z' }, 'cursor'],
    [{ cursorReceiptId: randomUUID() }, 'cursor'],
    [{ errorCode: 'authorization_denied' }, 'error'],
    [{ errorCode: 'unknown' }, 'error'],
    [{ state: 'running' }, 'lease'],
    [{ state: 'running', leaseOwner: 'worker', leaseToken: '1' }, 'lease'],
    [
      { state: 'running', leaseUntil: '2026-10-27T12:00:00Z', leaseToken: '1' },
      'lease',
    ],
    [
      {
        state: 'running',
        leaseOwner: 'worker',
        leaseUntil: '2026-10-27T12:00:00Z',
        leaseToken: '0',
      },
      'lease',
    ],
    [{ state: 'pending', leaseOwner: 'worker' }, 'lease'],
    [
      {
        state: 'completed',
        leaseOwner: 'worker',
        leaseUntil: '2026-10-27T12:00:00Z',
        leaseToken: '1',
      },
      'lease',
    ],
  ] as const)(
    'rejects invalid state %p using %s check',
    async (fields, check) => {
      await apply();
      await expect(wakeup(fields)).rejects.toMatchObject({
        driverError: {
          code: '23514',
          constraint: `CHK_omniBindingConfigWakeup_${check}`,
        },
      });
      expect(
        await dataSource.query('SELECT * FROM core."omniBindingConfigWakeup"'),
      ).toEqual([]);
    },
  );

  it.each([
    'binding_inactive',
    'unsupported_handler',
    'rescan_required',
    'transient_failure',
  ] as const)('accepts closed error code %s', async (errorCode) => {
    await apply();
    await expect(
      wakeup({ state: 'blocked', errorCode }),
    ).resolves.toBeDefined();
  });

  it('enforces one wakeup per workspace/event', async () => {
    await apply();
    await wakeup();
    await expect(wakeup()).rejects.toMatchObject({
      driverError: {
        code: '23505',
        constraint: 'UQ_omniBindingConfigWakeup_event',
      },
    });
  });

  it.each(['event', 'binding'] as const)(
    'rejects a foreign workspace %s',
    async (target) => {
      await apply();
      const foreignWorkspace = await insert('workspace', {});
      const fields =
        target === 'event'
          ? { eventId: await addEvent(foreignWorkspace) }
          : { bindingId: await addBinding(foreignWorkspace) };
      await expect(wakeup(fields)).rejects.toMatchObject({
        driverError: { code: '23503' },
      });
    },
  );

  it.each(['event', 'binding'] as const)(
    'restricts deletion of a retained %s',
    async (target) => {
      await apply();
      const retainedBinding = await addBinding(workspaceId);
      await wakeup({ bindingId: retainedBinding });
      const table =
        target === 'event' ? 'omniDomainEvent' : 'omniAccountBinding';
      await expect(
        dataSource.query(`DELETE FROM core."${table}" WHERE id=$1`, [
          target === 'event' ? eventId : retainedBinding,
        ]),
      ).rejects.toMatchObject({
        driverError: {
          code: '23503',
          constraint:
            target === 'event'
              ? 'FK_7f990cf2ad0376683193eff5f48'
              : 'FK_63f99757b2fea1b29d5bc593815',
        },
      });
    },
  );

  it('refuses unrecorded schema instead of adopting it into the ledger', async () => {
    await dataSource.transaction((manager) =>
      new OmniBindingConfigWakeupFastInstanceCommand().up(manager.queryRunner!),
    );
    await expect(apply()).rejects.toThrow();
    await expect(ready()).rejects.toThrow('Pending fork migrations');
  });

  it.each(['check', 'index'] as const)(
    'refuses completed schema with a removed %s',
    async (variant) => {
      await apply();
      await dataSource.query(
        variant === 'check'
          ? 'ALTER TABLE core."omniBindingConfigWakeup" DROP CONSTRAINT "CHK_omniBindingConfigWakeup_cursor"'
          : 'DROP INDEX core."IDX_omniBindingConfigWakeup_due"',
      );
      await expect(ready()).rejects.toThrow(
        'binding config wakeup schema does not match',
      );
      await expect(apply()).rejects.toThrow(
        'binding config wakeup schema does not match',
      );
    },
  );
});
