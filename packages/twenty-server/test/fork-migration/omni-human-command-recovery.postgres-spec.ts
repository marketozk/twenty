import { randomUUID } from 'node:crypto';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { createOmniSentApplyFixture } from 'test/fork-migration/omni-sent-apply.fixture';

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

const fixture = createOmniSentApplyFixture();
let context: Awaited<ReturnType<typeof fixture.reset>>;
type DeferInput = Parameters<
  typeof fixture.service.deferOmniHumanCommandReconciliation
>[1];
type DeferCallbacks = Parameters<
  typeof fixture.service.deferOmniHumanCommandReconciliation
>[2];
const callbacks = (): DeferCallbacks => ({
  authorize: async (scope, descriptor) => {
    expect(scope.workspaceId).toBe(fixture.workspaceId);
    expect(descriptor).toMatchObject({
      action: 'command.reconcile.defer',
      bindingId: context.bindingId,
      conversationId: context.conversationId,
    });
    expect(descriptor.command).not.toHaveProperty('payload');
    expect(descriptor.command).not.toHaveProperty('idempotencyKey');
    expect(Object.isFrozen(descriptor)).toBe(true);
  },
  qualifyTransport: async (scope, descriptor) => {
    expect(scope.workspaceId).toBe(fixture.workspaceId);
    expect(descriptor.command.generation).toBe('1');
  },
});
const input = (): DeferInput => ({
  commandId: context.commandId,
  leaseToken: context.commandLeaseProof.leaseToken,
  leaseUntil: context.commandLeaseProof.leaseUntil,
  capturedRestoreIncarnation:
    context.commandLeaseProof.capturedRestoreIncarnation,
  retryAfterMilliseconds: 30000,
});
const defer = (request = input(), grants = callbacks()) =>
  fixture.service.deferOmniHumanCommandReconciliation(
    context.principal,
    request,
    grants,
  );
const core = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const audit = (): Promise<Record<string, unknown>[]> =>
  fixture.owner.query('SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id');
const command = async () =>
  (await core('omniOutgoingCommand')).find(
    (row) => row.id === context.commandId,
  )!;
const graph = async () => ({
  messages: await fixture.read('message'),
  participants: await fixture.read('messageParticipant'),
  links: await core('omniMessageLink'),
  events: await core('omniDomainEvent'),
  roots: await core('omniRootExecution'),
  plans: await core('omniEventDispatchPlan'),
  conversations: await core('omniConversation'),
});
const claim = async (
  commandId = context.commandId,
  leaseMilliseconds = 30000,
) =>
  fixture.service.claimOmniHumanCommandLease(
    context.principal,
    { commandId, leaseMilliseconds },
    { authorize: async () => {}, qualifyTransport: async () => {} },
  );
const accept = async () => {
  const observation = context.makeObservation();
  const e = observation.envelope;
  return fixture.service.applyOmniConnectorAcceptance(
    context.principal,
    {
      commandId: e.commandId,
      providerChatId: e.providerChatId,
      payloadHash: e.payloadHash,
      generation: e.routeGeneration,
      connectorJobId: e.connectorJobId,
      journalSequence: e.journalSequence,
      qualification: observation.capture.qualification,
    },
    { authorize: async () => {}, verifyEvidence: async () => {} },
  );
};
const sent = async () => {
  const captured = await context.capture();
  return fixture.service.applyOmniSentReceipt(
    context.principal,
    captured.proof,
    context.callbacks(captured.observation),
  );
};
const discovery = (
  limit = 100,
  cursor: Parameters<
    typeof fixture.service.discoverOmniHumanCommandRecovery
  >[1]['cursor'] = null,
) =>
  fixture.service.discoverOmniHumanCommandRecovery(
    context.principal,
    { limit, cursor },
    {
      authorize: async (scope, descriptor) => {
        expect(scope.workspaceId).toBe(fixture.workspaceId);
        expect(descriptor.action).toBe('command.recovery.discover');
        expect(Object.isFrozen(descriptor)).toBe(true);
      },
    },
  );
const expire = () =>
  fixture.owner.query(
    'UPDATE core."omniOutgoingCommand" SET "leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE id=$1',
    [context.commandId],
  );
const due = () =>
  fixture.owner.query(
    'UPDATE core."omniOutgoingCommand" SET "nextAttemptAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1',
    [context.commandId],
  );
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
  context = await fixture.reset({ withoutAcceptance: true });
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('uncertain command recovery through the strict owner', () => {
  it('records uncertainty and backoff atomically then permits only reconciliation', async () => {
    const before = await command(),
      prior = await audit(),
      unchanged = await graph();
    const result = await defer();
    expect(result).toMatchObject({
      deferred: true,
      commandId: context.commandId,
      state: 'outcome_unknown',
      statusRevision: '3',
    });
    if (!result.deferred) throw Error('expected defer');
    expect(result.nextAttemptAt).toMatch(/\.\d{6}Z$/);
    const after = await command();
    expect(after).toEqual({
      ...before,
      state: 'outcome_unknown',
      statusRevision: '3',
      leaseToken: null,
      leaseUntil: null,
      nextAttemptAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(await graph()).toEqual(unchanged);
    expect(await audit()).toHaveLength(prior.length + 1);
    expect(await claim()).toEqual({ claimed: false, reason: 'not_due' });
    expect(await discovery()).toEqual({ candidates: [], nextCursor: null });
    await due();
    expect((await discovery()).candidates.map((row) => row.commandId)).toEqual([
      context.commandId,
    ]);
    expect(await claim()).toMatchObject({
      claimed: true,
      proof: { commandId: context.commandId, purpose: 'reconcile_only' },
    });
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });

  it('makes a concurrent loser and exact replay no-op without another audit', async () => {
    const before = await audit();
    const results = await Promise.all([defer(), defer()]);
    expect(results.filter((r) => r.deferred)).toHaveLength(1);
    expect(results.filter((r) => !r.deferred)).toEqual([
      { deferred: false, reason: 'lease_superseded' },
    ]);
    expect(await audit()).toHaveLength(before.length + 1);
    expect(await defer()).toEqual({
      deferred: false,
      reason: 'lease_superseded',
    });
    expect(await audit()).toHaveLength(before.length + 1);
  });

  it.each(['ack-first', 'defer-first'] as const)(
    'preserves acceptance and handles %s',
    async (order) => {
      if (order === 'ack-first') {
        await accept();
        const before = await command(),
          prior = await audit();
        expect(await defer()).toEqual({
          deferred: false,
          reason: 'lease_superseded',
        });
        expect(await command()).toEqual(before);
        expect(await audit()).toEqual(prior);
        const leased = await claim();
        if (!leased.claimed) throw Error('expected claim');
        const request = {
          ...input(),
          leaseToken: leased.proof.leaseToken,
          leaseUntil: leased.proof.leaseUntil,
          capturedRestoreIncarnation: leased.proof.capturedRestoreIncarnation,
        };
        await defer(request);
        const after = await command();
        expect(after).toMatchObject({
          state: 'outcome_unknown',
          connectorAcceptedEvidence: before.connectorAcceptedEvidence,
          connectorJobId: before.connectorJobId,
          journalSequence: before.journalSequence,
        });
      } else {
        await defer();
        await accept();
        expect(await command()).toMatchObject({
          state: 'outcome_unknown',
          connectorJobId: `fixture-job-${context.commandId}`,
          journalSequence: '1',
        });
      }
    },
  );

  it.each(['sent-first', 'defer-first'] as const)(
    'never downgrades native delivery in %s order',
    async (order) => {
      if (order === 'defer-first') await defer();
      const message = await sent();
      const before = await command(),
        prior = await audit(),
        snapshot = await graph();
      expect(await defer()).toEqual({ deferred: false, reason: 'terminal' });
      expect(before.state).toBe('sent');
      expect(await command()).toEqual(before);
      expect(await audit()).toEqual(prior);
      expect(await graph()).toEqual(snapshot);
      expect(await fixture.read('message')).toEqual([
        expect.objectContaining({ id: message.messageId }),
      ]);
    },
  );

  it('does not overwrite a replacement lease', async () => {
    await expire();
    const newer = await claim();
    expect(newer.claimed).toBe(true);
    const before = await command(),
      prior = await audit();
    expect(await defer()).toEqual({
      deferred: false,
      reason: 'lease_superseded',
    });
    expect(await command()).toEqual(before);
    expect(await audit()).toEqual(prior);
  });

  it.each([
    'lease-expired',
    'restore-changed',
    'pending',
    'failed',
    'cancelled',
  ] as const)('returns an authorized no-op for %s', async (reason) => {
    let request = input();
    if (reason === 'lease-expired') {
      await expire();
      const [row] = await fixture.owner.query(
        `SELECT to_char("leaseUntil" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value FROM core."omniOutgoingCommand" WHERE id=$1`,
        [context.commandId],
      );
      request = { ...request, leaseUntil: row.value };
    } else if (reason === 'restore-changed')
      await fixture.owner.query(
        'UPDATE core."omniWorkspacePolicyState" SET "restoreIncarnation"=$1 WHERE "workspaceId"=$2',
        [randomUUID(), fixture.workspaceId],
      );
    else
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET state=$1 WHERE id=$2',
        [reason, context.commandId],
      );
    const before = await command(),
      prior = await audit();
    const grants = callbacks();
    const auth = jest.fn(grants.authorize);
    const qualification = jest.fn(grants.qualifyTransport);
    expect(
      await defer(request, {
        authorize: auth,
        qualifyTransport: qualification,
      }),
    ).toEqual({
      deferred: false,
      reason:
        reason === 'lease-expired'
          ? 'lease_expired'
          : reason === 'restore-changed'
            ? 'restore_changed'
            : reason === 'pending'
              ? 'pending'
              : 'terminal',
    });
    expect(auth).toHaveBeenCalledTimes(1);
    expect(qualification).toHaveBeenCalledTimes(1);
    expect(await command()).toEqual(before);
    expect(await audit()).toEqual(prior);
  });

  it('allows historical reconciliation after disable, generation change and author deletion', async () => {
    await fixture.owner.query(
      'UPDATE core."omniAccountBinding" SET status=\'disabled\',"routeGeneration"=2,revision=revision+1 WHERE id=$1',
      [context.bindingId],
    );
    await fixture.owner.query(
      `DELETE FROM "${fixture.schemaName}"."workspaceMember" WHERE id=$1`,
      [context.human.workspaceMemberId],
    );
    await fixture.owner.query(
      'UPDATE core."omniConversation" SET status=\'closed\' WHERE id=$1',
      [context.conversationId],
    );
    expect(await defer()).toMatchObject({
      deferred: true,
      state: 'outcome_unknown',
    });
    expect((await command()).generation).toBe('1');
    await due();
    expect((await discovery()).candidates).toHaveLength(1);
  });

  it.each(['authorize', 'qualifyTransport'] as const)(
    'rejects current %s failure with one attempt audit',
    async (callback) => {
      const before = await command(),
        prior = await audit();
      const grants = {
        ...callbacks(),
        [callback]: async () => {
          throw Error('fixture recovery denied');
        },
      };
      await expect(defer(input(), grants)).rejects.toThrow(
        'fixture recovery denied',
      );
      expect(await command()).toEqual(before);
      expect(
        (await audit()).filter((row) => !prior.some((p) => p.id === row.id)),
      ).toEqual([
        expect.objectContaining({
          outcome: callback === 'authorize' ? 'denied' : 'failed',
          reasonCode: `command.recovery.defer.${callback === 'authorize' ? 'denied' : 'failed'}`,
        }),
      ]);
    },
  );

  it.each([
    'audit-failure',
    'command-failure',
    'lease-expiry',
    'backoff-expiry',
    'audit-tamper',
    'after-update-tamper',
  ] as const)('rolls back %s without partial success', async (mode) => {
    let request = input();
    if (mode === 'lease-expiry') {
      await expire();
      const short = await claim(context.commandId, 1000);
      if (!short.claimed) throw Error('expected short lease');
      request = {
        ...request,
        leaseToken: short.proof.leaseToken,
        leaseUntil: short.proof.leaseUntil,
      };
    }
    if (mode === 'backoff-expiry')
      request = { ...request, retryAfterMilliseconds: 1000 };
    const before = await command(),
      prior = await audit();
    const isCommand =
      mode === 'command-failure' || mode === 'after-update-tamper';
    const table = isCommand
      ? 'core."omniOutgoingCommand"'
      : 'crm_audit."crmAuditEntry"';
    let body =
      "IF NEW.outcome='success' THEN RAISE EXCEPTION 'fixture recovery audit failure'; END IF;";
    if (mode === 'command-failure')
      body = "RAISE EXCEPTION 'fixture recovery command failure';";
    if (mode === 'lease-expiry' || mode === 'backoff-expiry')
      body = "IF NEW.outcome='success' THEN PERFORM pg_sleep(1.2); END IF;";
    if (mode === 'audit-tamper')
      body = `IF NEW.outcome='success' THEN UPDATE core."omniOutgoingCommand" SET "cancelReason"='silent-tamper' WHERE id='${context.commandId}'; END IF;`;
    if (mode === 'after-update-tamper')
      body = `IF pg_trigger_depth()=1 AND NEW.state='outcome_unknown' THEN UPDATE core."omniOutgoingCommand" SET "cancelReason"='silent-tamper' WHERE id=NEW.id; END IF;`;
    await fixture.owner.query(
      `CREATE FUNCTION core.log046_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      `CREATE TRIGGER log046_fault ${mode === 'after-update-tamper' ? 'AFTER' : 'BEFORE'} ${isCommand ? 'UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION core.log046_fault()`,
    );
    try {
      await expect(defer(request)).rejects.toThrow();
      expect(await command()).toEqual(before);
      expect(
        (await audit()).filter((row) => !prior.some((p) => p.id === row.id)),
      ).toEqual([
        expect.objectContaining({
          outcome: 'failed',
          reasonCode: 'command.recovery.defer.failed',
        }),
      ]);
    } finally {
      await fixture.owner.query(`DROP TRIGGER log046_fault ON ${table}`);
      await fixture.owner.query('DROP FUNCTION core.log046_fault()');
    }
  });

  it('does not invent failure after actual COMMIT acknowledgement loss', async () => {
    const prior = await audit();
    const client = await fixture.pool.connect();
    const original = client.query.bind(client);
    const statements: string[] = [];
    jest.spyOn(client, 'query').mockImplementation((async (
      sql: string | { text: string; values?: unknown[] },
      values?: unknown[],
    ) => {
      const text = typeof sql === 'string' ? sql : sql.text;
      statements.push(text);
      const result = await original(sql, values);
      if (text === 'COMMIT') throw Error('fixture recovery lost COMMIT ACK');
      return result;
    }) as typeof client.query);
    jest
      .spyOn(fixture.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await expect(defer()).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
    expect(statements).not.toContain('ROLLBACK');
    expect((await command()).state).toBe('outcome_unknown');
    expect(await audit()).toHaveLength(prior.length + 1);
    expect(await defer()).toEqual({
      deferred: false,
      reason: 'lease_superseded',
    });
    expect(await audit()).toHaveLength(prior.length + 1);
  });
});

describe('PostgreSQL-only recovery candidate discovery', () => {
  it('isolates a real second binding from the existing command and its failure audit', async () => {
    const channelId = await fixture.coreInsert('messageChannel', {
      workspaceId: fixture.workspaceId,
      type: 'APP',
      connectedAccountId: context.connectedAccountId,
    });
    const bindingId = await fixture.coreInsert('omniAccountBinding', {
      workspaceId: fixture.workspaceId,
      platform: 'telegram',
      connectorInstanceId: 'second-fixture',
      accountId: randomUUID(),
      connectedAccountId: context.connectedAccountId,
      messageChannelId: channelId,
      capabilitiesVersion: 'fixture-v1',
      capabilities: '{}',
    });
    const principal = { ...context.principal, bindingId };
    const before = await command(),
      prior = await audit();
    await expect(
      fixture.service.deferOmniHumanCommandReconciliation(
        principal,
        input(),
        callbacks(),
      ),
    ).rejects.toThrow('ROW_INTEGRITY');
    expect(
      await fixture.service.discoverOmniHumanCommandRecovery(
        principal,
        { limit: 100, cursor: null },
        { authorize: async () => {} },
      ),
    ).toEqual({ candidates: [], nextCursor: null });
    expect(await command()).toEqual(before);
    expect(await audit()).toEqual(prior);
  });

  it('preserves cancellation and prior unknown through another reconciliation delay', async () => {
    await defer();
    await due();
    const leased = await claim();
    if (!leased.claimed) throw Error('expected reconciliation lease');
    await fixture.owner.query(
      'UPDATE core."omniOutgoingCommand" SET "cancelRequestedAt"=clock_timestamp(),"cancelReason"=\'operator_requested\',"cancelEvidence"=\'{"pending":true}\'::jsonb WHERE id=$1',
      [context.commandId],
    );
    const before = await command();
    expect(
      await defer({
        ...input(),
        leaseToken: leased.proof.leaseToken,
        leaseUntil: leased.proof.leaseUntil,
      }),
    ).toMatchObject({ deferred: true, state: 'outcome_unknown' });
    const after = await command();
    expect(after).toMatchObject({
      cancelRequestedAt: before.cancelRequestedAt,
      cancelReason: before.cancelReason,
      cancelEvidence: before.cancelEvidence,
    });
  });

  it('pages exact microseconds without changing data and restarts after mutable deadlines', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 5; index++)
      ids.push((await context.admit()).commandId);
    for (let index = 0; index < ids.length; index++)
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET "nextAttemptAt"=$1::timestamptz WHERE id=$2',
        [`2001-01-01T00:00:00.00000${index + 1}Z`, ids[index]],
      );
    const before = await core('omniOutgoingCommand'),
      prior = await audit();
    let cursor: Parameters<typeof discovery>[1] = null;
    const seen: string[] = [];
    do {
      const page = await discovery(2, cursor);
      seen.push(...page.candidates.map((c) => c.commandId));
      cursor = page.nextCursor;
      if (cursor) expect(cursor.nextAttemptAt).toMatch(/\.\d{6}Z$/);
    } while (cursor);
    expect(seen).toEqual(ids);
    expect(await core('omniOutgoingCommand')).toEqual(before);
    expect(await audit()).toEqual(prior);
    await expire();
    expect((await discovery()).candidates.map((c) => c.commandId)).toContain(
      context.commandId,
    );
    const blocked = await fixture.service.claimOmniHumanCommandLease(
      context.principal,
      { commandId: ids[0], leaseMilliseconds: 30000 },
      { authorize: async () => {}, qualifyTransport: async () => {} },
    );
    expect(blocked).toEqual({ claimed: false, reason: 'waiting_predecessor' });
    expect((await discovery(2)).candidates).toHaveLength(2);
  });

  it.each([
    'future',
    'live-lease',
    'sent',
    'failed',
    'cancelled',
    'other-binding',
    'unsupported-version',
  ] as const)('does not disclose %s candidates', async (mode) => {
    const extra = (await context.admit()).commandId;
    if (mode === 'future')
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET "nextAttemptAt"=clock_timestamp()+interval \'1 hour\' WHERE id=$1',
        [extra],
      );
    if (mode === 'live-lease')
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET "leaseUntil"=clock_timestamp()+interval \'1 hour\',"leaseToken"=$1 WHERE id=$2',
        [randomUUID(), extra],
      );
    if (['sent', 'failed', 'cancelled'].includes(mode))
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET state=$1 WHERE id=$2',
        [mode, extra],
      );
    if (mode === 'unsupported-version')
      await fixture.owner.query(
        "UPDATE core.\"omniOutgoingCommand\" SET payload=jsonb_set(payload,'{version}','2') WHERE id=$1",
        [extra],
      );
    if (mode === 'other-binding') {
      await expect(
        fixture.service.discoverOmniHumanCommandRecovery(
          { ...context.principal, bindingId: randomUUID() },
          { limit: 100, cursor: null },
          { authorize: async () => {} },
        ),
      ).rejects.toThrow();
      return;
    }
    expect(await discovery()).toEqual({ candidates: [], nextCursor: null });
  });

  it('requires current discovery authorization and keeps ordinary reads mutation-free', async () => {
    const before = await core('omniOutgoingCommand'),
      prior = await audit();
    await expect(
      fixture.service.discoverOmniHumanCommandRecovery(
        context.principal,
        { limit: 100, cursor: null },
        {
          authorize: async () => {
            throw Error('fixture discovery denied');
          },
        },
      ),
    ).rejects.toThrow('fixture discovery denied');
    expect(await core('omniOutgoingCommand')).toEqual(before);
    expect(await audit()).toEqual(prior);
  });
});
