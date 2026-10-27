import { randomUUID } from 'node:crypto';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { mutateOmniBindingConfiguration } from 'src/modules/omnichannel/services/mutate-omni-binding-configuration';
import {
  claimOmniBindingConfigWakeups,
  processOmniBindingConfigWakeupPage,
  rearmOmniBindingConfigWakeup,
  reconcileOmniBindingConfigWakeups,
} from 'src/modules/omnichannel/services/omni-binding-config-wakeup';
import { deferOmniIncomingReceipt } from 'src/modules/omnichannel/services/omni-incoming-receipt-lease';
import { createOmniHistoryApplyFixture } from 'test/fork-migration/omni-history-apply.fixture';

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

const fixture = createOmniHistoryApplyFixture({ includeTargets: true });
let context: Awaited<ReturnType<typeof fixture.reset>>;
type Claim = Awaited<ReturnType<typeof claimOmniBindingConfigWakeups>>[number];
type WakeAuthorizer = Parameters<typeof claimOmniBindingConfigWakeups>[3];
type ResumeAuthorizer = Parameters<
  typeof processOmniBindingConfigWakeupPage
>[5];
const core = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const audit = (): Promise<Record<string, unknown>[]> =>
  fixture.owner.query('SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id');
const run = async <T>(
  work: (scope: WorkspaceTransactionScope) => Promise<T>,
): Promise<T> =>
  fixture.withContext(() =>
    fixture.dataSource.transaction(work, { commitOutcome: 'strict' }),
  );
const authorize: WakeAuthorizer = async (scope, request) => {
  // Explicit fixture permissions only; no runtime default grant is supplied.
  expect(scope.workspaceId).toBe(fixture.workspaceId);
  expect(request.workspaceId).toBe(fixture.workspaceId);
  expect(request.bindingId).toBe(context.bindingId);
};
const authorizeResume: ResumeAuthorizer = async (scope, request) => {
  expect(scope.workspaceId).toBe(fixture.workspaceId);
  expect(request).toMatchObject({
    action: 'history.resume',
    bindingId: context.bindingId,
    policyId: context.policyId,
  });
};
const produce = () =>
  mutateOmniBindingConfiguration(
    fixture.runtime,
    { workspaceId: fixture.workspaceId, actor: context.principal.actor },
    {
      action: 'queue.create',
      bindingId: context.bindingId,
      name: randomUUID(),
      expectedRevision: '0',
      idempotencyKey: randomUUID(),
    },
    async () => undefined,
  );
const claim = (
  limit = 1,
  leaseMilliseconds = 300000,
  grant: WakeAuthorizer = authorize,
) =>
  run((scope) =>
    claimOmniBindingConfigWakeups(
      scope,
      context.principal,
      { leaseOwner: randomUUID(), limit, leaseMilliseconds },
      grant,
    ),
  );
const claimOne = async () => {
  const claims = await claim();
  if (claims.length !== 1)
    throw new Error('Expected one configuration wakeup claim');
  return claims[0];
};
const process = (
  claimed: Claim,
  limit = 100,
  grant: WakeAuthorizer = authorize,
  resumeGrant: ResumeAuthorizer = authorizeResume,
) =>
  run((scope) =>
    processOmniBindingConfigWakeupPage(
      scope,
      context.principal,
      {
        wakeupId: claimed.wakeupId,
        leaseOwner: claimed.leaseOwner,
        leaseToken: claimed.leaseToken,
      },
      { limit },
      grant,
      resumeGrant,
    ),
  );
const reconcile = (
  input: Parameters<typeof reconcileOmniBindingConfigWakeups>[2] = {
    limit: 100,
  },
  grant: WakeAuthorizer = authorize,
) =>
  run((scope) =>
    reconcileOmniBindingConfigWakeups(scope, context.principal, input, grant),
  );
const block = async (
  origin: 'history_import' | 'live' | null = 'history_import',
) => {
  const captured = await fixture.capture(
    context,
    { providerMessageId: randomUUID() },
    origin,
  );
  const { externalIdentityId: _externalIdentityId, ...proof } = captured.proof;
  await deferOmniIncomingReceipt(
    fixture.runtime,
    context.principal,
    proof,
    { state: 'blocked_config', errorCode: 'configuration_missing' },
    async () => undefined,
  );
  return captured;
};
const snapshot = async () => ({
  wakeups: await core('omniBindingConfigWakeup'),
  receipts: await core('omniIncomingReceipt'),
  audit: await audit(),
});
const noSideEffects = async () => {
  for (const table of [
    'omniRootExecution',
    'omniEventDispatchPlan',
    'omniAutomationAdmission',
    'omniOutgoingCommand',
    'omniReplyBudget',
    'omniMessageLink',
    'omniMessageRevision',
  ])
    expect(await core(table)).toEqual([]);
  for (const table of [
    'messageThread',
    'message',
    'messageParticipant',
    'messageThreadTarget',
  ] as const)
    expect(await fixture.read(table)).toEqual([]);
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

beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    `GRANT INSERT,UPDATE ON core."omniBindingConfigWakeup",core."omniQueue" TO "${fixture.roleName}"`,
  );
  await fixture.owner.query(
    `GRANT UPDATE ON core."omniAccountBinding",core."omniWorkspacePolicyState" TO "${fixture.roleName}"`,
  );
  await fixture.owner.query(
    `GRANT INSERT,UPDATE(id) ON core."omniPolicyMutationReceipt" TO "${fixture.roleName}"`,
  );
});
beforeEach(async () => {
  context = await fixture.reset({ withoutConversation: true });
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('durable binding configuration wakeup processing', () => {
  it('claims a produced event and atomically resumes qualified receipts without business side effects', async () => {
    const captured = await block();
    const event = await produce();
    const claimed = await claimOne();
    expect(claimed).toMatchObject({
      eventId: event.eventId,
      bindingId: context.bindingId,
      leaseToken: '1',
      routeGeneration: '1',
    });
    const processed = await process(claimed);
    expect(processed).toMatchObject({
      wakeupId: claimed.wakeupId,
      state: 'completed',
      resumedReceiptIds: [captured.proof.receiptId],
      nextCursor: null,
      needsRescan: false,
    });
    expect(await core('omniBindingConfigWakeup')).toEqual([
      expect.objectContaining({
        state: 'completed',
        leaseOwner: null,
        leaseUntil: null,
        leaseToken: '1',
        attempts: 1,
      }),
    ]);
    expect((await core('omniIncomingReceipt'))[0]).toMatchObject({
      state: 'retryable_error',
      attempts: 1,
      leaseToken: '1',
    });
    expect(await claim()).toEqual([]);
    await noSideEffects();
  });

  it('persists microsecond cursors across separate page transactions and completes after restart', async () => {
    const receipts = [await block(), await block(), await block()].sort(
      (left, right) =>
        right.proof.receiptId.localeCompare(left.proof.receiptId),
    );
    const timestamps = [
      '2026-10-01T12:00:00.123456Z',
      '2026-10-01T12:00:00.123457Z',
      '2026-10-01T12:00:00.123458Z',
    ];
    for (const [index, receipt] of receipts.entries())
      await fixture.owner.query(
        'UPDATE core."omniIncomingReceipt" SET "nextAttemptAt"=$1 WHERE id=$2',
        [timestamps[index], receipt.proof.receiptId],
      );
    await produce();
    for (const [index, receipt] of receipts.entries()) {
      const claimed = await claimOne();
      expect(claimed.leaseToken).toBe(String(index + 1));
      const result = await process(claimed, 1);
      expect(result).toMatchObject({
        state: 'pending',
        resumedReceiptIds: [receipt.proof.receiptId],
        nextCursor: {
          nextAttemptAt: timestamps[index],
          id: receipt.proof.receiptId,
        },
      });
      const [stored]: { timestamp: string; cursorReceiptId: string }[] =
        await fixture.owner.query(
          `SELECT to_char("cursorNextAttemptAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS timestamp,"cursorReceiptId" FROM core."omniBindingConfigWakeup"`,
        );
      expect(stored).toEqual({
        timestamp: timestamps[index],
        cursorReceiptId: receipt.proof.receiptId,
      });
    }
    expect(await process(await claimOne(), 1)).toMatchObject({
      state: 'completed',
      resumedReceiptIds: [],
    });
    expect((await core('omniBindingConfigWakeup'))[0]).toMatchObject({
      attempts: 4,
      leaseToken: '4',
      leaseOwner: null,
      leaseUntil: null,
    });
    expect(
      (await core('omniIncomingReceipt')).every(
        (row) => row.state === 'retryable_error',
      ),
    ).toBe(true);
  });

  it('carries needsRescan across later pages and eventually revisits a locked earlier receipt', async () => {
    const first = await block();
    const second = await block();
    await fixture.owner.query(
      'UPDATE core."omniIncomingReceipt" SET "nextAttemptAt"=\'2026-10-01T00:00:00Z\' WHERE id=$1',
      [first.proof.receiptId],
    );
    await fixture.owner.query(
      'UPDATE core."omniIncomingReceipt" SET "nextAttemptAt"=\'2026-10-02T00:00:00Z\' WHERE id=$1',
      [second.proof.receiptId],
    );
    await produce();
    const holder = fixture.owner.createQueryRunner();
    try {
      await holder.connect();
      await holder.startTransaction();
      await holder.query(
        'SELECT id FROM core."omniIncomingReceipt" WHERE id=$1 FOR UPDATE',
        [first.proof.receiptId],
      );
      expect(await process(await claimOne(), 1)).toMatchObject({
        state: 'pending',
        resumedReceiptIds: [],
        needsRescan: true,
      });
      expect((await core('omniBindingConfigWakeup'))[0].needsRescan).toBe(true);
      expect(await process(await claimOne(), 1)).toMatchObject({
        state: 'pending',
        resumedReceiptIds: [second.proof.receiptId],
        needsRescan: true,
      });
      expect(await process(await claimOne(), 1)).toMatchObject({
        state: 'retryable',
        resumedReceiptIds: [],
        nextCursor: null,
      });
      expect((await core('omniBindingConfigWakeup'))[0]).toMatchObject({
        cursorReceiptId: null,
        cursorNextAttemptAt: null,
        errorCode: 'rescan_required',
      });
      await holder.commitTransaction();
      await fixture.owner.query(
        'UPDATE core."omniBindingConfigWakeup" SET "nextAttemptAt"=clock_timestamp()',
      );
      expect(await process(await claimOne())).toMatchObject({
        state: 'completed',
        resumedReceiptIds: [first.proof.receiptId],
        needsRescan: false,
      });
      expect(
        (await core('omniIncomingReceipt')).every(
          (row) => row.state === 'retryable_error',
        ),
      ).toBe(true);
    } finally {
      if (holder.isTransactionActive) await holder.rollbackTransaction();
      await holder.release();
    }
  });

  it('advances a full ineligible receipt page instead of starving a later qualified receipt', async () => {
    const ineligible = await block(null);
    const eligible = await block();
    await fixture.owner.query(
      'UPDATE core."omniIncomingReceipt" SET "nextAttemptAt"=\'2026-10-01T00:00:00Z\' WHERE id=$1',
      [ineligible.proof.receiptId],
    );
    await fixture.owner.query(
      'UPDATE core."omniIncomingReceipt" SET "nextAttemptAt"=\'2026-10-02T00:00:00Z\' WHERE id=$1',
      [eligible.proof.receiptId],
    );
    await produce();
    expect(await process(await claimOne(), 1)).toMatchObject({
      state: 'pending',
      resumedReceiptIds: [],
    });
    expect(await process(await claimOne(), 1)).toMatchObject({
      state: 'pending',
      resumedReceiptIds: [eligible.proof.receiptId],
    });
    expect(await process(await claimOne(), 1)).toMatchObject({
      state: 'completed',
    });
    expect(
      (await core('omniIncomingReceipt')).find(
        (row) => row.id === ineligible.proof.receiptId,
      )?.state,
    ).toBe('blocked_config');
  });

  it('lets only one worker own a live wakeup lease and reclaims it after expiry with a new token', async () => {
    await produce();
    const claims = (await Promise.all([claim(), claim()])).flat();
    expect(claims).toHaveLength(1);
    const original = claims[0];
    await fixture.owner.query(
      'UPDATE core."omniBindingConfigWakeup" SET "leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE id=$1',
      [original.wakeupId],
    );
    const replacement = await claimOne();
    expect(replacement).toMatchObject({
      wakeupId: original.wakeupId,
      leaseToken: '2',
    });
    const before = await snapshot();
    await expect(process(original)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(await process(replacement)).toMatchObject({ state: 'completed' });
  });

  it('rolls back a claim whose lease expires while its success audit is flushed', async () => {
    await produce();
    const before = await snapshot();
    await fixture.owner.query(
      `CREATE FUNCTION crm_audit.log039_slow_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."resourceKind"='omniBindingConfigWakeup' AND NEW.outcome='success' THEN PERFORM pg_sleep(1.2); END IF; RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      'CREATE TRIGGER log039_slow_claim BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.log039_slow_claim()',
    );
    try {
      const startedAt = Date.now();
      await expect(claim(1, 1000)).rejects.toThrow(
        'OMNI_BINDING_CONFIG_WAKEUP_CLAIM_EXPIRED',
      );
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1100);
      expect(await snapshot()).toEqual(before);
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER log039_slow_claim ON crm_audit."crmAuditEntry"',
      );
      await fixture.owner.query('DROP FUNCTION crm_audit.log039_slow_claim()');
    }
  });

  it('reauthorizes every claim and every page instead of relying on the producer grant', async () => {
    await block();
    await produce();
    const before = await snapshot();
    await expect(
      claim(1, 300000, async () => {
        throw new Error('fixture denied wakeup claim');
      }),
    ).rejects.toThrow('fixture denied wakeup claim');
    expect(await snapshot()).toEqual(before);
    const claimed = await claimOne();
    const claimedState = await snapshot();
    await expect(
      process(claimed, 100, async () => {
        throw new Error('fixture revoked wakeup grant');
      }),
    ).rejects.toThrow('fixture revoked wakeup grant');
    expect(await snapshot()).toEqual(claimedState);
    await expect(
      process(claimed, 100, authorize, async () => {
        throw new Error('fixture revoked resume grant');
      }),
    ).rejects.toThrow('fixture revoked resume grant');
    expect(await snapshot()).toEqual(claimedState);
  });

  it.each(['inactive', 'unsupported'] as const)(
    'checkpoints %s configuration without waking receipts',
    async (kind) => {
      await block();
      await produce();
      const claimed = await claimOne();
      if (kind === 'inactive')
        await fixture.owner.query(
          'UPDATE core."omniAccountBinding" SET status=\'inactive\' WHERE id=$1',
          [context.bindingId],
        );
      else
        await fixture.owner.query(
          'UPDATE core."omniBindingConfigWakeup" SET "handlerVersion"=2 WHERE id=$1',
          [claimed.wakeupId],
        );
      expect(await process(claimed)).toMatchObject({
        state: 'blocked',
        resumedReceiptIds: [],
      });
      expect((await core('omniBindingConfigWakeup'))[0]).toMatchObject({
        state: 'blocked',
        leaseOwner: null,
        leaseUntil: null,
        errorCode:
          kind === 'inactive' ? 'binding_inactive' : 'unsupported_handler',
      });
      expect((await core('omniIncomingReceipt'))[0].state).toBe(
        'blocked_config',
      );
      await noSideEffects();
    },
  );

  it('resets a persisted cursor when binding route generation changes', async () => {
    await block(null);
    await produce();
    expect(await process(await claimOne(), 1)).toMatchObject({
      state: 'pending',
    });
    await fixture.owner.query(
      'UPDATE core."omniAccountBinding" SET "routeGeneration"=2 WHERE id=$1',
      [context.bindingId],
    );
    const claimed = await claimOne();
    expect(claimed.routeGeneration).toBe('2');
    expect(await process(claimed)).toMatchObject({
      state: 'completed',
      nextCursor: null,
    });
    expect((await core('omniBindingConfigWakeup'))[0]).toMatchObject({
      observedRouteGeneration: '2',
      cursorReceiptId: null,
      cursorNextAttemptAt: null,
    });
    expect((await core('omniIncomingReceipt'))[0].state).toBe('blocked_config');
  });

  it('rolls back receipt wakes and cursor checkpoint if the final wakeup update fails', async () => {
    await block();
    await produce();
    const claimed = await claimOne();
    const before = await snapshot();
    await fixture.owner.query(
      `CREATE FUNCTION core.log039_fail_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state <> 'running' THEN RAISE EXCEPTION 'fixture wakeup checkpoint failed'; END IF; RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      'CREATE TRIGGER log039_fail_checkpoint BEFORE UPDATE ON core."omniBindingConfigWakeup" FOR EACH ROW EXECUTE FUNCTION core.log039_fail_checkpoint()',
    );
    try {
      const outcome: unknown = await process(claimed).catch(
        (error: unknown) => error,
      );
      expect(errorMessages(outcome)).toContain(
        'fixture wakeup checkpoint failed',
      );
      expect(await snapshot()).toEqual(before);
      await noSideEffects();
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER log039_fail_checkpoint ON core."omniBindingConfigWakeup"',
      );
      await fixture.owner.query('DROP FUNCTION core.log039_fail_checkpoint()');
    }
  });

  it.each(['omniIncomingReceipt', 'omniBindingConfigWakeup'])(
    'rolls back receipt and work checkpoints when the lease expires during %s success audit',
    async (resourceKind) => {
      await block();
      await produce();
      const claimed = await claimOne();
      await fixture.owner.query(
        'UPDATE core."omniBindingConfigWakeup" SET "leaseUntil"=clock_timestamp()+interval \'750 milliseconds\' WHERE id=$1',
        [claimed.wakeupId],
      );
      const before = await snapshot();
      await fixture.owner.query(
        `CREATE FUNCTION crm_audit.log039_slow_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."resourceKind"='${resourceKind}' AND NEW.outcome='success' THEN PERFORM pg_sleep(1); END IF; RETURN NEW; END $$`,
      );
      await fixture.owner.query(
        'CREATE TRIGGER log039_slow_receipt BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.log039_slow_receipt()',
      );
      try {
        const startedAt = Date.now();
        await expect(process(claimed)).rejects.toThrow();
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
        expect(await snapshot()).toEqual(before);
      } finally {
        await fixture.owner.query(
          'DROP TRIGGER log039_slow_receipt ON crm_audit."crmAuditEntry"',
        );
        await fixture.owner.query(
          'DROP FUNCTION crm_audit.log039_slow_receipt()',
        );
      }
    },
  );

  it('does not report completion after actual COMMIT loses its acknowledgement and reconciles persisted completion', async () => {
    const captured = await block();
    await produce();
    const claimed = await claimOne();
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
      if (text === 'COMMIT') throw new Error('fixture wakeup lost COMMIT ACK');
      return result;
    }) as typeof client.query);
    jest
      .spyOn(fixture.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await expect(process(claimed)).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
    expect(statements).not.toContain('ROLLBACK');
    expect((await core('omniBindingConfigWakeup'))[0].state).toBe('completed');
    expect(
      (await core('omniIncomingReceipt')).find(
        (row) => row.id === captured.proof.receiptId,
      )?.state,
    ).toBe('retryable_error');
    const before = await snapshot();
    expect(await claim()).toEqual([]);
    await expect(process(claimed)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect((await audit()).every((row) => row.outcome === 'success')).toBe(
      true,
    );
  });

  it('backfills only missing work items from real durable events with bounded restartable pages', async () => {
    const produced = [await produce(), await produce(), await produce()];
    await fixture.owner.query('DELETE FROM core."omniBindingConfigWakeup"');
    for (const [index, event] of produced.entries())
      await fixture.owner.query(
        'UPDATE core."omniDomainEvent" SET "createdAt"=$1 WHERE id=$2',
        [`2026-10-01T12:00:00.12345${index}Z`, event.eventId],
      );
    let after: Parameters<typeof reconcileOmniBindingConfigWakeups>[2]['after'];
    const enqueued: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const page = await reconcile({ limit: 1, ...(after ? { after } : {}) });
      expect(page.scannedCount).toBe(1);
      expect(page.enqueuedIds).toHaveLength(1);
      enqueued.push(...page.enqueuedIds);
      expect(page.nextCursor).toEqual({
        createdAt: `2026-10-01T12:00:00.12345${index}Z`,
        id: produced[index].eventId,
      });
      after = page.nextCursor ?? undefined;
    }
    expect(new Set(enqueued).size).toBe(3);
    expect((await reconcile({ limit: 1, after })).scannedCount).toBe(0);
    const before = await snapshot();
    expect((await reconcile()).enqueuedIds).toEqual([]);
    expect(await snapshot()).toEqual(before);
    await noSideEffects();
  });

  it.each([
    'foreign-binding',
    'foreign-workspace',
    'malformed-current-binding',
  ] as const)(
    'does not backfill %s event data as current work',
    async (kind) => {
      const event = await produce();
      await fixture.owner.query('DELETE FROM core."omniBindingConfigWakeup"');
      if (kind === 'foreign-binding')
        await fixture.owner.query(
          'UPDATE core."omniDomainEvent" SET payload=jsonb_set(payload,\'{bindingId}\',to_jsonb($1::text)) WHERE id=$2',
          [randomUUID(), event.eventId],
        );
      if (kind === 'foreign-workspace') {
        const foreignWorkspace = randomUUID();
        await fixture.owner.query(
          'INSERT INTO core.workspace(id) VALUES ($1)',
          [foreignWorkspace],
        );
        await fixture.owner.query(
          'UPDATE core."omniDomainEvent" SET "workspaceId"=$1 WHERE id=$2',
          [foreignWorkspace, event.eventId],
        );
      }
      if (kind === 'malformed-current-binding')
        await fixture.owner.query(
          'UPDATE core."omniDomainEvent" SET payload=payload||\'{"unexpected":true}\'::jsonb WHERE id=$1',
          [event.eventId],
        );
      const before = await audit();
      const result = await reconcile({ limit: 1 });
      expect(result).toMatchObject({ enqueuedIds: [] });
      if (kind === 'malformed-current-binding')
        expect(result).toMatchObject({
          scannedCount: 1,
          invalidEventIds: [event.eventId],
          nextCursor: { id: event.eventId },
        });
      expect(await core('omniBindingConfigWakeup')).toEqual([]);
      expect(await audit()).toEqual(before);
    },
  );

  it('rearms completed work for housekeeping without replacing a current running lease', async () => {
    await produce();
    const first = await claimOne();
    expect(await process(first)).toMatchObject({ state: 'completed' });
    const captured = await block();
    expect(
      await run((scope) =>
        rearmOmniBindingConfigWakeup(
          scope,
          context.principal,
          first.wakeupId,
          authorize,
        ),
      ),
    ).toBe(true);
    const claimed = await claimOne();
    const before = await snapshot();
    expect(
      await run((scope) =>
        rearmOmniBindingConfigWakeup(
          scope,
          context.principal,
          first.wakeupId,
          authorize,
        ),
      ),
    ).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(await process(claimed)).toMatchObject({
      state: 'completed',
      resumedReceiptIds: [captured.proof.receiptId],
    });
    expect(await core('omniBindingConfigWakeup')).toHaveLength(1);
  });

  it('rolls back backfill when fresh authorization is denied', async () => {
    await produce();
    await fixture.owner.query('DELETE FROM core."omniBindingConfigWakeup"');
    const before = await snapshot();
    await expect(
      reconcile({ limit: 10 }, async () => {
        throw new Error('fixture denied reconciliation');
      }),
    ).rejects.toThrow('fixture denied reconciliation');
    expect(await snapshot()).toEqual(before);
  });

  it('rejects a claimed work item whose stored event no longer matches its binding', async () => {
    await block();
    const event = await produce();
    const claimed = await claimOne();
    await fixture.owner.query(
      'UPDATE core."omniDomainEvent" SET payload=jsonb_set(payload,\'{bindingId}\',to_jsonb($1::text)) WHERE id=$2',
      [randomUUID(), event.eventId],
    );
    const before = await snapshot();
    await expect(process(claimed)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it.each(['workspace', 'binding'] as const)(
    'refuses a foreign %s wakeup scope without mutation',
    async (kind) => {
      await produce();
      const before = await snapshot();
      const principal = {
        ...context.principal,
        ...(kind === 'workspace'
          ? { workspaceId: randomUUID() }
          : { bindingId: randomUUID() }),
      };
      await expect(
        run((scope) =>
          claimOmniBindingConfigWakeups(
            scope,
            principal,
            { leaseOwner: randomUUID(), limit: 1, leaseMilliseconds: 300000 },
            authorize,
          ),
        ),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );
});
