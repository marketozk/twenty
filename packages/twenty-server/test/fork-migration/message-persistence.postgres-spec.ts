import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { ForkMigrationRunner } from 'src/database/commands/fork-upgrade/fork-migration-runner';
import { FORK_MIGRATIONS } from 'src/database/commands/fork-upgrade/fork-migrations';
import { OmniMessagePersistenceFastInstanceCommand } from 'src/database/commands/fork-upgrade/steps/omni-message-persistence.migration';
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

  return { workspaceId, bindingId, policyId, conversationId };
};

const linkRow = (context = fixture): Row => ({
  workspaceId: context.workspaceId,
  bindingId: context.bindingId,
  conversationId: context.conversationId,
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
const receiptRow = (context = fixture): Row => ({
  workspaceId: context.workspaceId,
  bindingId: context.bindingId,
  eventId: randomUUID(),
  kind: 'message.received',
  schemaVersion: 1,
  routeGeneration: '1',
  canonicalPayloadHash: HASH,
  validatedEnvelope: '{}',
});
const eventRow = (context = fixture): Row => ({
  workspaceId: context.workspaceId,
  conversationId: context.conversationId,
  kind: 'message.received',
  origin: 'live',
  conversationSequence: '1',
  payloadVersion: 1,
  payload: '{}',
});
const rejectsWith = async (operation: Promise<unknown>, code: string) =>
  expect(operation).rejects.toMatchObject({ driverError: { code } });
const snapshotOldRows = () =>
  dataSource.query(
    `SELECT row_to_json(conversation) AS conversation, row_to_json(binding) AS binding
   FROM core."omniConversation" conversation JOIN core."omniAccountBinding" binding
   ON binding.id = conversation."bindingId" ORDER BY conversation.id`,
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
    FORK_MIGRATIONS.slice(0, 2),
  ).apply();
  fixture = await seed();
  oldRows = await snapshotOldRows();
  await new ForkMigrationRunner(dataSource, FORK_MIGRATIONS).apply();
});
afterAll(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});

describe('message persistence schema on PostgreSQL', () => {
  it('upgrades populated previous prefix and replays without altering earlier records', async () => {
    expect(await snapshotOldRows()).toEqual(oldRows);
    expect(
      await new ForkMigrationRunner(dataSource, FORK_MIGRATIONS).apply(),
    ).toEqual([]);
    expect(
      await dataSource.query(
        'SELECT count(*)::int AS count FROM core."forkMigrationLedger"',
      ),
    ).toEqual([{ count: FORK_MIGRATIONS.length }]);
    await new ForkSchemaVerifier(dataSource, FORK_SCHEMA_CHECKS).verifyReady();
  });

  it('reverses empty new tables and reapplies without losing populated foundation', async () => {
    await dataSource.transaction(async (manager) => {
      const migration = new OmniMessagePersistenceFastInstanceCommand();

      await migration.down(manager.queryRunner!);
      expect(
        await manager.query(
          'SELECT to_regclass(\'core."omniMessageLink"\') AS relation',
        ),
      ).toEqual([{ relation: null }]);
      await migration.up(manager.queryRunner!);
    });
    expect(await snapshotOldRows()).toEqual(oldRows);
    await new ForkSchemaVerifier(dataSource, FORK_SCHEMA_CHECKS).verifyReady();
  });

  it('refuses drift in the new conversation composite key', async () => {
    await dataSource.query(
      'ALTER TABLE core."omniConversation" DROP CONSTRAINT "UQ_omniConversation_binding_id" CASCADE',
    );
    await expect(
      new ForkSchemaVerifier(dataSource, FORK_SCHEMA_CHECKS).verifyReady(),
    ).rejects.toThrow();
  });

  it('keeps provider IDs and lease counters above JavaScript safe integer exact', async () => {
    const linkId = await insert('omniMessageLink', linkRow());
    const receiptId = await insert('omniIncomingReceipt', {
      ...receiptRow(),
      leaseToken: '90071992547409931',
    });

    expect(
      await dataSource.query(
        'SELECT "rawNativeMessageId" FROM core."omniMessageLink" WHERE id=$1',
        [linkId],
      ),
    ).toEqual([{ rawNativeMessageId: '90071992547409931' }]);
    expect(
      await dataSource.query(
        'SELECT "leaseToken" FROM core."omniIncomingReceipt" WHERE id=$1',
        [receiptId],
      ),
    ).toEqual([{ leaseToken: '90071992547409931' }]);
  });

  it('rejects duplicate native messages and duplicate canonical Message linkage', async () => {
    const original = linkRow();

    await insert('omniMessageLink', original);
    await rejectsWith(
      insert('omniMessageLink', { ...original, messageId: randomUUID() }),
      '23505',
    );
    await rejectsWith(
      insert('omniMessageLink', {
        ...original,
        nativeMessageKey: 'v1:another',
      }),
      '23505',
    );
  });

  it('does not let changed generation or payload create a second event receipt', async () => {
    const original = receiptRow();

    await insert('omniIncomingReceipt', original);
    await rejectsWith(
      insert('omniIncomingReceipt', {
        ...original,
        routeGeneration: '2',
        canonicalPayloadHash: 'b'.repeat(64),
      }),
      '23505',
    );
    expect(
      await dataSource.query(
        'SELECT "routeGeneration", "canonicalPayloadHash" FROM core."omniIncomingReceipt"',
      ),
    ).toEqual([{ routeGeneration: '1', canonicalPayloadHash: HASH }]);
  });

  it('enforces tenant and binding ownership before link creation', async () => {
    const otherBinding = await seed(fixture.workspaceId);
    const otherWorkspace = await seed();

    await rejectsWith(
      insert('omniMessageLink', {
        ...linkRow(),
        bindingId: otherBinding.bindingId,
      }),
      '23503',
    );
    await rejectsWith(
      insert('omniMessageLink', {
        ...linkRow(),
        workspaceId: otherWorkspace.workspaceId,
      }),
      '23503',
    );
    await rejectsWith(
      insert('omniIncomingReceipt', {
        ...receiptRow(),
        workspaceId: otherWorkspace.workspaceId,
      }),
      '23503',
    );
  });

  it('keeps replies, replacements and echo correlation within one conversation', async () => {
    const other = await seed(fixture.workspaceId);
    const otherLink = await insert('omniMessageLink', linkRow(other));
    const otherCommand = await insert('omniOutgoingCommand', commandRow(other));

    await rejectsWith(
      insert('omniOutgoingCommand', {
        ...commandRow(),
        replyToMessageLinkId: otherLink,
        resolvedReplyNativeRef: '{}',
      }),
      '23503',
    );
    await rejectsWith(
      insert('omniOutgoingCommand', {
        ...commandRow(),
        replacesCommandId: otherCommand,
      }),
      '23503',
    );
    await rejectsWith(
      insert('omniMessageLink', {
        ...linkRow(),
        outgoingCommandId: otherCommand,
      }),
      '23503',
    );
  });

  it('enforces command intention identity and conversation enqueue sequence separately', async () => {
    const original = commandRow();

    await insert('omniOutgoingCommand', original);
    await rejectsWith(
      insert('omniOutgoingCommand', { ...original, outboundSequence: '2' }),
      '23505',
    );
    await rejectsWith(
      insert('omniOutgoingCommand', {
        ...original,
        idempotencyKey: randomUUID(),
      }),
      '23505',
    );
  });

  it.each([
    { state: 'unknown' },
    { senderClass: 'workflow' },
    { senderClass: 'workflow', referenceId: randomUUID() },
    {
      senderClass: 'ai_turn',
      referenceId: randomUUID(),
      expectedAutomationEpoch: '1',
    },
    { producerTurnId: randomUUID() },
    { replyToMessageLinkId: randomUUID() },
    { outboundSequence: '0' },
    { leaseToken: randomUUID() },
    { policyVersion: '-1' },
  ])('rejects invalid command context %j', async (changes) => {
    await rejectsWith(
      insert('omniOutgoingCommand', { ...commandRow(), ...changes }),
      '23514',
    );
  });

  it('retains unknown outcome without changing the proven acceptance evidence', async () => {
    const id = await insert('omniOutgoingCommand', {
      ...commandRow(),
      state: 'accepted',
      connectorAcceptedEvidence: '{"proof":"journal"}',
      journalSequence: '90071992547409931',
    });

    await dataSource.query(
      'UPDATE core."omniOutgoingCommand" SET state=\'outcome_unknown\', "statusRevision"="statusRevision"+1 WHERE id=$1',
      [id],
    );
    expect(
      await dataSource.query(
        'SELECT state, "journalSequence", "connectorAcceptedEvidence", "statusRevision" FROM core."omniOutgoingCommand" WHERE id=$1',
        [id],
      ),
    ).toEqual([
      {
        state: 'outcome_unknown',
        journalSequence: '90071992547409931',
        connectorAcceptedEvidence: { proof: 'journal' },
        statusRevision: '2',
      },
    ]);
  });

  it.each([
    { state: 'failed' },
    { state: 'processing' },
    { leaseOwner: 'worker' },
    { leaseToken: '-1' },
    { attempts: -1 },
    { routeGeneration: '0' },
    { schemaVersion: 0 },
  ])('rejects invalid receipt lease or state %j', async (changes) => {
    await rejectsWith(
      insert('omniIncomingReceipt', { ...receiptRow(), ...changes }),
      '23514',
    );
  });

  it('accepts a fenced processing receipt and durable blocked configuration', async () => {
    await insert('omniIncomingReceipt', {
      ...receiptRow(),
      state: 'processing',
      leaseOwner: 'worker',
      leaseToken: '1',
      leaseUntil: new Date(),
    });
    await insert('omniIncomingReceipt', {
      ...receiptRow(),
      state: 'blocked_config',
      errorCode: 'missing_queue',
    });
    expect(
      await dataSource.query(
        'SELECT count(*)::int AS count FROM core."omniIncomingReceipt"',
      ),
    ).toEqual([{ count: 2 }]);
  });

  it('deduplicates revisions and target edges while retaining unlink revision', async () => {
    const messageLinkId = await insert('omniMessageLink', linkRow());
    const revision = {
      workspaceId: fixture.workspaceId,
      messageLinkId,
      sourceRevisionKey: 'rev:1',
      sourceEventId: 'opaque:event:1',
      contentHash: HASH,
      tombstone: false,
      origin: 'history_import',
    };

    await insert('omniMessageRevision', revision);
    await rejectsWith(
      insert('omniMessageRevision', {
        ...revision,
        contentHash: 'b'.repeat(64),
      }),
      '23505',
    );
    const target = {
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      objectMetadataId: randomUUID(),
      recordId: randomUUID(),
    };
    const id = await insert('omniConversationTarget', target);

    await dataSource.query(
      'UPDATE core."omniConversationTarget" SET active=false, revision=revision+1 WHERE id=$1 AND revision=1',
      [id],
    );
    await rejectsWith(insert('omniConversationTarget', target), '23505');
    await rejectsWith(
      dataSource.query(
        'UPDATE core."omniConversationTarget" SET revision=0 WHERE id=$1',
        [id],
      ),
      '23514',
    );
    expect(
      await dataSource.query(
        'SELECT active, revision FROM core."omniConversationTarget" WHERE id=$1',
        [id],
      ),
    ).toEqual([{ active: false, revision: '2' }]);
  });

  it('isolates revision and target references between workspaces', async () => {
    const other = await seed();
    const messageLinkId = await insert('omniMessageLink', linkRow());

    await rejectsWith(
      insert('omniMessageRevision', {
        workspaceId: other.workspaceId,
        messageLinkId,
        sourceRevisionKey: 'r',
        sourceEventId: 'e',
        contentHash: HASH,
        tombstone: false,
        origin: 'live',
      }),
      '23503',
    );
    await rejectsWith(
      insert('omniConversationTarget', {
        workspaceId: other.workspaceId,
        conversationId: fixture.conversationId,
        objectMetadataId: randomUUID(),
        recordId: randomUUID(),
      }),
      '23503',
    );
  });

  it('deduplicates conversation sequence but permits independent non-conversation events', async () => {
    await insert('omniDomainEvent', eventRow());
    await rejectsWith(insert('omniDomainEvent', eventRow()), '23505');
    await rejectsWith(
      insert('omniDomainEvent', { ...eventRow(), conversationSequence: null }),
      '23514',
    );
    await rejectsWith(
      insert('omniDomainEvent', { ...eventRow(), conversationId: null }),
      '23514',
    );
    await insert('omniDomainEvent', {
      ...eventRow(),
      conversationId: null,
      conversationSequence: null,
    });
    await insert('omniDomainEvent', {
      ...eventRow(),
      conversationId: null,
      conversationSequence: null,
    });
    expect(
      await dataSource.query(
        'SELECT count(*)::int AS count FROM core."omniDomainEvent"',
      ),
    ).toEqual([{ count: 3 }]);
  });
});
