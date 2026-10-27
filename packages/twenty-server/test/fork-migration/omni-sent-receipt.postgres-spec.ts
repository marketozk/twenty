import { randomUUID } from 'node:crypto';

import { auditPayloadHash } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { acceptOmniIncomingEvent } from 'src/modules/omnichannel/services/accept-omni-incoming-event';
import {
  claimOmniIncomingReceipts,
  renewOmniIncomingReceiptLease,
  deferOmniIncomingReceipt,
} from 'src/modules/omnichannel/services/omni-incoming-receipt-lease';
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
type Input = Parameters<typeof fixture.service.acceptOmniSentReceipt>[1];
type Callbacks = Parameters<typeof fixture.service.acceptOmniSentReceipt>[2];
const principal = () => ({
  workspaceId: fixture.workspaceId,
  bindingId: context.bindingId,
  actor: { kind: 'system' as const, id: context.principal.actor.id },
});
const core = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const audit = (): Promise<Record<string, unknown>[]> =>
  fixture.owner.query('SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id');
const observation = async (
  changes: Partial<Input['envelope']> = {},
  captureChanges: Partial<Input['capture']> = {},
): Promise<Input> => {
  const [command] = await core('omniOutgoingCommand');
  const envelope: Input['envelope'] = {
    schemaVersion: 1,
    kind: 'command.sent',
    eventId: randomUUID(),
    accountBindingId: context.bindingId,
    routeGeneration: String(command.generation),
    commandId,
    providerChatId: 'history-chat',
    payloadHash: String(command.payloadHash),
    connectorJobId: `fixture-job-${commandId}`,
    journalSequence: '1',
    providerMessageId: 'fixture-sent-message',
    direction: 'outgoing',
    sourceVariant: 'complete',
    nativeMessageKeyVersion: 1,
    occurredAt: '2026-10-27T12:00:00.000Z',
    sourcePosition: { type: 'journal', value: '1' },
    ...changes,
  };
  return {
    envelope,
    capture: {
      schemaVersion: 1,
      origin: 'connector_outcome',
      envelopeHash: auditPayloadHash(envelope),
      qualification: {
        adapterId: 'fixture-outcome-adapter',
        adapterVersion: '1',
      },
      nativeMessageKey: `fixture:v1:${envelope.providerMessageId}`,
      nativeMessageKeyVersion: 1,
      sourceVariant: 'complete',
      sourcePosition: envelope.sourcePosition,
      ...captureChanges,
    },
  };
};
const recordAcceptance = async () => {
  const item = await observation();
  const envelope = item.envelope;
  await fixture.service.applyOmniConnectorAcceptance(
    principal(),
    {
      commandId,
      providerChatId: envelope.providerChatId,
      payloadHash: envelope.payloadHash,
      generation: envelope.routeGeneration,
      connectorJobId: envelope.connectorJobId,
      journalSequence: envelope.journalSequence,
      qualification: item.capture.qualification,
    },
    { authorize: async () => {}, verifyEvidence: async () => {} },
  );
};
const noApply = async () => {
  expect(await fixture.read('message')).toEqual([]);
  expect(await fixture.read('messageParticipant')).toEqual([]);
  expect(await core('omniMessageLink')).toEqual([]);
  expect(await core('omniMessageRevision')).toEqual([]);
  expect(await core('omniAutomationAdmission')).toEqual([]);
  expect(fixture.eventEmitter).not.toHaveBeenCalled();
};
const graph = async () => ({
  commands: await core('omniOutgoingCommand'),
  conversations: await core('omniConversation'),
  events: await core('omniDomainEvent'),
  roots: await core('omniRootExecution'),
  plans: await core('omniEventDispatchPlan'),
});
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
const callbacks = (registered: Input): Callbacks => ({
  authorize: async (scope, descriptor) => {
    expect(scope.workspaceId).toBe(fixture.workspaceId);
    expect(descriptor).toMatchObject({
      principal: principal(),
      bindingId: context.bindingId,
      conversationId: context.conversationId,
    });
    expect(Object.isFrozen(descriptor)).toBe(true);
  },
  // Fixture-only server observation; no real connector is qualified by these tests.
  verifyEvidence: async (scope, descriptor) => {
    expect(scope.workspaceId).toBe(fixture.workspaceId);
    expect(descriptor.envelope).toEqual(registered.envelope);
    expect(descriptor.capture).toEqual(registered.capture);
    expect(Object.isFrozen(descriptor.envelope)).toBe(true);
    expect(Object.isFrozen(descriptor.capture)).toBe(true);
  },
});
const accept = (observation: Input, grants = callbacks(observation)) =>
  fixture.service.acceptOmniSentReceipt(principal(), observation, grants);
const claim = (
  receiptId: string,
  observation: Input,
  grants = callbacks(observation),
  leaseMilliseconds = 30000,
) =>
  fixture.service.claimOmniSentReceipt(
    principal(),
    { receiptId, leaseOwner: randomUUID(), leaseMilliseconds },
    grants,
  );

beforeAll(() => fixture.initialize());
beforeEach(async () => {
  context = await fixture.reset();
  commandId = (await context.admit()).commandId;
  expect(
    await fixture.service.claimOmniHumanCommandLease(
      principal(),
      { commandId, leaseMilliseconds: 30000 },
      { authorize: async () => {}, qualifyTransport: async () => {} },
    ),
  ).toMatchObject({ claimed: true });
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('durable command.sent receipt intake and dedicated claim', () => {
  it('stores a closed envelope and trusted capture without applying the sent outcome', async () => {
    const item = await observation();
    const before = await graph();
    const priorAudit = await audit();
    const result = await accept(item);
    expect(result).toMatchObject({ state: 'accepted', created: true });
    expect(await core('omniIncomingReceipt')).toEqual([
      expect.objectContaining({
        id: result.receiptId,
        kind: 'command.sent',
        state: 'accepted',
        canonicalPayloadHash: auditPayloadHash(item.envelope),
        validatedEnvelope: item.envelope,
        trustedCaptureContext: item.capture,
        trustedCaptureContextHash: auditPayloadHash(item.capture),
        attempts: 0,
        leaseToken: '0',
        leaseOwner: null,
        leaseUntil: null,
        resultId: null,
      }),
    ]);
    expect(await graph()).toEqual(before);
    expect(
      (await audit()).filter(
        (row) => !priorAudit.some((entry) => entry.id === row.id),
      ),
    ).toEqual([
      expect.objectContaining({
        resourceKind: 'omniIncomingReceipt',
        resourceId: result.receiptId,
        outcome: 'success',
        action: 'create',
      }),
    ]);
    await noApply();
  });

  it('replays the same event after fresh authorization and verification without another audit', async () => {
    const item = await observation();
    const accepted = await accept(item);
    const before = await core('omniIncomingReceipt');
    const priorAudit = await audit();
    const grants = callbacks(item);
    const authorize = jest.fn(grants.authorize);
    const verifyEvidence = jest.fn(grants.verifyEvidence);
    expect(await accept(item, { authorize, verifyEvidence })).toEqual({
      ...accepted,
      created: false,
    });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(verifyEvidence).toHaveBeenCalledTimes(1);
    expect(await core('omniIncomingReceipt')).toEqual(before);
    expect(await audit()).toEqual(priorAudit);
  });

  it('deduplicates concurrent capture of the same verified event', async () => {
    const item = await observation();
    const priorAudit = await audit();
    const results = await Promise.all([accept(item), accept(item)]);
    expect(new Set(results.map((row) => row.receiptId)).size).toBe(1);
    expect(results.map((row) => row.created).sort()).toEqual([false, true]);
    expect(await core('omniIncomingReceipt')).toHaveLength(1);
    expect(await audit()).toHaveLength(priorAudit.length + 1);
  });

  it.each([
    'providerMessageId',
    'occurredAt',
    'capture-key',
    'qualification',
  ] as const)('rejects a conflicting %s for the same event', async (kind) => {
    const item = await observation();
    await accept(item);
    const before = await core('omniIncomingReceipt');
    const changed = await observation(
      {
        ...item.envelope,
        ...(kind === 'providerMessageId'
          ? { providerMessageId: 'different-message' }
          : kind === 'occurredAt'
            ? { occurredAt: '2026-10-27T12:01:00.000Z' }
            : {}),
      },
      kind === 'capture-key'
        ? { nativeMessageKey: 'different-key' }
        : kind === 'qualification'
          ? {
              qualification: {
                adapterId: 'different-adapter',
                adapterVersion: '1',
              },
            }
          : {},
    );
    await expect(accept(changed)).rejects.toThrow();
    expect(await core('omniIncomingReceipt')).toEqual(before);
    await noApply();
  });

  it.each(['envelope-hash', 'position', 'extra-body'] as const)(
    'rejects malformed capture %s before any persistence',
    async (kind) => {
      const item = await observation();
      const invalid =
        kind === 'envelope-hash'
          ? {
              ...item,
              capture: { ...item.capture, envelopeHash: '0'.repeat(64) },
            }
          : kind === 'position'
            ? {
                ...item,
                capture: {
                  ...item.capture,
                  sourcePosition: { type: 'journal', value: '2' },
                },
              }
            : {
                ...item,
                envelope: {
                  ...item.envelope,
                  payload: { text: 'arbitrary replacement body' },
                },
              };
      const priorAudit = await audit();
      await expect(accept(invalid)).rejects.toThrow();
      expect(await core('omniIncomingReceipt')).toEqual([]);
      expect(await audit()).toEqual(priorAudit);
    },
  );

  it.each([
    'payloadHash',
    'connectorJobId',
    'journalSequence',
    'providerChatId',
    'routeGeneration',
  ] as const)(
    'rejects %s conflicting with the command or retained acceptance',
    async (field) => {
      await recordAcceptance();
      const before = await graph();
      const item = await observation({
        [field]:
          field === 'payloadHash'
            ? '0'.repeat(64)
            : field === 'journalSequence' || field === 'routeGeneration'
              ? '2'
              : 'different',
      });
      await expect(accept(item)).rejects.toThrow();
      expect(await core('omniIncomingReceipt')).toEqual([]);
      expect(await graph()).toEqual(before);
    },
  );

  it.each(['workspace', 'binding', 'command'] as const)(
    'does not accept or audit another %s',
    async (kind) => {
      const actor = principal();
      if (kind === 'workspace') actor.workspaceId = randomUUID();
      if (kind === 'binding') actor.bindingId = randomUUID();
      const item = await observation(
        kind === 'command' ? { commandId: randomUUID() } : {},
      );
      const priorAudit = await audit();
      await expect(
        fixture.service.acceptOmniSentReceipt(actor, item, callbacks(item)),
      ).rejects.toThrow();
      expect(await core('omniIncomingReceipt')).toEqual([]);
      expect(await audit()).toEqual(priorAudit);
    },
  );

  it.each(['inactive', 'old-generation', 'revoked-author'] as const)(
    'accepts and claims a historical sent outcome after %s with current worker grants',
    async (kind) => {
      const item = await observation();
      if (kind === 'inactive')
        await fixture.owner.query(
          'UPDATE core."omniAccountBinding" SET status=\'inactive\' WHERE id=$1',
          [context.bindingId],
        );
      if (kind === 'old-generation')
        await fixture.owner.query(
          'UPDATE core."omniAccountBinding" SET "routeGeneration"=2 WHERE id=$1',
          [context.bindingId],
        );
      if (kind === 'revoked-author')
        await fixture.owner.query(
          'UPDATE core."userWorkspace" SET "deletedAt"=clock_timestamp() WHERE "userId"=$1',
          [context.human.userId],
        );
      const before = await graph();
      const result = await accept(item);
      expect(await claim(result.receiptId, item)).toMatchObject({
        claimed: true,
        proof: { receiptId: result.receiptId, routeGeneration: '1' },
      });
      expect(await graph()).toEqual(before);
      await noApply();
    },
  );

  it.each(['pending', 'failed', 'cancelled'] as const)(
    'does not hide a conflicting %s command as an accepted outcome',
    async (state) => {
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET state=$1 WHERE id=$2',
        [state, commandId],
      );
      const before = await graph();
      await expect(accept(await observation())).rejects.toThrow();
      expect(await core('omniIncomingReceipt')).toEqual([]);
      expect(await graph()).toEqual(before);
    },
  );

  it.each(['authorize', 'verifyEvidence'] as const)(
    'requires current %s on both replay and claim',
    async (callback) => {
      const item = await observation();
      const accepted = await accept(item);
      const before = await core('omniIncomingReceipt');
      const grants = {
        ...callbacks(item),
        [callback]: async () => {
          throw new Error(`fixture ${callback} revoked`);
        },
      };
      await expect(accept(item, grants)).rejects.toThrow(
        `fixture ${callback} revoked`,
      );
      await expect(claim(accepted.receiptId, item, grants)).rejects.toThrow(
        `fixture ${callback} revoked`,
      );
      expect(await core('omniIncomingReceipt')).toEqual(before);
    },
  );

  it('leases the receipt once, then reclaims expiry with a higher token without touching the command', async () => {
    const item = await observation();
    const accepted = await accept(item);
    const before = await graph();
    const results = await Promise.all([
      claim(accepted.receiptId, item),
      claim(accepted.receiptId, item),
    ]);
    expect(results.filter((row) => row.claimed)).toHaveLength(1);
    expect(results.filter((row) => !row.claimed)).toEqual([
      { claimed: false, reason: 'lease_live' },
    ]);
    const first = results.find((row) => row.claimed);
    if (!first?.claimed) throw new Error('Fixture claim missing');
    expect(first.proof).toMatchObject({
      receiptId: accepted.receiptId,
      leaseToken: '1',
      routeGeneration: '1',
    });
    expect(first.proof.leaseUntil).toMatch(/\.\d{6}Z$/);
    expect(first.envelope).toEqual(item.envelope);
    expect(first.capture).toEqual(item.capture);
    await fixture.owner.query(
      'UPDATE core."omniIncomingReceipt" SET "leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE id=$1',
      [accepted.receiptId],
    );
    const second = await claim(accepted.receiptId, item);
    expect(second).toMatchObject({
      claimed: true,
      proof: { leaseToken: '2', receiptId: accepted.receiptId },
    });
    expect((await core('omniIncomingReceipt'))[0]).toMatchObject({
      attempts: 2,
      state: 'processing',
      resultId: null,
    });
    expect(await graph()).toEqual(before);
    await noApply();
  });

  it.each(['not_due', 'applied', 'quarantined'] as const)(
    'returns a no-op for %s without success or failure audit',
    async (kind) => {
      const item = await observation();
      const accepted = await accept(item);
      await fixture.owner.query(
        `UPDATE core."omniIncomingReceipt" SET ${kind === 'not_due' ? '"nextAttemptAt"=clock_timestamp()+interval \'1 hour\'' : 'state=$2'} WHERE id=$1`,
        kind === 'not_due' ? [accepted.receiptId] : [accepted.receiptId, kind],
      );
      const before = await core('omniIncomingReceipt');
      const priorAudit = await audit();
      expect(await claim(accepted.receiptId, item)).toEqual({
        claimed: false,
        reason: kind === 'quarantined' ? 'not_claimable' : kind,
      });
      expect(await core('omniIncomingReceipt')).toEqual(before);
      expect(await audit()).toEqual(priorAudit);
    },
  );

  it.each(['canonicalPayloadHash', 'trustedCaptureContextHash'] as const)(
    'fails closed on corrupted retained %s during claim',
    async (field) => {
      const item = await observation();
      const accepted = await accept(item);
      await fixture.owner.query(
        `UPDATE core."omniIncomingReceipt" SET "${field}"=$1 WHERE id=$2`,
        ['0'.repeat(64), accepted.receiptId],
      );
      const before = await core('omniIncomingReceipt');
      await expect(claim(accepted.receiptId, item)).rejects.toThrow();
      expect(await core('omniIncomingReceipt')).toEqual(before);
    },
  );

  it.each([
    'accept-receipt',
    'accept-audit',
    'claim-receipt',
    'claim-audit',
  ] as const)(
    'rolls back %s atomically and records only the confirmed failure',
    async (stage) => {
      const item = await observation();
      const accepted = stage.startsWith('claim') ? await accept(item) : null;
      const before = await core('omniIncomingReceipt');
      const beforeGraph = await graph();
      const priorAudit = await audit();
      const table = stage.endsWith('audit')
        ? 'crm_audit."crmAuditEntry"'
        : 'core."omniIncomingReceipt"';
      const operation =
        stage.startsWith('claim') && stage.endsWith('receipt')
          ? 'UPDATE'
          : 'INSERT';
      await fixture.owner.query(
        `CREATE FUNCTION core.log044_fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${stage.endsWith('audit') ? "IF NEW.outcome='success' THEN RAISE EXCEPTION 'fixture sent receipt write failure'; END IF;" : "RAISE EXCEPTION 'fixture sent receipt write failure';"} RETURN NEW; END $$`,
      );
      await fixture.owner.query(
        `CREATE TRIGGER log044_fail_write BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION core.log044_fail_write()`,
      );
      try {
        const outcome: unknown = await (
          accepted ? claim(accepted.receiptId, item) : accept(item)
        ).catch((error: unknown) => error);
        expect(errorMessages(outcome)).toContain(
          'fixture sent receipt write failure',
        );
        expect(await core('omniIncomingReceipt')).toEqual(before);
        expect(await graph()).toEqual(beforeGraph);
        expect(
          (await audit()).filter(
            (row) => !priorAudit.some((entry) => entry.id === row.id),
          ),
        ).toEqual([
          expect.objectContaining({
            outcome: 'failed',
            reasonCode: accepted
              ? 'sent_receipt.claim.failed'
              : 'sent_receipt.accept.failed',
            resourceId: accepted?.receiptId ?? commandId,
          }),
        ]);
      } finally {
        await fixture.owner.query(`DROP TRIGGER log044_fail_write ON ${table}`);
        await fixture.owner.query('DROP FUNCTION core.log044_fail_write()');
      }
    },
  );

  it('does not return a lease already expired while its audit was written', async () => {
    const item = await observation();
    const accepted = await accept(item);
    const before = await core('omniIncomingReceipt');
    const priorAudit = await audit();
    await fixture.owner.query(
      `CREATE FUNCTION core.log044_slow_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.outcome='success' THEN PERFORM pg_sleep(1.2); END IF; RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      'CREATE TRIGGER log044_slow_audit BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION core.log044_slow_audit()',
    );
    try {
      await expect(
        claim(accepted.receiptId, item, callbacks(item), 1000),
      ).rejects.toThrow();
      expect(await core('omniIncomingReceipt')).toEqual(before);
      expect(
        (await audit()).filter(
          (row) => !priorAudit.some((entry) => entry.id === row.id),
        ),
      ).toEqual([
        expect.objectContaining({
          outcome: 'failed',
          reasonCode: 'sent_receipt.claim.failed',
        }),
      ]);
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER log044_slow_audit ON crm_audit."crmAuditEntry"',
      );
      await fixture.owner.query('DROP FUNCTION core.log044_slow_audit()');
    }
  });

  it('rejects an altered claim token rather than returning a false ownership proof', async () => {
    const item = await observation();
    const accepted = await accept(item);
    const before = await core('omniIncomingReceipt');
    await fixture.owner.query(
      'CREATE FUNCTION core.log044_tamper_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW."leaseToken" := NEW."leaseToken"+1; RETURN NEW; END $$',
    );
    await fixture.owner.query(
      'CREATE TRIGGER log044_tamper_claim BEFORE UPDATE ON core."omniIncomingReceipt" FOR EACH ROW EXECUTE FUNCTION core.log044_tamper_claim()',
    );
    try {
      await expect(claim(accepted.receiptId, item)).rejects.toThrow();
      expect(await core('omniIncomingReceipt')).toEqual(before);
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER log044_tamper_claim ON core."omniIncomingReceipt"',
      );
      await fixture.owner.query('DROP FUNCTION core.log044_tamper_claim()');
    }
  });

  it('rolls back a new receipt if audit insertion changes its supposedly pristine result', async () => {
    const item = await observation();
    const before = await graph();
    const priorAudit = await audit();
    await fixture.owner.query(
      `CREATE FUNCTION core.log044_tamper_after_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.outcome='success' AND NEW."resourceKind"='omniIncomingReceipt' THEN UPDATE core."omniIncomingReceipt" SET "resultId"='${randomUUID()}'::uuid WHERE id=NEW."resourceId"::uuid; END IF; RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      'CREATE TRIGGER log044_tamper_after_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION core.log044_tamper_after_audit()',
    );
    try {
      await expect(accept(item)).rejects.toThrow(
        'OMNI_SENT_RECEIPT_ACCEPT_POSTCONDITION',
      );
      expect(await core('omniIncomingReceipt')).toEqual([]);
      expect(await graph()).toEqual(before);
      expect(
        (await audit()).filter(
          (row) => !priorAudit.some((entry) => entry.id === row.id),
        ),
      ).toEqual([
        expect.objectContaining({
          outcome: 'failed',
          reasonCode: 'sent_receipt.accept.failed',
        }),
      ]);
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER log044_tamper_after_audit ON crm_audit."crmAuditEntry"',
      );
      await fixture.owner.query(
        'DROP FUNCTION core.log044_tamper_after_audit()',
      );
    }
  });

  it.each(['accept', 'claim'] as const)(
    'does not report a false failure after %s COMMIT acknowledgement is lost',
    async (operation) => {
      const item = await observation();
      const accepted = operation === 'claim' ? await accept(item) : null;
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
          throw new Error('fixture sent receipt lost COMMIT ACK');
        return result;
      }) as typeof client.query);
      jest
        .spyOn(fixture.pool, 'connect')
        .mockImplementationOnce(() => Promise.resolve(client));
      await expect(
        accepted ? claim(accepted.receiptId, item) : accept(item),
      ).rejects.toBeInstanceOf(NativeTransactionOutcomeUnknownError);
      expect(statements).not.toContain('ROLLBACK');
      const [receipt] = await core('omniIncomingReceipt');
      expect(receipt).toMatchObject({
        state: accepted ? 'processing' : 'accepted',
        leaseToken: accepted ? '1' : '0',
      });
      expect(await graph()).toEqual(before);
      expect(await audit()).toHaveLength(priorAudit.length + 1);
      expect((await audit()).every((row) => row.outcome === 'success')).toBe(
        true,
      );
      const committedAudit = await audit();
      if (accepted) {
        expect(await claim(accepted.receiptId, item)).toEqual({
          claimed: false,
          reason: 'lease_live',
        });
        await fixture.owner.query(
          'UPDATE core."omniIncomingReceipt" SET "leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE id=$1',
          [accepted.receiptId],
        );
        expect(await claim(accepted.receiptId, item)).toMatchObject({
          claimed: true,
          proof: { leaseToken: '2' },
        });
      } else {
        expect(await accept(item)).toMatchObject({
          receiptId: receipt.id,
          created: false,
        });
        expect(await audit()).toEqual(committedAudit);
      }
      await noApply();
    },
  );

  it('snapshots the envelope, capture, principal and verifier before context acquisition', async () => {
    const registered = await observation();
    const mutable = {
      envelope: { ...registered.envelope },
      capture: {
        ...registered.capture,
        qualification: { ...registered.capture.qualification },
      },
    };
    const actor = principal();
    const grants = { ...callbacks(registered) };
    const client = await fixture.pool.connect();
    let handedOff = false;
    let signal = () => {};
    const started = new Promise<void>((resolve) => {
      signal = resolve;
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(fixture.pool, 'connect').mockImplementationOnce(async () => {
      handedOff = true;
      signal();
      await gate;
      return client;
    });
    const pending = fixture.service.acceptOmniSentReceipt(
      actor,
      mutable,
      grants,
    );
    try {
      await Promise.race([
        started,
        pending.then(
          () => {
            throw new Error('Receipt completed before connection barrier');
          },
          (error: unknown) => {
            throw error;
          },
        ),
      ]);
      mutable.envelope.eventId = randomUUID();
      mutable.capture.nativeMessageKey = 'changed-key';
      mutable.capture.qualification.adapterId = 'changed-adapter';
      actor.bindingId = randomUUID();
      grants.verifyEvidence = async () => {
        throw new Error('Changed verifier must not run');
      };
      release();
      expect(await pending).toMatchObject({ created: true });
      expect((await core('omniIncomingReceipt'))[0]).toMatchObject({
        validatedEnvelope: registered.envelope,
        trustedCaptureContext: registered.capture,
      });
    } finally {
      release();
      await pending.catch(() => undefined);
      if (!handedOff) client.release();
    }
  });

  it('keeps command.sent away from ordinary incoming claims in every retryable state', async () => {
    const sentIds: string[] = [];
    for (const state of ['accepted', 'retryable_error', 'processing']) {
      const accepted = await accept(await observation());
      sentIds.push(accepted.receiptId);
      await fixture.owner.query(
        `UPDATE core."omniIncomingReceipt" SET state=$2,"leaseOwner"=$3,"leaseToken"=$4,"leaseUntil"=${state === 'processing' ? "clock_timestamp()-interval '1 second'" : 'NULL'} WHERE id=$1`,
        [
          accepted.receiptId,
          state,
          state === 'processing' ? randomUUID() : null,
          state === 'processing' ? '1' : '0',
        ],
      );
    }
    const sentBefore = await core('omniIncomingReceipt');
    const ordinaryIds: string[] = [];
    for (const kind of [
      'message.received',
      'message.edited',
      'message.deleted',
    ]) {
      const result = await acceptOmniIncomingEvent(
        fixture.runtime,
        principal(),
        {
          schemaVersion: 1,
          eventId: randomUUID(),
          accountBindingId: context.bindingId,
          routeGeneration: '1',
          kind,
          providerChatId: 'history-chat',
          providerMessageId: randomUUID(),
          direction: 'incoming',
          sourceVariant: 'complete',
          nativeMessageKeyVersion: 1,
          occurredAt: null,
          sourcePosition: null,
          payload: {
            text: kind === 'message.deleted' ? null : 'Fixture incoming',
            sourceAuthorId: null,
            sourceDisplayName: null,
          },
        },
        async () => {},
      );
      ordinaryIds.push(result.receiptId);
    }
    const claims = await claimOmniIncomingReceipts(
      fixture.runtime,
      principal(),
      { leaseOwner: randomUUID(), limit: 20, leaseMilliseconds: 30000 },
      async () => {},
    );
    expect(claims.map((row) => row.receiptId).sort()).toEqual(
      ordinaryIds.sort(),
    );
    expect(
      (await core('omniIncomingReceipt')).filter((row) =>
        sentIds.includes(String(row.id)),
      ),
    ).toEqual(sentBefore);
  });

  it.each(['renew', 'defer'] as const)(
    'does not let ordinary %s operate on a dedicated sent-receipt lease',
    async (operation) => {
      const item = await observation();
      const accepted = await accept(item);
      const result = await claim(accepted.receiptId, item);
      if (!result.claimed)
        throw new Error('Fixture sent receipt claim missing');
      const { receiptId, leaseOwner, leaseToken, routeGeneration } =
        result.proof;
      const proof = { receiptId, leaseOwner, leaseToken, routeGeneration };
      const before = await core('omniIncomingReceipt');
      const priorAudit = await audit();
      const pending =
        operation === 'renew'
          ? renewOmniIncomingReceiptLease(
              fixture.runtime,
              principal(),
              proof,
              { leaseMilliseconds: 30000 },
              async () => {},
            )
          : deferOmniIncomingReceipt(
              fixture.runtime,
              principal(),
              proof,
              {
                state: 'retryable_error',
                errorCode: 'transient_failure',
                retryAfterMilliseconds: 1000,
              },
              async () => {},
            );
      await expect(pending).rejects.toThrow();
      expect(await core('omniIncomingReceipt')).toEqual(before);
      expect(
        (await audit())
          .filter((row) => !priorAudit.some((entry) => entry.id === row.id))
          .every((row) => row.outcome !== 'success'),
      ).toBe(true);
    },
  );
});
