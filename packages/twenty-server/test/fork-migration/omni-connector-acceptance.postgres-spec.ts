import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import {
  isOmniConnectorAcceptanceProof,
  omniConnectorAcceptanceSqlPredicate,
} from 'src/modules/omnichannel/contracts/omni-connector-acceptance';
import { createOmniHumanCommandFixture } from 'test/fork-migration/omni-human-command.fixture';

jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock('src/modules/match-participant/match-participant.service', () => ({
  MatchParticipantService: class {},
}));
jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/message-queue/services/message-queue.service',
  () => ({ MessageQueueService: class {} }),
);
jest.mock(
  'src/modules/contact-creation-manager/jobs/create-company-and-contact.job',
  () => ({ CreateCompanyAndContactJob: class {} }),
);
jest.mock(
  'src/modules/messaging/message-import-manager/services/messaging-message-folder-association.service',
  () => ({ MessagingMessageFolderAssociationService: class {} }),
);

const fixture = createOmniHumanCommandFixture();
let context: Awaited<ReturnType<typeof fixture.reset>>;
let commandId: string;
type Input = Parameters<typeof fixture.service.applyOmniConnectorAcceptance>[1];
type Callbacks = Parameters<
  typeof fixture.service.applyOmniConnectorAcceptance
>[2];
const principal = () => ({
  workspaceId: fixture.workspaceId,
  bindingId: context.bindingId,
  actor: { kind: 'system' as const, id: context.principal.actor.id },
});
const core = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const audit = (): Promise<Record<string, unknown>[]> =>
  fixture.owner.query('SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id');
const graph = async () => ({
  conversations: await core('omniConversation'),
  roots: await core('omniRootExecution'),
  events: await core('omniDomainEvent'),
  plans: await core('omniEventDispatchPlan'),
});
const readCommand = async (id = commandId) => {
  const command = (await core('omniOutgoingCommand')).find(
    (row) => row.id === id,
  );
  if (!command) throw new Error('Fixture command not found');
  return command;
};
const input = async (overrides: Partial<Input> = {}): Promise<Input> => {
  const command = await readCommand();
  return {
    commandId,
    providerChatId: 'history-chat',
    payloadHash: String(command.payloadHash),
    generation: String(command.generation),
    connectorJobId: `fixture-job-${commandId}`,
    journalSequence: '1',
    qualification: {
      adapterId: 'fixture-verified-adapter',
      adapterVersion: '1',
    },
    ...overrides,
  };
};
const callbacks = (observation: Input): Callbacks => {
  // Synthetic server journal observation; it does not qualify any live transport.
  const registered = {
    ...observation,
    qualification: { ...observation.qualification },
    schemaVersion: 1,
    evidenceKind: 'connector.durable_acceptance',
    workspaceId: fixture.workspaceId,
    bindingId: context.bindingId,
    conversationId: context.conversationId,
  };
  return {
    authorize: async (scope, descriptor) => {
      expect(scope.workspaceId).toBe(fixture.workspaceId);
      expect(descriptor).toMatchObject({
        principal: principal(),
        action: 'command.acceptance',
        bindingId: context.bindingId,
        conversationId: context.conversationId,
      });
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(descriptor.command).not.toHaveProperty('payload');
    },
    verifyEvidence: async (scope, descriptor) => {
      expect(scope.workspaceId).toBe(fixture.workspaceId);
      expect(descriptor.evidence).toEqual(registered);
      expect(Object.isFrozen(descriptor.evidence)).toBe(true);
    },
  };
};
const accept = async (evidence?: Input, grants?: Callbacks) => {
  const observation = evidence ?? (await input());
  return fixture.service.applyOmniConnectorAcceptance(
    principal(),
    observation,
    grants ?? callbacks(observation),
  );
};
const leaseCallbacks = () => ({
  authorize: async (scope: { workspaceId: string }) => {
    expect(scope.workspaceId).toBe(fixture.workspaceId);
  },
  qualifyTransport: async (scope: { workspaceId: string }) => {
    expect(scope.workspaceId).toBe(fixture.workspaceId);
  },
});
const claim = (id = commandId) =>
  fixture.service.claimOmniHumanCommandLease(
    principal(),
    { commandId: id, leaseMilliseconds: 30000 },
    leaseCallbacks(),
  );
const noDelivery = async () => {
  expect(await fixture.read('message')).toEqual([]);
  expect(await fixture.read('messageParticipant')).toEqual([]);
  expect(await core('omniMessageLink')).toEqual([]);
  expect(await core('omniAutomationAdmission')).toEqual([]);
  expect(fixture.eventEmitter).not.toHaveBeenCalled();
};
const proofContext = (command: Record<string, unknown>) => ({
  workspaceId: fixture.workspaceId,
  bindingId: context.bindingId,
  conversationId: context.conversationId,
  commandId: String(command.id),
  providerChatId: 'history-chat',
  payloadHash: String(command.payloadHash),
  generation: String(command.generation),
  connectorJobId:
    command.connectorJobId === null ? null : String(command.connectorJobId),
  journalSequence:
    command.journalSequence === null ? null : String(command.journalSequence),
  state: String(command.state),
  payload: command.payload,
});
const sqlProof = async (id = commandId): Promise<boolean> => {
  const [row] = await fixture.owner.query(
    `SELECT ${omniConnectorAcceptanceSqlPredicate()} AS valid FROM core."omniOutgoingCommand" command WHERE command."workspaceId"=$1 AND command."conversationId"=$2 AND command.id=$3`,
    [
      fixture.workspaceId,
      context.conversationId,
      id,
      context.bindingId,
      'history-chat',
    ],
  );
  expect(typeof row.valid).toBe('boolean');
  return row.valid;
};
const seedVerifiedHistory = async () => {
  await accept();
  // Bounded historical fixture cloned from an actual reducer result; not 151 network deliveries.
  await fixture.owner.query(
    `WITH source AS (SELECT to_jsonb(command) AS data FROM core."omniOutgoingCommand" command WHERE id=$1), copies AS (SELECT uuid_generate_v4() AS id, sequence FROM generate_series(2,151) AS generated(sequence)), populated AS (
    SELECT jsonb_populate_record(NULL::core."omniOutgoingCommand", source.data || jsonb_build_object(
      'id',copies.id,'idempotencyKey',copies.id::text,'outboundSequence',copies.sequence::text,
      'connectorJobId','fixture-job-'||copies.id::text,'journalSequence',copies.sequence::text,
      'connectorAcceptedEvidence',(source.data->'connectorAcceptedEvidence') || jsonb_build_object('commandId',copies.id,'connectorJobId','fixture-job-'||copies.id::text,'journalSequence',copies.sequence::text)
    )) AS value FROM source CROSS JOIN copies) INSERT INTO core."omniOutgoingCommand" SELECT (value).* FROM populated`,
    [commandId],
  );
  await fixture.owner.query(
    'UPDATE core."omniConversation" SET "nextOutboundSequence"=152,"conversationSequence"=151,"replyRevision"=152 WHERE id=$1',
    [context.conversationId],
  );
  return (await context.admit()).commandId;
};
const errorMessages = (error: unknown): string[] =>
  error instanceof Error
    ? [
        error.message,
        ...errorMessages(error.cause),
        ...(error instanceof AggregateError
          ? error.errors.flatMap(errorMessages)
          : []),
      ]
    : [];

beforeAll(() => fixture.initialize());
beforeEach(async () => {
  context = await fixture.reset();
  commandId = (await context.admit()).commandId;
  expect(await claim()).toMatchObject({
    claimed: true,
    proof: { purpose: 'first_attempt' },
  });
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('verified connector acceptance through the strict owner', () => {
  it('applies acceptance to an actual claimed intent and lets the next FIFO intent claim', async () => {
    const before = await graph();
    const previous = await readCommand();
    const priorAudit = await audit();
    const result = await accept();
    expect(result).toEqual({
      commandId,
      state: 'accepted',
      statusRevision: '3',
      applied: true,
    });
    const command = await readCommand();
    expect(command).toMatchObject({
      state: 'accepted',
      statusRevision: '3',
      connectorJobId: `fixture-job-${commandId}`,
      journalSequence: '1',
      leaseToken: null,
      leaseUntil: null,
    });
    expect(command.payload).toEqual(previous.payload);
    expect(command.payloadHash).toBe(previous.payloadHash);
    expect(await graph()).toEqual(before);
    expect(
      (await audit()).filter(
        (row) => !priorAudit.some((entry) => entry.id === row.id),
      ),
    ).toEqual([
      expect.objectContaining({
        resourceKind: 'omniOutgoingCommand',
        resourceId: commandId,
        outcome: 'success',
        action: 'update',
      }),
    ]);
    const nextId = (await context.admit()).commandId;
    expect(await claim(nextId)).toMatchObject({
      claimed: true,
      proof: { commandId: nextId, purpose: 'first_attempt' },
    });
    await noDelivery();
  });

  it('rechecks current grants and verifier on duplicate without bumping revision or audit', async () => {
    const evidence = await input();
    await accept(evidence);
    const before = await readCommand();
    const priorAudit = await audit();
    const grants = callbacks(evidence);
    const authorize = jest.fn(grants.authorize);
    const verifyEvidence = jest.fn(grants.verifyEvidence);
    expect(await accept(evidence, { authorize, verifyEvidence })).toEqual({
      commandId,
      state: 'accepted',
      statusRevision: '3',
      applied: false,
    });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(verifyEvidence).toHaveBeenCalledTimes(1);
    expect(await readCommand()).toEqual(before);
    expect(await audit()).toEqual(priorAudit);
  });

  it('applies one fact under concurrent duplicate acceptance', async () => {
    const evidence = await input();
    const priorAudit = await audit();
    const results = await Promise.all([accept(evidence), accept(evidence)]);
    expect(results.map((result) => result.applied).sort()).toEqual([
      false,
      true,
    ]);
    expect(await readCommand()).toMatchObject({
      state: 'accepted',
      statusRevision: '3',
    });
    expect(await audit()).toHaveLength(priorAudit.length + 1);
  });

  it('preserves a newer reconciliation lease on exact duplicate acceptance', async () => {
    const evidence = await input();
    await accept(evidence);
    expect(await claim()).toMatchObject({
      claimed: true,
      proof: { purpose: 'reconcile_only' },
    });
    const before = await readCommand();
    const priorAudit = await audit();
    expect(await accept(evidence)).toMatchObject({
      applied: false,
      statusRevision: '4',
    });
    expect(await readCommand()).toEqual(before);
    expect(await audit()).toEqual(priorAudit);
  });

  it('supports a verified zero-based journal sequence and opaque Unicode job identifier in both predicates', async () => {
    await accept(
      await input({
        journalSequence: '0',
        connectorJobId: "fixture 👋 job's identifier",
      }),
    );
    const row = await readCommand();
    expect(
      isOmniConnectorAcceptanceProof(
        row.connectorAcceptedEvidence,
        proofContext(row),
      ),
    ).toBe(true);
    expect(await sqlProof()).toBe(true);
    const nextId = (await context.admit()).commandId;
    expect(await claim(nextId)).toMatchObject({
      claimed: true,
      proof: { commandId: nextId },
    });
  });

  it('recomputes the immutable payload hash before persisting a first verified fact', async () => {
    await fixture.owner.query(
      'UPDATE core."omniOutgoingCommand" SET payload=jsonb_set(payload,\'{text}\',\'"tampered persisted body"\'::jsonb) WHERE id=$1',
      [commandId],
    );
    const before = await readCommand();
    await expect(accept()).rejects.toThrow();
    expect(await readCommand()).toEqual(before);
    expect((await readCommand()).connectorAcceptedEvidence).toBeNull();
  });

  it.each(['workspace', 'binding', 'command'] as const)(
    'does not change or audit another %s',
    async (kind) => {
      const actor = principal();
      const evidence = await input();
      if (kind === 'workspace') actor.workspaceId = randomUUID();
      if (kind === 'binding') actor.bindingId = randomUUID();
      const requested =
        kind === 'command'
          ? { ...evidence, commandId: randomUUID() }
          : evidence;
      const before = await readCommand();
      const priorAudit = await audit();
      await expect(
        fixture.service.applyOmniConnectorAcceptance(
          actor,
          requested,
          callbacks(requested),
        ),
      ).rejects.toThrow();
      expect(await readCommand()).toEqual(before);
      expect(await audit()).toEqual(priorAudit);
    },
  );

  it.each(['generation', 'binding', 'author', 'closed'] as const)(
    'retains a historical ACK after current %s changes without authorizing a send',
    async (kind) => {
      const evidence = await input();
      if (kind === 'generation')
        await fixture.owner.query(
          'UPDATE core."omniAccountBinding" SET "routeGeneration"=2 WHERE id=$1',
          [context.bindingId],
        );
      if (kind === 'binding')
        await fixture.owner.query(
          'UPDATE core."omniAccountBinding" SET status=\'inactive\' WHERE id=$1',
          [context.bindingId],
        );
      if (kind === 'author')
        await fixture.owner.query(
          'UPDATE core."userWorkspace" SET "deletedAt"=clock_timestamp() WHERE "userId"=$1',
          [context.human.userId],
        );
      if (kind === 'closed')
        await fixture.owner.query(
          'UPDATE core."omniConversation" SET status=\'closed\' WHERE id=$1',
          [context.conversationId],
        );
      const before = await graph();
      expect(await accept(evidence)).toMatchObject({
        applied: true,
        state: 'accepted',
      });
      expect((await readCommand()).generation).toBe('1');
      expect(await graph()).toEqual(before);
      await noDelivery();
    },
  );

  it.each([
    'payloadHash',
    'connectorJobId',
    'journalSequence',
    'providerChatId',
    'generation',
  ] as const)(
    'rejects conflicting retained %s without overwriting the first fact',
    async (field) => {
      const evidence = await input();
      await accept(evidence);
      const before = await readCommand();
      const conflict = {
        ...evidence,
        [field]:
          field === 'payloadHash'
            ? '0'.repeat(64)
            : field === 'journalSequence' || field === 'generation'
              ? '2'
              : 'different-value',
      };
      await expect(accept(conflict)).rejects.toThrow();
      expect(await readCommand()).toEqual(before);
      await noDelivery();
    },
  );

  it.each(['pending', 'failed', 'cancelled'] as const)(
    'rejects acceptance on %s without resurrecting a command',
    async (state) => {
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET state=$1 WHERE id=$2',
        [state, commandId],
      );
      const before = await readCommand();
      await expect(accept()).rejects.toThrow();
      expect(await readCommand()).toEqual(before);
      await noDelivery();
    },
  );

  it.each(['outcome_unknown', 'sent'] as const)(
    'records the accepted fact while retaining monotonic %s',
    async (state) => {
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET state=$1 WHERE id=$2',
        [state, commandId],
      );
      const before = await graph();
      expect(await accept()).toEqual({
        commandId,
        state,
        statusRevision: '3',
        applied: true,
      });
      expect(await readCommand()).toMatchObject({
        state,
        connectorJobId: `fixture-job-${commandId}`,
        journalSequence: '1',
      });
      expect(await graph()).toEqual(before);
      await noDelivery();
    },
  );

  it.each(['authorize', 'verifyEvidence'] as const)(
    'requires current %s even on replay',
    async (callback) => {
      const evidence = await input();
      await accept(evidence);
      const before = await readCommand();
      const priorAudit = await audit();
      const grants = {
        ...callbacks(evidence),
        [callback]: async () => {
          throw new Error(`fixture ${callback} rejected`);
        },
      };
      await expect(accept(evidence, grants)).rejects.toThrow(
        `fixture ${callback} rejected`,
      );
      expect(await readCommand()).toEqual(before);
      expect(
        (await audit()).filter(
          (row) => !priorAudit.some((entry) => entry.id === row.id),
        ),
      ).toEqual([
        expect.objectContaining({
          outcome: callback === 'authorize' ? 'denied' : 'failed',
          reasonCode:
            callback === 'authorize'
              ? 'command.acceptance.denied'
              : 'command.acceptance.failed',
          resourceId: commandId,
        }),
      ]);
    },
  );

  it.each(['omniOutgoingCommand', 'crmAuditEntry'])(
    'rolls back the fact and success audit on %s failure',
    async (table) => {
      const schema = table === 'crmAuditEntry' ? 'crm_audit' : 'core';
      const operation = table === 'crmAuditEntry' ? 'INSERT' : 'UPDATE';
      const before = await readCommand();
      const priorAudit = await audit();
      await fixture.owner.query(
        `CREATE FUNCTION core.log043_fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${table === 'crmAuditEntry' ? "IF NEW.outcome='success' THEN RAISE EXCEPTION 'fixture acceptance write failure'; END IF;" : "RAISE EXCEPTION 'fixture acceptance write failure';"} RETURN NEW; END $$`,
      );
      await fixture.owner.query(
        `CREATE TRIGGER log043_fail_write BEFORE ${operation} ON "${schema}"."${table}" FOR EACH ROW EXECUTE FUNCTION core.log043_fail_write()`,
      );
      try {
        const outcome: unknown = await accept().catch(
          (error: unknown) => error,
        );
        expect(errorMessages(outcome)).toContain(
          'fixture acceptance write failure',
        );
        expect(await readCommand()).toEqual(before);
        expect(
          (await audit()).filter(
            (row) => !priorAudit.some((entry) => entry.id === row.id),
          ),
        ).toEqual([
          expect.objectContaining({
            outcome: 'failed',
            reasonCode: 'command.acceptance.failed',
          }),
        ]);
      } finally {
        await fixture.owner.query(
          `DROP TRIGGER log043_fail_write ON "${schema}"."${table}"`,
        );
        await fixture.owner.query('DROP FUNCTION core.log043_fail_write()');
      }
    },
  );

  it('replays after a lost COMMIT ACK without another revision or a false failed audit', async () => {
    const evidence = await input();
    const before = await graph();
    const priorAudit = await audit();
    const client = await fixture.pool.connect();
    const query = client.query.bind(client);
    const statements: string[] = [];
    jest.spyOn(client, 'query').mockImplementation((async (
      sql: string | { text: string; values?: unknown[] },
      values?: unknown[],
    ) => {
      const text = typeof sql === 'string' ? sql : sql.text;
      statements.push(text);
      const result = await query(sql, values);
      if (text === 'COMMIT')
        throw new Error('fixture acceptance lost COMMIT ACK');
      return result;
    }) as typeof client.query);
    jest
      .spyOn(fixture.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await expect(accept(evidence)).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
    expect(statements).not.toContain('ROLLBACK');
    expect(await readCommand()).toMatchObject({
      state: 'accepted',
      statusRevision: '3',
    });
    expect(await graph()).toEqual(before);
    expect(await audit()).toHaveLength(priorAudit.length + 1);
    expect((await audit()).every((row) => row.outcome === 'success')).toBe(
      true,
    );
    const committed = await readCommand();
    const committedAudit = await audit();
    expect(await accept(evidence)).toMatchObject({
      applied: false,
      state: 'accepted',
      statusRevision: '3',
    });
    expect(await readCommand()).toEqual(committed);
    expect(await audit()).toEqual(committedAudit);
    await noDelivery();
  });

  it('claims after 151 canonical verified predecessors without the legacy scan cap', async () => {
    const nextId = await seedVerifiedHistory();
    const rows = await core('omniOutgoingCommand');
    expect(rows).toHaveLength(152);
    for (const row of rows.filter((row) => row.id !== nextId))
      expect(
        isOmniConnectorAcceptanceProof(
          row.connectorAcceptedEvidence,
          proofContext(row),
        ),
      ).toBe(true);
    expect(await claim(nextId)).toMatchObject({
      claimed: true,
      proof: { commandId: nextId, purpose: 'first_attempt' },
    });
    expect((await readCommand(nextId)).outboundSequence).toBe('152');
    await noDelivery();
  });

  it('does not skip a single unverified predecessor inside a large verified history', async () => {
    const nextId = await seedVerifiedHistory();
    await fixture.owner.query(
      'UPDATE core."omniOutgoingCommand" SET "connectorAcceptedEvidence"="connectorAcceptedEvidence"||\'{"unexpected":true}\'::jsonb WHERE "outboundSequence"=75 AND "conversationId"=$1',
      [context.conversationId],
    );
    const before = await readCommand(nextId);
    await expect(claim(nextId)).rejects.toThrow();
    expect(await readCommand(nextId)).toEqual(before);
    await noDelivery();
  });

  it.each([
    'null',
    'array',
    'scalar',
    'extra',
    'missing-version',
    'wrong-version',
    'wrong-kind',
    'workspaceId',
    'bindingId',
    'conversationId',
    'commandId',
    'providerChatId',
    'payloadHash',
    'generation',
    'connectorJobId',
    'journalSequence',
    'number-generation',
    'overflow-sequence',
    'qualification-extra',
    'qualification-null',
    'empty-job',
    'control-chat',
    'uppercase-uuid',
  ] as const)(
    'keeps SQL and JS proof rejection aligned for %s and never skips it in FIFO',
    async (kind) => {
      await accept();
      const previous = await readCommand();
      expect(
        isOmniConnectorAcceptanceProof(
          previous.connectorAcceptedEvidence,
          proofContext(previous),
        ),
      ).toBe(true);
      expect(await sqlProof()).toBe(true);
      const nextId = (await context.admit()).commandId;
      const original = z
        .record(z.string(), z.unknown())
        .parse(previous.connectorAcceptedEvidence);
      let altered: unknown;
      if (kind === 'null') altered = null;
      else if (kind === 'array') altered = [original];
      else if (kind === 'scalar') altered = 'lookalike';
      else {
        const modified = { ...original };
        if (kind === 'extra') modified.extra = true;
        else if (kind === 'missing-version') delete modified.schemaVersion;
        else if (kind === 'wrong-version') modified.schemaVersion = 2;
        else if (kind === 'wrong-kind') modified.evidenceKind = 'unverified';
        else if (kind === 'number-generation') modified.generation = 1;
        else if (kind === 'empty-job') modified.connectorJobId = '';
        else if (kind === 'control-chat')
          modified.providerChatId = 'history-chat\n';
        else if (kind === 'uppercase-uuid')
          modified.commandId = commandId.toUpperCase();
        else if (kind === 'overflow-sequence')
          modified.journalSequence = '9223372036854775808';
        else if (kind === 'qualification-extra')
          modified.qualification = {
            ...z.record(z.string(), z.unknown()).parse(original.qualification),
            extra: true,
          };
        else if (kind === 'qualification-null') modified.qualification = null;
        else
          modified[kind] =
            kind.endsWith('Id') &&
            kind !== 'providerChatId' &&
            kind !== 'connectorJobId'
              ? randomUUID()
              : kind === 'payloadHash'
                ? '0'.repeat(64)
                : kind === 'generation' || kind === 'journalSequence'
                  ? '2'
                  : 'different';
        altered = modified;
      }
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET "connectorAcceptedEvidence"=$1::jsonb WHERE id=$2',
        [altered === null ? null : JSON.stringify(altered), commandId],
      );
      const row = await readCommand();
      expect(
        isOmniConnectorAcceptanceProof(
          row.connectorAcceptedEvidence,
          proofContext(row),
        ),
      ).toBe(false);
      expect(await sqlProof()).toBe(false);
      const before = await readCommand(nextId);
      const outcome = await claim(nextId).catch((error: unknown) => error);
      expect(
        outcome instanceof Error ||
          (typeof outcome === 'object' &&
            outcome !== null &&
            'claimed' in outcome &&
            outcome.claimed === false),
      ).toBe(true);
      expect(await readCommand(nextId)).toEqual(before);
    },
  );
});
