import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { ForkMigrationRunner } from 'src/database/commands/fork-upgrade/fork-migration-runner';
import { FORK_MIGRATIONS } from 'src/database/commands/fork-upgrade/fork-migrations';
import { OmniEventGovernanceFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-event-governance.migration';
import { ForkSchemaVerifier } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-verifier';
import { FORK_SCHEMA_CHECKS } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-checks';

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
type Row = Record<string, unknown>;
type Fixture = {
  workspaceId: string;
  bindingId: string;
  policyId: string;
  conversationId: string;
  messageLinkId: string;
  eventId: string;
};
let fixture: Fixture;
let oldRows: unknown;

const insert = async (table: string, fields: Row): Promise<string> => {
  const row = { id: randomUUID(), ...fields };
  const keys = Object.keys(row);
  const result: { id: string }[] = await dataSource.query(
    `INSERT INTO core."${table}" (${keys.map((key) => `"${key}"`).join(',')})
     VALUES (${keys.map((_, index) => `$${index + 1}`).join(',')}) RETURNING id`,
    Object.values(row),
  );
  return result[0].id;
};
const seed = async (workspaceId: string = randomUUID()): Promise<Fixture> => {
  await dataSource.query(
    'INSERT INTO core.workspace VALUES ($1) ON CONFLICT DO NOTHING',
    [workspaceId],
  );
  const bindingId = await insert('omniAccountBinding', {
    workspaceId,
    platform: 'telegram',
    connectorInstanceId: 'fixture',
    accountId: randomUUID(),
    connectedAccountId: await insert('connectedAccount', {}),
    messageChannelId: await insert('messageChannel', {}),
    capabilitiesVersion: 'fixture-v1',
    capabilities: '{}',
  });
  const policyId = await insert('omniAutomationPolicy', {
    workspaceId,
    bindingId,
  });
  await insert('omniAutomationPolicyVersion', {
    workspaceId,
    policyId,
    version: '0',
    settings: '{}',
    settingsHash: HASH,
    publishedBy: '{"kind":"system","id":"fixture"}',
    publishedAt: new Date(),
  });
  const conversationId = await insert('omniConversation', {
    workspaceId,
    bindingId,
    providerChatId: randomUUID(),
    messageThreadId: randomUUID(),
    policyId,
    policyVersion: '0',
  });
  const messageLinkId = await insert('omniMessageLink', {
    workspaceId,
    bindingId,
    conversationId,
    rawNativeMessageId: '90071992547409931',
    nativeMessageKey: `v1:${randomUUID()}`,
    nativeMessageKeyVersion: 1,
    messageId: randomUUID(),
    displayOccurredAt: '2026-10-27T00:00:00Z',
    displayTimeSource: 'source',
    immutableAuthorSnapshot: '{}',
    senderProvenance: 'external_human',
    correlationState: 'unresolved',
  });
  const eventId = await insert('omniDomainEvent', {
    workspaceId,
    conversationId,
    kind: 'message.received',
    origin: 'live',
    conversationSequence: '1',
    payloadVersion: 1,
    payload: '{}',
  });
  return {
    workspaceId,
    bindingId,
    policyId,
    conversationId,
    messageLinkId,
    eventId,
  };
};
const rootRow = (context = fixture): Row => ({
  workspaceId: context.workspaceId,
  rootKind: 'domain_event',
  rootId: randomUUID(),
  sourceKey: randomUUID(),
  initialEventIds: [context.eventId],
  origin: 'live',
  scope: '{}',
  coveredRoots: '[]',
  policyId: context.policyId,
  policyVersion: '0',
  maxCrmEffects: '2',
  maxHops: '1',
  state: 'pending',
});
const budgetRow = (root: Row): Row => ({
  workspaceId: root.workspaceId,
  rootKind: root.rootKind,
  rootId: root.rootId,
  policyId: root.policyId,
  policyVersion: root.policyVersion,
  maxReplies: '1',
});
const planRow = (root: Row, context = fixture): Row => ({
  workspaceId: root.workspaceId,
  rootKind: root.rootKind,
  rootId: root.rootId,
  policyId: root.policyId,
  policyVersion: root.policyVersion,
  eventId: context.eventId,
  targets: '[]',
  payloadHash: HASH,
  initialPlan: true,
  state: 'empty',
});
const commandRow = (context = fixture): Row => ({
  workspaceId: context.workspaceId,
  conversationId: context.conversationId,
  actorKind: 'workspaceMember',
  actorId: randomUUID(),
  initiatingActorId: randomUUID(),
  idempotencyKey: randomUUID(),
  payloadHash: HASH,
  payload: '{}',
  policyId: context.policyId,
  policyVersion: '0',
  generation: '1',
  senderClass: 'human',
  contentProvenance: 'human',
  outboundSequence: '1',
});
const slotRow = (root: Row, commandId: string): Row => ({
  workspaceId: root.workspaceId,
  rootKind: root.rootKind,
  rootId: root.rootId,
  replySlot: '1',
  producerKind: 'workflow',
  producerId: randomUUID(),
  commandId,
  payloadHash: HASH,
  effectRef: '{}',
});
const activationRow = (context = fixture): Row => ({
  workspaceId: context.workspaceId,
  bindingId: context.bindingId,
  activationVersion: '1',
  sourcePositionType: 'fixture-sequence',
  boundary: '{"offset":"0"}',
});
const admissionRow = (context = fixture): Row => ({
  workspaceId: context.workspaceId,
  bindingId: context.bindingId,
  conversationId: context.conversationId,
  messageLinkId: context.messageLinkId,
  activationVersion: '1',
  trustedSourcePosition: '{"offset":"1"}',
  eventId: context.eventId,
});
const consumerRow = (context = fixture): Row => ({
  workspaceId: context.workspaceId,
  eventId: context.eventId,
  consumerId: `omni-workflow:${randomUUID()}`,
  pinnedVersionId: randomUUID(),
  executionId: randomUUID(),
});
const rejectsWith = async (operation: Promise<unknown>, code: string) =>
  expect(operation).rejects.toMatchObject({ driverError: { code } });
const snapshotOldRows = () =>
  Promise.all(
    [
      'omniAccountBinding',
      'omniAutomationPolicy',
      'omniAutomationPolicyVersion',
      'omniConversation',
      'omniMessageLink',
      'omniDomainEvent',
    ].map((table) =>
      dataSource.query(
        `SELECT row_to_json(stored_row) AS value FROM core."${table}" stored_row ORDER BY id`,
      ),
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
  await new ForkMigrationRunner(
    dataSource,
    FORK_MIGRATIONS.slice(0, 3),
  ).apply();
  fixture = await seed();
  oldRows = await snapshotOldRows();
  await new ForkMigrationRunner(dataSource, FORK_MIGRATIONS).apply();
});
afterAll(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});

describe('event governance schema on PostgreSQL', () => {
  it('upgrades populated message tables and replays without changing their rows', async () => {
    expect(await snapshotOldRows()).toEqual(oldRows);
    expect(
      await new ForkMigrationRunner(dataSource, FORK_MIGRATIONS).apply(),
    ).toEqual([]);
    expect(
      await dataSource.query(
        'SELECT count(*)::int AS count FROM core."forkMigrationLedger"',
      ),
    ).toEqual([{ count: 4 }]);
    await new ForkSchemaVerifier(dataSource, FORK_SCHEMA_CHECKS).verifyReady();
  });

  it('reverses empty new tables and reapplies without losing the populated previous prefix', async () => {
    await dataSource.transaction(async (manager) => {
      const migration = new OmniEventGovernanceFastInstanceCommand();
      await migration.down(manager.queryRunner!);
      expect(
        await manager.query(
          'SELECT to_regclass(\'core."omniRootExecution"\') AS relation',
        ),
      ).toEqual([{ relation: null }]);
      await migration.up(manager.queryRunner!);
    });
    expect(await snapshotOldRows()).toEqual(oldRows);
    await new ForkSchemaVerifier(dataSource, FORK_SCHEMA_CHECKS).verifyReady();
  });

  it('refuses an orphan root reference in the old prefix and rolls back the new DDL', async () => {
    await dataSource.transaction(async (manager) => {
      await new OmniEventGovernanceFastInstanceCommand().down(
        manager.queryRunner!,
      );
      await manager.query(
        'DELETE FROM core."forkMigrationLedger" WHERE "migrationId"=$1',
        [FORK_MIGRATIONS[3].migrationId],
      );
    });
    const orphanId = randomUUID();
    await dataSource.query(
      'UPDATE core."omniDomainEvent" SET "rootExecutionId"=$1 WHERE id=$2',
      [orphanId, fixture.eventId],
    );
    await rejectsWith(
      new ForkMigrationRunner(dataSource, FORK_MIGRATIONS).apply(),
      '23503',
    );
    expect(
      await dataSource.query(
        'SELECT to_regclass(\'core."omniRootExecution"\') AS relation',
      ),
    ).toEqual([{ relation: null }]);
    expect(
      await dataSource.query(
        'SELECT count(*)::int AS count FROM core."forkMigrationLedger"',
      ),
    ).toEqual([{ count: 3 }]);
    expect(
      await dataSource.query(
        'SELECT "rootExecutionId" FROM core."omniDomainEvent" WHERE id=$1',
        [fixture.eventId],
      ),
    ).toEqual([{ rootExecutionId: orphanId }]);
  });

  it('deduplicates root source independently of retry root IDs', async () => {
    const root = rootRow();
    await insert('omniRootExecution', root);
    await rejectsWith(
      insert('omniRootExecution', { ...root, rootId: randomUUID() }),
      '23505',
    );
    await rejectsWith(
      insert('omniRootExecution', { ...root, sourceKey: randomUUID() }),
      '23505',
    );
  });

  it.each([
    { maxCrmEffects: '-1' },
    { usedCrmEffects: '3' },
    { usedHops: '2' },
    { usedHops: '-1' },
    { initialEventIds: [null] },
  ])('rejects invalid root counters or initial IDs %p', async (change) => {
    await rejectsWith(
      insert('omniRootExecution', { ...rootRow(), ...change }),
      '23514',
    );
  });

  it('rejects cross-tenant roots and mismatched captured root policy in plans and budgets', async () => {
    const foreign = await seed();
    const sibling = await seed(fixture.workspaceId);
    await rejectsWith(
      insert('omniRootExecution', { ...rootRow(), policyId: foreign.policyId }),
      '23503',
    );
    const root = rootRow();
    await insert('omniRootExecution', root);
    await rejectsWith(
      insert('omniReplyBudget', {
        ...budgetRow(root),
        policyId: sibling.policyId,
      }),
      '23503',
    );
    const plan = planRow(root);
    await rejectsWith(
      insert('omniEventDispatchPlan', { ...plan, policyId: sibling.policyId }),
      '23503',
    );
    await rejectsWith(
      insert('omniEventDispatchPlan', { ...plan, eventId: foreign.eventId }),
      '23503',
    );
  });

  it('enforces tenant root references on existing DomainEvent rows', async () => {
    const foreign = await seed();
    const foreignRootId = await insert('omniRootExecution', rootRow(foreign));
    await rejectsWith(
      dataSource.query(
        'UPDATE core."omniDomainEvent" SET "rootExecutionId"=$1 WHERE id=$2',
        [foreignRootId, fixture.eventId],
      ),
      '23503',
    );
    await rejectsWith(
      dataSource.query(
        'UPDATE core."omniDomainEvent" SET "rootExecutionId"=$1 WHERE id=$2',
        [randomUUID(), fixture.eventId],
      ),
      '23503',
    );
    const rootId = await insert('omniRootExecution', rootRow());
    await dataSource.query(
      'UPDATE core."omniDomainEvent" SET "rootExecutionId"=$1 WHERE id=$2',
      [rootId, fixture.eventId],
    );
    expect(
      await dataSource.query(
        'SELECT "rootExecutionId" FROM core."omniDomainEvent" WHERE id=$1',
        [fixture.eventId],
      ),
    ).toEqual([{ rootExecutionId: rootId }]);
  });

  it('retains a zero reply budget without creating a reservation or slot', async () => {
    const root = rootRow();
    await insert('omniRootExecution', root);
    await insert('omniReplyBudget', { ...budgetRow(root), maxReplies: '0' });
    expect(
      await dataSource.query('SELECT "maxReplies" FROM core."omniReplyBudget"'),
    ).toEqual([{ maxReplies: '0' }]);
    expect(
      await dataSource.query(
        'SELECT count(*)::int AS count FROM core."omniReplySlot"',
      ),
    ).toEqual([{ count: 0 }]);
    await rejectsWith(insert('omniReplyBudget', budgetRow(root)), '23505');
  });

  it('shares a bound slot across producers while allowing one command to cover two roots', async () => {
    const first = rootRow();
    const second = rootRow();
    for (const root of [first, second]) {
      await insert('omniRootExecution', root);
      await insert('omniReplyBudget', budgetRow(root));
    }
    const commandId = await insert('omniOutgoingCommand', commandRow());
    await insert('omniReplySlot', slotRow(first, commandId));
    await rejectsWith(
      insert('omniReplySlot', {
        ...slotRow(first, commandId),
        producerKind: 'agent',
      }),
      '23505',
    );
    await insert('omniReplySlot', slotRow(second, commandId));
    expect(
      await dataSource.query(
        'SELECT "commandId", state FROM core."omniReplySlot"',
      ),
    ).toEqual([
      { commandId, state: 'bound' },
      { commandId, state: 'bound' },
    ]);
  });

  it('rejects unbound, zero-numbered, unknown-budget and cross-tenant command slots', async () => {
    const root = rootRow();
    await insert('omniRootExecution', root);
    const commandId = await insert('omniOutgoingCommand', commandRow());
    await rejectsWith(
      insert('omniReplySlot', slotRow(root, commandId)),
      '23503',
    );
    await insert('omniReplyBudget', budgetRow(root));
    await rejectsWith(
      insert('omniReplySlot', { ...slotRow(root, commandId), commandId: null }),
      '23502',
    );
    await rejectsWith(
      insert('omniReplySlot', { ...slotRow(root, commandId), replySlot: '0' }),
      '23514',
    );
    await rejectsWith(
      insert('omniReplySlot', {
        ...slotRow(root, commandId),
        state: 'reserved',
      }),
      '23514',
    );
    const foreignCommandId = await insert(
      'omniOutgoingCommand',
      commandRow(await seed()),
    );
    await rejectsWith(
      insert('omniReplySlot', slotRow(root, foreignCommandId)),
      '23503',
    );
  });

  it('deduplicates charge evidence and enforces charge kinds and hop cost', async () => {
    const root = rootRow();
    await insert('omniRootExecution', root);
    const charge = {
      workspaceId: fixture.workspaceId,
      rootKind: root.rootKind,
      rootId: root.rootId,
      chargeKind: 'crm_effect',
      stableChargeKey: randomUUID(),
      cost: '0',
      executionRef: '{}',
    };
    await insert('omniRootBudgetCharge', charge);
    await rejectsWith(insert('omniRootBudgetCharge', charge), '23505');
    await rejectsWith(
      insert('omniRootBudgetCharge', {
        ...charge,
        stableChargeKey: randomUUID(),
        cost: '-1',
      }),
      '23514',
    );
    await rejectsWith(
      insert('omniRootBudgetCharge', {
        ...charge,
        chargeKind: 'hop',
        cost: '0',
      }),
      '23514',
    );
    await insert('omniRootBudgetCharge', {
      ...charge,
      chargeKind: 'hop',
      cost: '1',
    });
    await rejectsWith(
      insert('omniRootBudgetCharge', { ...charge, rootId: randomUUID() }),
      '23503',
    );
  });

  it.each(['empty', 'suppressed'])(
    'stores an explicit %s dispatch snapshot and refuses a second plan',
    async (state) => {
      const root = rootRow();
      await insert('omniRootExecution', root);
      const plan = { ...planRow(root), state };
      await insert('omniEventDispatchPlan', plan);
      await rejectsWith(
        insert('omniEventDispatchPlan', {
          ...plan,
          targets: '[{"consumerId":"later"}]',
        }),
        '23505',
      );
      expect(
        await dataSource.query(
          'SELECT targets, state, "initialPlan" FROM core."omniEventDispatchPlan"',
        ),
      ).toEqual([{ targets: [], state, initialPlan: true }]);
    },
  );

  it('does not put pinned versions in the consumer deduplication key', async () => {
    const receipt = consumerRow();
    await insert('omniConsumerReceipt', receipt);
    await rejectsWith(
      insert('omniConsumerReceipt', {
        ...receipt,
        pinnedVersionId: randomUUID(),
        executionId: randomUUID(),
      }),
      '23505',
    );
    await insert('omniConsumerReceipt', {
      ...receipt,
      consumerId: 'other-consumer',
    });
    const foreign = await seed();
    await rejectsWith(
      insert('omniConsumerReceipt', {
        ...consumerRow(),
        eventId: foreign.eventId,
      }),
      '23503',
    );
  });

  it('requires a running consumer lease and retains large fencing tokens exactly', async () => {
    await rejectsWith(
      insert('omniConsumerReceipt', { ...consumerRow(), state: 'running' }),
      '23514',
    );
    const receiptId = await insert('omniConsumerReceipt', {
      ...consumerRow(),
      state: 'running',
      leaseToken: '90071992547409931',
      leaseUntil: new Date(),
    });
    expect(
      await dataSource.query(
        'SELECT "leaseToken" FROM core."omniConsumerReceipt" WHERE id=$1',
        [receiptId],
      ),
    ).toEqual([{ leaseToken: '90071992547409931' }]);
  });

  it('does not grant a new automatic admission after an activation version changes', async () => {
    await insert('omniRouteActivation', activationRow());
    await insert('omniRouteActivation', {
      ...activationRow(),
      activationVersion: '2',
    });
    await insert('omniAutomationAdmission', admissionRow());
    await rejectsWith(
      insert('omniAutomationAdmission', {
        ...admissionRow(),
        activationVersion: '2',
      }),
      '23505',
    );
    await rejectsWith(
      insert('omniAutomationAdmission', {
        ...admissionRow(),
        effectKind: 'workflow',
      }),
      '23514',
    );
  });

  it('rejects wrong-binding messages and wrong-conversation events at admission', async () => {
    const sibling = await seed(fixture.workspaceId);
    await insert('omniRouteActivation', activationRow());
    await insert('omniRouteActivation', activationRow(sibling));
    await rejectsWith(
      insert('omniAutomationAdmission', {
        ...admissionRow(),
        bindingId: sibling.bindingId,
      }),
      '23503',
    );
    await rejectsWith(
      insert('omniAutomationAdmission', {
        ...admissionRow(),
        eventId: sibling.eventId,
      }),
      '23503',
    );
    await rejectsWith(
      insert('omniAutomationAdmission', {
        ...admissionRow(),
        activationVersion: '2',
      }),
      '23503',
    );
  });

  it('rejects duplicate and cross-tenant route activation boundaries', async () => {
    await insert('omniRouteActivation', activationRow());
    await rejectsWith(
      insert('omniRouteActivation', {
        ...activationRow(),
        boundary: '{"offset":"99"}',
      }),
      '23505',
    );
    const foreign = await seed();
    await rejectsWith(
      insert('omniRouteActivation', {
        ...activationRow(),
        bindingId: foreign.bindingId,
      }),
      '23503',
    );
    await rejectsWith(
      insert('omniRouteActivation', {
        ...activationRow(),
        activationVersion: '0',
      }),
      '23514',
    );
  });
});
