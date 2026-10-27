import { randomUUID } from 'node:crypto';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
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
type Callbacks = Parameters<
  typeof fixture.service.claimOmniHumanCommandLease
>[2];
const principal = () => ({
  workspaceId: fixture.workspaceId,
  bindingId: context.bindingId,
  actor: { kind: 'system' as const, id: context.principal.actor.id },
});
const callbacks = (): Callbacks => ({
  authorize: async (scope, request) => {
    expect(scope.workspaceId).toBe(fixture.workspaceId);
    expect(request).toMatchObject({
      principal: {
        workspaceId: fixture.workspaceId,
        bindingId: context.bindingId,
      },
      bindingId: context.bindingId,
    });
    expect(request.capturedAuthor).toEqual({
      workspaceMemberId: context.human.workspaceMemberId,
      userId: request.purpose === 'first_attempt' ? context.human.userId : null,
    });
    expect(request.action).toBe(
      request.purpose === 'first_attempt'
        ? 'command.send'
        : 'command.reconcile',
    );
    expect(request.command).not.toHaveProperty('payload');
    expect(request.command).not.toHaveProperty('idempotencyKey');
    expect(Object.isFrozen(request)).toBe(true);
  },
  // Explicit fixture qualification only; this never asserts real connector capabilities.
  qualifyTransport: async (scope) => {
    expect(scope.workspaceId).toBe(fixture.workspaceId);
  },
});
const claim = (
  id = commandId,
  grants = callbacks(),
  leaseMilliseconds = 30000,
) =>
  fixture.service.claimOmniHumanCommandLease(
    principal(),
    { commandId: id, leaseMilliseconds },
    grants,
  );
const claimProof = async (
  id = commandId,
  grants = callbacks(),
  leaseMilliseconds = 30000,
) => {
  const result = await claim(id, grants, leaseMilliseconds);
  if (!result.claimed)
    throw new Error(`Expected fixture claim, got ${result.reason}`);
  return result.proof;
};
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
const noDelivery = async () => {
  expect(await fixture.read('message')).toEqual([]);
  expect(await fixture.read('messageParticipant')).toEqual([]);
  expect(await core('omniMessageLink')).toEqual([]);
  expect(await core('omniAutomationAdmission')).toEqual([]);
  expect(fixture.eventEmitter).not.toHaveBeenCalled();
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
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('human outbox lease through the strict owner', () => {
  it('leases a virgin admitted intent with only one command audit and no delivery effects', async () => {
    const before = await graph();
    const priorAudit = await audit();
    const [policy] = await core('omniWorkspacePolicyState');
    const proof = await claimProof();
    expect(proof).toMatchObject({
      commandId,
      purpose: 'first_attempt',
      capturedRestoreIncarnation: policy.restoreIncarnation,
    });
    expect(proof.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(proof.leaseUntil).toMatch(/\.\d{6}Z$/);
    expect(await core('omniOutgoingCommand')).toEqual([
      expect.objectContaining({
        id: commandId,
        state: 'dispatching',
        statusRevision: '2',
        leaseToken: proof.leaseToken,
      }),
    ]);
    expect(await graph()).toEqual(before);
    const entries = await audit();
    expect(entries).toHaveLength(priorAudit.length + 1);
    expect(
      entries.filter((row) => !priorAudit.some((prior) => prior.id === row.id)),
    ).toEqual([
      expect.objectContaining({
        outcome: 'success',
        resourceKind: 'omniOutgoingCommand',
        resourceId: commandId,
        action: 'update',
      }),
    ]);
    await noDelivery();
  });

  it('gives one worker the lease when two workers claim the same command', async () => {
    const before = await graph();
    const outcomes = await Promise.all([claim(), claim()]);
    expect(outcomes.filter((outcome) => outcome.claimed)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.claimed)).toEqual([
      { claimed: false, reason: 'lease_live' },
    ]);
    expect((await core('omniOutgoingCommand'))[0]).toMatchObject({
      state: 'dispatching',
      statusRevision: '2',
    });
    expect(await graph()).toEqual(before);
    expect(
      (await audit()).filter((row) => row.outcome === 'success'),
    ).toHaveLength(6);
  });

  it.each(['dispatching', 'accepted', 'outcome_unknown'] as const)(
    'reclaims expired %s only for reconciliation without clearing historical evidence',
    async (state) => {
      const first = await claimProof();
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET state=$1,"leaseUntil"=clock_timestamp()-interval \'1 second\',"connectorJobId"=$2,"connectorAcceptedEvidence"=$3::jsonb,"journalSequence"=7 WHERE id=$4',
        [
          state,
          'historical-job',
          JSON.stringify({ fixture: 'retained-only-not-verified' }),
          commandId,
        ],
      );
      const before = await graph();
      const proof = await claimProof();
      expect(proof).toMatchObject({ commandId, purpose: 'reconcile_only' });
      expect(proof.leaseToken).not.toBe(first.leaseToken);
      expect((await core('omniOutgoingCommand'))[0]).toMatchObject({
        state,
        statusRevision: '3',
        connectorJobId: 'historical-job',
        connectorAcceptedEvidence: { fixture: 'retained-only-not-verified' },
        journalSequence: '7',
      });
      expect(await graph()).toEqual(before);
      await noDelivery();
    },
  );

  it.each(['sent', 'failed', 'cancelled'] as const)(
    'does not resurrect terminal %s',
    async (state) => {
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET state=$1 WHERE id=$2',
        [state, commandId],
      );
      const before = await core('omniOutgoingCommand');
      const priorAudit = await audit();
      expect(await claim()).toEqual({ claimed: false, reason: 'terminal' });
      expect(await core('omniOutgoingCommand')).toEqual(before);
      expect(await audit()).toEqual(priorAudit);
      await noDelivery();
    },
  );

  it.each(['revision', 'lease', 'cancel', 'evidence', 'not-due'] as const)(
    'rejects non-virgin or not-due pending command: %s',
    async (kind) => {
      const updates = {
        revision: '"statusRevision"=2',
        lease: `"leaseToken"='${randomUUID()}',"leaseUntil"=clock_timestamp()-interval '1 second'`,
        cancel: '"cancelRequestedAt"=clock_timestamp()',
        evidence: '"connectorAcceptedEvidence"=\'{"unverified":true}\'::jsonb',
        'not-due': '"nextAttemptAt"=clock_timestamp()+interval \'1 hour\'',
      };
      await fixture.owner.query(
        `UPDATE core."omniOutgoingCommand" SET ${updates[kind]} WHERE id=$1`,
        [commandId],
      );
      const before = await core('omniOutgoingCommand');
      const priorAudit = await audit();
      expect(await claim()).toEqual({
        claimed: false,
        reason: kind === 'not-due' ? 'not_due' : 'non_virgin_pending',
      });
      expect(await core('omniOutgoingCommand')).toEqual(before);
      expect(await audit()).toEqual(priorAudit);
      await noDelivery();
    },
  );

  it.each([
    'revoked-author',
    'inactive-binding',
    'changed-generation',
    'closed',
  ] as const)(
    'rejects a first attempt after %s while permitting only historical reconciliation',
    async (kind) => {
      if (kind === 'revoked-author')
        await fixture.owner.query(
          'UPDATE core."userWorkspace" SET "deletedAt"=clock_timestamp() WHERE "userId"=$1',
          [context.human.userId],
        );
      if (kind === 'inactive-binding')
        await fixture.owner.query(
          'UPDATE core."omniAccountBinding" SET status=\'inactive\' WHERE id=$1',
          [context.bindingId],
        );
      if (kind === 'changed-generation')
        await fixture.owner.query(
          'UPDATE core."omniAccountBinding" SET "routeGeneration"=2 WHERE id=$1',
          [context.bindingId],
        );
      if (kind === 'closed')
        await fixture.owner.query(
          'UPDATE core."omniConversation" SET status=\'closed\' WHERE id=$1',
          [context.conversationId],
        );
      const before = await core('omniOutgoingCommand');
      await expect(claim()).rejects.toThrow();
      expect(await core('omniOutgoingCommand')).toEqual(before);
      // Historical transport state is a fixture precondition, never a synthesized send result.
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET state=\'outcome_unknown\',"statusRevision"=2,"leaseToken"=$1,"leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE id=$2',
        [randomUUID(), commandId],
      );
      expect(await claimProof()).toMatchObject({
        commandId,
        purpose: 'reconcile_only',
      });
      expect((await core('omniOutgoingCommand'))[0]).toMatchObject({
        state: 'outcome_unknown',
        statusRevision: '3',
      });
      await noDelivery();
    },
  );

  it.each(['workspace', 'binding', 'command'] as const)(
    'does not leak or audit a foreign %s',
    async (kind) => {
      const actor = principal();
      const requestedId = kind === 'command' ? randomUUID() : commandId;
      if (kind === 'workspace') actor.workspaceId = randomUUID();
      if (kind === 'binding') actor.bindingId = randomUUID();
      const before = await core('omniOutgoingCommand');
      const priorAudit = await audit();
      await expect(
        fixture.service.claimOmniHumanCommandLease(
          actor,
          { commandId: requestedId, leaseMilliseconds: 30000 },
          callbacks(),
        ),
      ).rejects.toThrow();
      expect(await core('omniOutgoingCommand')).toEqual(before);
      expect(await audit()).toEqual(priorAudit);
    },
  );

  it('keeps a later command waiting behind an unclaimed predecessor without a false failure audit', async () => {
    const laterId = (await context.admit()).commandId;
    const before = await core('omniOutgoingCommand');
    const priorAudit = await audit();
    expect(await claim(laterId)).toEqual({
      claimed: false,
      reason: 'waiting_predecessor',
    });
    expect(await core('omniOutgoingCommand')).toEqual(before);
    expect(await audit()).toEqual(priorAudit);
  });

  it('does not treat accepted state and arbitrary evidence as verified FIFO acceptance', async () => {
    const laterId = (await context.admit()).commandId;
    await fixture.owner.query(
      'UPDATE core."omniOutgoingCommand" SET state=\'accepted\',"connectorJobId"=\'fixture-job\',"journalSequence"=1,"connectorAcceptedEvidence"=\'{"unverified":true}\'::jsonb WHERE id=$1',
      [commandId],
    );
    const before = await core('omniOutgoingCommand');
    const priorAudit = await audit();
    await expect(claim(laterId)).rejects.toThrow(
      'OMNI_HUMAN_COMMAND_LEASE_PREDECESSOR_VERIFIER_REQUIRED',
    );
    expect(await core('omniOutgoingCommand')).toEqual(before);
    expect(
      (await audit()).filter(
        (row) => !priorAudit.some((entry) => entry.id === row.id),
      ),
    ).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        reasonCode: 'command.claim.failed',
      }),
    ]);
  });

  it.each(['accepted', 'cancelled'] as const)(
    'requires a trusted validator before crossing a %s FIFO predecessor',
    async (state) => {
      const laterId = (await context.admit()).commandId;
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET state=$1,"connectorJobId"=$2,"journalSequence"=$3,"connectorAcceptedEvidence"=$4::jsonb,"cancelEvidence"=$5::jsonb WHERE id=$6',
        [
          state,
          state === 'accepted' ? 'fixture-job' : null,
          state === 'accepted' ? '0' : null,
          state === 'accepted'
            ? JSON.stringify({
                fixtureJournal: 'verified-by-explicit-callback',
              })
            : null,
          state === 'cancelled'
            ? JSON.stringify({ fixtureTerminal: 'verified-before-enqueue' })
            : null,
          commandId,
        ],
      );
      const verifier = jest.fn<
        ReturnType<NonNullable<Callbacks['verifyPredecessor']>>,
        Parameters<NonNullable<Callbacks['verifyPredecessor']>>
      >(async () =>
        state === 'accepted' ? 'durably_accepted' : 'terminal_before_enqueue',
      );
      const grants = { ...callbacks(), verifyPredecessor: verifier };
      expect(await claimProof(laterId, grants)).toMatchObject({
        commandId: laterId,
        purpose: 'first_attempt',
      });
      expect(verifier).toHaveBeenCalledTimes(1);
      expect(
        (await core('omniOutgoingCommand')).find((row) => row.id === commandId),
      ).toMatchObject({ state, leaseToken: null, statusRevision: '1' });
      await noDelivery();
    },
  );

  it.each(['authorize', 'qualifyTransport'] as const)(
    'rolls back when mandatory current %s rejects',
    async (callback) => {
      const grants = {
        ...callbacks(),
        [callback]: async () => {
          throw new Error(`fixture ${callback} denied`);
        },
      };
      const before = await core('omniOutgoingCommand');
      const priorAudit = await audit();
      await expect(claim(commandId, grants)).rejects.toThrow(
        `fixture ${callback} denied`,
      );
      expect(await core('omniOutgoingCommand')).toEqual(before);
      const attempts = (await audit()).filter(
        (row) => !priorAudit.some((entry) => entry.id === row.id),
      );
      expect(attempts).toEqual([
        expect.objectContaining({
          resourceId: commandId,
          outcome: callback === 'authorize' ? 'denied' : 'failed',
          reasonCode:
            callback === 'authorize'
              ? 'command.claim.denied'
              : 'command.claim.failed',
        }),
      ]);
    },
  );

  it.each(['omniOutgoingCommand', 'crmAuditEntry'])(
    'rolls back lease and success audit together if %s write fails',
    async (table) => {
      const schema = table === 'crmAuditEntry' ? 'crm_audit' : 'core';
      const operation = table === 'crmAuditEntry' ? 'INSERT' : 'UPDATE';
      const before = await core('omniOutgoingCommand');
      const priorAudit = await audit();
      await fixture.owner.query(
        `CREATE FUNCTION core.log042_fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${table === 'crmAuditEntry' ? "IF NEW.outcome='success' THEN RAISE EXCEPTION 'fixture lease write failure'; END IF;" : "RAISE EXCEPTION 'fixture lease write failure';"} RETURN NEW; END $$`,
      );
      await fixture.owner.query(
        `CREATE TRIGGER log042_fail_write BEFORE ${operation} ON "${schema}"."${table}" FOR EACH ROW EXECUTE FUNCTION core.log042_fail_write()`,
      );
      try {
        const outcome: unknown = await claim().catch((error: unknown) => error);
        expect(errorMessages(outcome)).toContain('fixture lease write failure');
        expect(await core('omniOutgoingCommand')).toEqual(before);
        expect(
          (await audit()).filter(
            (row) => !priorAudit.some((entry) => entry.id === row.id),
          ),
        ).toEqual([
          expect.objectContaining({
            outcome: 'failed',
            resourceId: commandId,
            reasonCode: 'command.claim.failed',
          }),
        ]);
        await noDelivery();
      } finally {
        await fixture.owner.query(
          `DROP TRIGGER log042_fail_write ON "${schema}"."${table}"`,
        );
        await fixture.owner.query('DROP FUNCTION core.log042_fail_write()');
      }
    },
  );

  it('does not return an expired lease when success audit consumes its lifetime', async () => {
    const before = await core('omniOutgoingCommand');
    const priorAudit = await audit();
    await fixture.owner.query(
      `CREATE FUNCTION core.log042_slow_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.outcome='success' THEN PERFORM pg_sleep(1.2); END IF; RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      'CREATE TRIGGER log042_slow_audit BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION core.log042_slow_audit()',
    );
    try {
      await expect(claim(commandId, callbacks(), 1000)).rejects.toThrow();
      expect(await core('omniOutgoingCommand')).toEqual(before);
      expect(
        (await audit()).filter(
          (row) => !priorAudit.some((entry) => entry.id === row.id),
        ),
      ).toEqual([
        expect.objectContaining({
          outcome: 'failed',
          reasonCode: 'command.claim.failed',
        }),
      ]);
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER log042_slow_audit ON crm_audit."crmAuditEntry"',
      );
      await fixture.owner.query('DROP FUNCTION core.log042_slow_audit()');
    }
  });

  it('snapshots principal, input and callbacks before waiting for the native connection', async () => {
    const actor = principal();
    const input = { commandId, leaseMilliseconds: 30000 };
    const grants = { ...callbacks() };
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
    const pending = fixture.service.claimOmniHumanCommandLease(
      actor,
      input,
      grants,
    );
    try {
      await Promise.race([
        started,
        pending.then(
          () => {
            throw new Error('Claim completed before connection barrier');
          },
          (error: unknown) => {
            throw error;
          },
        ),
      ]);
      actor.bindingId = randomUUID();
      actor.actor.id = 'changed-worker';
      input.commandId = randomUUID();
      input.leaseMilliseconds = 1;
      grants.authorize = async () => {
        throw new Error('Changed authorization must not run');
      };
      grants.qualifyTransport = async () => {
        throw new Error('Changed qualification must not run');
      };
      release();
      expect(await pending).toMatchObject({
        claimed: true,
        proof: { commandId, purpose: 'first_attempt' },
      });
      expect((await core('omniOutgoingCommand'))[0]).toMatchObject({
        state: 'dispatching',
        statusRevision: '2',
      });
    } finally {
      release();
      await pending.catch(() => undefined);
      if (!handedOff) client.release();
    }
  });

  it('rejects a trigger-altered lease token instead of returning a false ownership proof', async () => {
    const before = await core('omniOutgoingCommand');
    const priorAudit = await audit();
    await fixture.owner.query(
      `CREATE FUNCTION core.log042_tamper_lease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW."leaseToken" := '${randomUUID()}'::uuid; RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      'CREATE TRIGGER log042_tamper_lease BEFORE UPDATE ON core."omniOutgoingCommand" FOR EACH ROW EXECUTE FUNCTION core.log042_tamper_lease()',
    );
    try {
      await expect(claim()).rejects.toThrow();
      expect(await core('omniOutgoingCommand')).toEqual(before);
      expect(
        (await audit()).filter(
          (row) => !priorAudit.some((entry) => entry.id === row.id),
        ),
      ).toEqual([
        expect.objectContaining({
          outcome: 'failed',
          reasonCode: 'command.claim.failed',
        }),
      ]);
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER log042_tamper_lease ON core."omniOutgoingCommand"',
      );
      await fixture.owner.query('DROP FUNCTION core.log042_tamper_lease()');
    }
  });

  it('propagates lost COMMIT acknowledgement without returning a proof or writing a false failed audit', async () => {
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
      if (text === 'COMMIT') throw new Error('fixture lease lost COMMIT ACK');
      return result;
    }) as typeof client.query);
    jest
      .spyOn(fixture.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await expect(claim()).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
    expect(statements).not.toContain('ROLLBACK');
    expect((await core('omniOutgoingCommand'))[0]).toMatchObject({
      state: 'dispatching',
      statusRevision: '2',
    });
    expect(await graph()).toEqual(before);
    expect(await audit()).toHaveLength(priorAudit.length + 1);
    expect((await audit()).every((row) => row.outcome === 'success')).toBe(
      true,
    );
    expect(await claim()).toEqual({ claimed: false, reason: 'lease_live' });
    await fixture.owner.query(
      'UPDATE core."omniOutgoingCommand" SET "leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE id=$1',
      [commandId],
    );
    expect(await claimProof()).toMatchObject({
      commandId,
      purpose: 'reconcile_only',
    });
    await noDelivery();
  });
});
