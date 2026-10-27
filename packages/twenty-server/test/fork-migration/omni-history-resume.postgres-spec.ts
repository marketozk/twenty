import { randomUUID } from 'node:crypto';

import { type PoolClient } from 'pg';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import {
  claimOmniIncomingReceipts,
  deferOmniIncomingReceipt,
} from 'src/modules/omnichannel/services/omni-incoming-receipt-lease';
import {
  type OmniBlockedHistoryResumeAuthorizer,
  type OmniBlockedHistoryResumeInput,
} from 'src/modules/omnichannel/services/resume-omni-blocked-history-receipts';
import { createOmniHistoryApplyFixture } from 'test/fork-migration/omni-history-apply.fixture';

jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock('src/modules/match-participant/match-participant.service', () => ({
  MatchParticipantService: class {},
}));
jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({
    IndexMetadataEntity: class {},
  }),
);
jest.mock(
  'src/engine/core-modules/message-queue/services/message-queue.service',
  () => ({
    MessageQueueService: class {},
  }),
);
jest.mock(
  'src/modules/contact-creation-manager/jobs/create-company-and-contact.job',
  () => ({
    CreateCompanyAndContactJob: class {},
  }),
);
jest.mock(
  'src/modules/messaging/message-import-manager/services/messaging-message-folder-association.service',
  () => ({
    MessagingMessageFolderAssociationService: class {},
  }),
);

const fixture = createOmniHistoryApplyFixture({ includeTargets: true });
let context: Awaited<ReturnType<typeof fixture.reset>>;
const core = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const receipt = async (id: string): Promise<Record<string, unknown>> => {
  const [row] = await fixture.owner.query(
    'SELECT * FROM core."omniIncomingReceipt" WHERE id=$1',
    [id],
  );
  return row;
};
const audit = (): Promise<Record<string, unknown>[]> =>
  fixture.owner.query('SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id');
const authorize: OmniBlockedHistoryResumeAuthorizer = async (
  scope,
  request,
) => {
  // Explicit fixture grant only; production caller must provide ROB-766 policy.
  expect(scope.workspaceId).toBe(fixture.workspaceId);
  expect(request).toMatchObject({
    workspaceId: fixture.workspaceId,
    bindingId: context.bindingId,
    action: 'history.resume',
    routeGeneration: '1',
    policyId: context.policyId,
    policyVersion: '0',
  });
};
const resume = (
  input: OmniBlockedHistoryResumeInput = { routeGeneration: '1', limit: 100 },
  authorization: OmniBlockedHistoryResumeAuthorizer = authorize,
) =>
  fixture.service.resumeOmniBlockedHistoryReceipts(
    context.principal,
    input,
    authorization,
  );
const block = async (
  changes: Record<string, unknown> = {},
  origin: 'history_import' | 'live' | null = 'history_import',
) => {
  const captured = await fixture.capture(
    context,
    {
      providerMessageId: randomUUID(),
      ...changes,
    },
    origin,
  );
  const { externalIdentityId: _externalIdentityId, ...proof } = captured.proof;
  await deferOmniIncomingReceipt(
    fixture.runtime,
    context.principal,
    proof,
    {
      state: 'blocked_config',
      errorCode: 'configuration_missing',
    },
    async () => undefined,
  );
  return captured;
};
const noMessageEffects = async () => {
  for (const table of [
    'omniMessageLink',
    'omniMessageRevision',
    'omniRootExecution',
    'omniDomainEvent',
    'omniEventDispatchPlan',
    'omniReplyBudget',
  ]) {
    expect(await core(table)).toEqual([]);
  }
  for (const table of [
    'message',
    'messageParticipant',
    'messageChannelMessageAssociation',
    'messageThreadTarget',
  ] as const) {
    expect(await fixture.read(table)).toEqual([]);
  }
  expect(fixture.eventEmitter).not.toHaveBeenCalled();
};

beforeAll(() => fixture.initialize());
beforeEach(async () => {
  context = await fixture.reset({ withoutConversation: true });
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('qualified blocked history configuration recovery', () => {
  it('repairs configuration, resumes the original receipt, claims a new lease and applies through the real facade', async () => {
    const captured = await fixture.capture(context);
    await fixture.owner.query(
      'UPDATE core."omniQueue" SET active=false WHERE id=$1',
      [context.queueId],
    );
    const historyAuthorize = fixture.authorizeFor(context, {
      allowNewConversation: true,
    });
    expect(
      await fixture.service.processOmniHistoryReceipt(
        context.principal,
        captured.proof,
        historyAuthorize,
        async () => undefined,
      ),
    ).toMatchObject({
      state: 'blocked_config',
      receiptId: captured.proof.receiptId,
    });
    const before = await receipt(captured.proof.receiptId);
    expect(await resume()).toMatchObject({
      scannedCount: 1,
      resumedReceiptIds: [],
    });
    expect(await receipt(captured.proof.receiptId)).toEqual(before);
    await fixture.owner.query(
      'UPDATE core."omniQueue" SET active=true WHERE id=$1',
      [context.queueId],
    );
    expect(await resume()).toEqual({
      scannedCount: 1,
      resumedReceiptIds: [before.id],
      nextCursor: null,
    });
    const after = await receipt(captured.proof.receiptId);
    expect(after).toMatchObject({
      state: 'retryable_error',
      errorCode: null,
      leaseOwner: null,
      leaseUntil: null,
      attempts: before.attempts,
      leaseToken: before.leaseToken,
      resultId: null,
    });
    for (const key of [
      'id',
      'eventId',
      'createdAt',
      'validatedEnvelope',
      'canonicalPayloadHash',
      'trustedCaptureContext',
      'trustedCaptureContextHash',
      'routeGeneration',
    ])
      expect(after[key]).toEqual(before[key]);
    await noMessageEffects();
    const claims = await claimOmniIncomingReceipts(
      fixture.runtime,
      context.principal,
      { leaseOwner: randomUUID(), limit: 1, leaseMilliseconds: 300000 },
      async () => undefined,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ receiptId: before.id, leaseToken: '2' });
    expect((await receipt(captured.proof.receiptId)).attempts).toBe(2);
    expect(
      await fixture.service.processOmniHistoryReceipt(
        context.principal,
        {
          receiptId: claims[0].receiptId,
          leaseOwner: claims[0].leaseOwner,
          leaseToken: claims[0].leaseToken,
          routeGeneration: claims[0].routeGeneration,
          externalIdentityId: context.externalIdentityId,
        },
        historyAuthorize,
        async () => undefined,
      ),
    ).toMatchObject({ state: 'applied', created: true });
    expect(await core('omniIncomingReceipt')).toHaveLength(1);
    expect(await fixture.read('message')).toHaveLength(1);
    expect(
      (await core('omniDomainEvent')).every(
        (row) => row.origin === 'history_import',
      ),
    ).toBe(true);
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });

  it.each(['assist', 'auto'])(
    'keeps first-chat receipts blocked while default mode is %s',
    async (mode) => {
      const captured = await block();
      await fixture.owner.query(
        'UPDATE core."omniAccountBinding" SET "defaultConversationMode"=$1 WHERE id=$2',
        [mode, context.bindingId],
      );
      const before = await receipt(captured.proof.receiptId);
      expect(await resume()).toMatchObject({
        scannedCount: 1,
        resumedReceiptIds: [],
      });
      expect(await receipt(captured.proof.receiptId)).toEqual(before);
      await noMessageEffects();
    },
  );

  it('uses an existing Conversation queue even when current binding defaults are unusable', async () => {
    context = await fixture.reset();
    const captured = await block();
    const invalidDefault = await fixture.coreInsert('omniQueue', {
      workspaceId: fixture.workspaceId,
      bindingId: context.bindingId,
      name: 'Inactive default',
      active: false,
    });
    await fixture.owner.query(
      'UPDATE core."omniAccountBinding" SET "defaultQueueId"=$1,"defaultConversationMode"=\'auto\' WHERE id=$2',
      [invalidDefault, context.bindingId],
    );
    const conversations = await core('omniConversation');
    const threads = await fixture.read('messageThread');
    expect(await resume()).toMatchObject({
      resumedReceiptIds: [captured.proof.receiptId],
    });
    expect(await core('omniConversation')).toEqual(conversations);
    expect(await fixture.read('messageThread')).toEqual(threads);
    await noMessageEffects();
  });

  it.each([
    'live',
    'legacy',
    'capture-hash',
    'envelope-hash',
    'outgoing',
    'placeholder',
  ] as const)(
    'leaves an ineligible %s receipt untouched and advances its cursor',
    async (kind) => {
      const captured = await block(
        kind === 'outgoing'
          ? { direction: 'outgoing' }
          : kind === 'placeholder'
            ? { sourceVariant: 'placeholder' }
            : {},
        kind === 'live' ? 'live' : kind === 'legacy' ? null : 'history_import',
      );
      if (kind === 'capture-hash' || kind === 'envelope-hash') {
        const column =
          kind === 'capture-hash'
            ? 'trustedCaptureContextHash'
            : 'canonicalPayloadHash';
        await fixture.owner.query(
          `UPDATE core."omniIncomingReceipt" SET "${column}"=$1 WHERE id=$2`,
          ['0'.repeat(64), captured.proof.receiptId],
        );
      }
      const before = await receipt(captured.proof.receiptId);
      const result = await resume({ routeGeneration: '1', limit: 1 });
      expect(result).toMatchObject({
        scannedCount: 1,
        resumedReceiptIds: [],
        nextCursor: { id: before.id },
      });
      expect(await receipt(captured.proof.receiptId)).toEqual(before);
      await noMessageEffects();
    },
  );

  it('advances across a full ineligible page to an eligible later receipt without starvation', async () => {
    const first = await block({}, null);
    const second = await block({}, 'live');
    const third = await block();
    for (const [index, captured] of [first, second, third].entries()) {
      await fixture.owner.query(
        'UPDATE core."omniIncomingReceipt" SET "nextAttemptAt"=$1 WHERE id=$2',
        [`2026-10-01T00:00:0${index}.000000Z`, captured.proof.receiptId],
      );
    }
    const page = await resume({ routeGeneration: '1', limit: 2 });
    expect(page).toMatchObject({
      scannedCount: 2,
      resumedReceiptIds: [],
      nextCursor: { id: second.proof.receiptId },
    });
    if (!page.nextCursor) throw new Error('Expected a full-page cursor');
    expect(
      await resume({ routeGeneration: '1', limit: 2, after: page.nextCursor }),
    ).toEqual({
      scannedCount: 1,
      resumedReceiptIds: [third.proof.receiptId],
      nextCursor: null,
    });
    expect((await receipt(first.proof.receiptId)).state).toBe('blocked_config');
    expect((await receipt(second.proof.receiptId)).state).toBe(
      'blocked_config',
    );
  });

  it('preserves microseconds across page cursors even when UUID ordering opposes timestamp ordering', async () => {
    const captured = [await block(), await block(), await block()];
    const ordered = captured.sort((a, b) =>
      b.proof.receiptId.localeCompare(a.proof.receiptId),
    );
    const timestamps = [
      '2026-10-01T12:00:00.123456Z',
      '2026-10-01T12:00:00.123457Z',
      '2026-10-01T12:00:00.123458Z',
    ];
    for (const [index, row] of ordered.entries())
      await fixture.owner.query(
        'UPDATE core."omniIncomingReceipt" SET "nextAttemptAt"=$1 WHERE id=$2',
        [timestamps[index], row.proof.receiptId],
      );
    let after: OmniBlockedHistoryResumeInput['after'];
    for (const [index, row] of ordered.entries()) {
      const page = await resume({
        routeGeneration: '1',
        limit: 1,
        ...(after ? { after } : {}),
      });
      expect(page).toEqual({
        scannedCount: 1,
        resumedReceiptIds: [row.proof.receiptId],
        nextCursor: {
          nextAttemptAt: timestamps[index],
          id: row.proof.receiptId,
        },
      });
      after = page.nextCursor ?? undefined;
    }
    expect(await resume({ routeGeneration: '1', limit: 1, after })).toEqual({
      scannedCount: 0,
      resumedReceiptIds: [],
      nextCursor: null,
    });
  });

  it('skips a locked earlier receipt, advances the full-page cursor, and recovers it on a fresh scan', async () => {
    const early = await block();
    const later = await block();
    await fixture.owner.query(
      'UPDATE core."omniIncomingReceipt" SET "nextAttemptAt"=\'2026-10-01T00:00:00Z\' WHERE id=$1',
      [early.proof.receiptId],
    );
    await fixture.owner.query(
      'UPDATE core."omniIncomingReceipt" SET "nextAttemptAt"=\'2026-10-02T00:00:00Z\' WHERE id=$1',
      [later.proof.receiptId],
    );
    const holder = fixture.owner.createQueryRunner();
    try {
      await holder.connect();
      await holder.startTransaction();
      await holder.query(
        'SELECT id FROM core."omniIncomingReceipt" WHERE id=$1 FOR UPDATE',
        [early.proof.receiptId],
      );
      const page = await resume({ routeGeneration: '1', limit: 1 });
      expect(page).toMatchObject({
        scannedCount: 1,
        resumedReceiptIds: [],
        nextCursor: { id: early.proof.receiptId },
      });
      if (!page.nextCursor) throw new Error('Expected cursor');
      expect(
        (
          await resume({
            routeGeneration: '1',
            limit: 1,
            after: page.nextCursor,
          })
        ).resumedReceiptIds,
      ).toEqual([later.proof.receiptId]);
      await holder.commitTransaction();
      expect((await resume()).resumedReceiptIds).toEqual([
        early.proof.receiptId,
      ]);
    } finally {
      if (holder.isTransactionActive) await holder.rollbackTransaction();
      await holder.release();
    }
  });

  it('allows concurrent scans and repeated scans without duplicate transitions or success audits', async () => {
    const first = await block();
    const second = await block();
    const before = await audit();
    const results = await Promise.all([resume(), resume()]);
    expect(
      results.flatMap((result) => result.resumedReceiptIds).sort(),
    ).toEqual([first.proof.receiptId, second.proof.receiptId].sort());
    const added = (await audit()).filter(
      (row) => !before.some((old) => old.id === row.id),
    );
    expect(added).toHaveLength(2);
    expect(
      added.every(
        (row) =>
          row.outcome === 'success' &&
          row.resourceKind === 'omniIncomingReceipt',
      ),
    ).toBe(true);
    const persisted = await audit();
    expect(await resume()).toEqual({
      scannedCount: 0,
      resumedReceiptIds: [],
      nextCursor: null,
    });
    expect(await audit()).toEqual(persisted);
    await noMessageEffects();
  });

  it('does not wake a receipt another worker already resumed and claimed', async () => {
    const captured = await block();
    const result = await resume(undefined, async (scope, request) => {
      await authorize(scope, request);
      await resume();
      const claims = await claimOmniIncomingReceipts(
        fixture.runtime,
        context.principal,
        { leaseOwner: randomUUID(), limit: 1, leaseMilliseconds: 300000 },
        async () => undefined,
      );
      expect(claims[0].receiptId).toBe(captured.proof.receiptId);
    });
    expect(result.resumedReceiptIds).toEqual([]);
    expect(await receipt(captured.proof.receiptId)).toMatchObject({
      state: 'processing',
      leaseToken: '2',
      attempts: 2,
    });
  });

  it('rolls back the complete batch on fresh authorization denial and records a separate denied attempt', async () => {
    const captured = await block();
    const before = await receipt(captured.proof.receiptId);
    const previousAudit = await audit();
    await expect(
      resume(undefined, async () => {
        throw new Error('fixture resume denied');
      }),
    ).rejects.toThrow('fixture resume denied');
    expect(await receipt(captured.proof.receiptId)).toEqual(before);
    expect(
      (await audit()).filter(
        (row) => !previousAudit.some((old) => old.id === row.id),
      ),
    ).toEqual([
      expect.objectContaining({
        outcome: 'denied',
        resourceKind: 'omniAccountBinding',
        resourceId: context.bindingId,
      }),
    ]);
  });

  it('rolls back every receipt transition when success audit insertion fails', async () => {
    await block();
    await block();
    const receipts = await core('omniIncomingReceipt');
    const previousAudit = await audit();
    await fixture.owner.query(
      `CREATE FUNCTION crm_audit.log037_fail_success() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.outcome='success' THEN RAISE EXCEPTION 'fixture resume audit failure'; END IF; RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      'CREATE TRIGGER log037_fail_success BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.log037_fail_success()',
    );
    try {
      const failure: unknown = await resume().catch((error: unknown) => error);
      expect(failure).toMatchObject({ message: 'Data validation error.' });
      const causes: string[] = [];
      let current = failure;
      while (current instanceof Error && causes.length < 10) {
        causes.push(current.message);
        current = current.cause;
      }
      expect(causes).toContain('fixture resume audit failure');
      expect(await core('omniIncomingReceipt')).toEqual(receipts);
      expect(
        (await audit()).filter(
          (row) => !previousAudit.some((old) => old.id === row.id),
        ),
      ).toEqual([
        expect.objectContaining({
          outcome: 'failed',
          resourceKind: 'omniAccountBinding',
        }),
      ]);
      await noMessageEffects();
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER log037_fail_success ON crm_audit."crmAuditEntry"',
      );
      await fixture.owner.query(
        'DROP FUNCTION crm_audit.log037_fail_success()',
      );
    }
  });

  it('surfaces an actual lost COMMIT acknowledgement without false failure audit or duplicate wake', async () => {
    const captured = await block();
    const beforeAudit = await audit();
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
      if (text === 'COMMIT') throw new Error('fixture resume lost COMMIT ACK');
      return result;
    }) as typeof client.query);
    jest
      .spyOn(fixture.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await expect(resume()).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
    expect(statements).not.toContain('ROLLBACK');
    expect(await receipt(captured.proof.receiptId)).toMatchObject({
      state: 'retryable_error',
      leaseToken: '1',
      attempts: 1,
    });
    const added = (await audit()).filter(
      (row) => !beforeAudit.some((old) => old.id === row.id),
    );
    expect(added).toEqual([expect.objectContaining({ outcome: 'success' })]);
    const durableAudit = await audit();
    expect((await resume()).resumedReceiptIds).toEqual([]);
    expect(await audit()).toEqual(durableAudit);
    const claims = await claimOmniIncomingReceipts(
      fixture.runtime,
      context.principal,
      { leaseOwner: randomUUID(), limit: 1, leaseMilliseconds: 300000 },
      async () => undefined,
    );
    expect(claims[0]).toMatchObject({
      receiptId: captured.proof.receiptId,
      leaseToken: '2',
    });
  });

  it.each([
    'inactive-binding',
    'generation',
    'policy',
    'application-account',
  ] as const)(
    'refuses the batch when current global configuration is invalid: %s',
    async (kind) => {
      const captured = await block();
      if (kind === 'inactive-binding')
        await fixture.owner.query(
          'UPDATE core."omniAccountBinding" SET status=\'inactive\' WHERE id=$1',
          [context.bindingId],
        );
      if (kind === 'generation')
        await fixture.owner.query(
          'UPDATE core."omniAccountBinding" SET "routeGeneration"=2 WHERE id=$1',
          [context.bindingId],
        );
      if (kind === 'policy')
        await fixture.owner.query(
          'UPDATE core."omniAutomationPolicyVersion" SET "settingsHash"=$1 WHERE "policyId"=$2',
          ['0'.repeat(64), context.policyId],
        );
      if (kind === 'application-account')
        await fixture.owner.query(
          'UPDATE core."connectedAccount" SET "applicationId"=$1 WHERE id=$2',
          [randomUUID(), context.connectedAccountId],
        );
      const before = await receipt(captured.proof.receiptId);
      await expect(resume()).rejects.toThrow();
      expect(await receipt(captured.proof.receiptId)).toEqual(before);
      await noMessageEffects();
    },
  );

  it.each([
    'different-error',
    'result-present',
    'lease-present',
    'different-generation',
    'quarantined',
  ] as const)(
    'excludes rows outside the blocked configuration lease contract: %s',
    async (kind) => {
      const captured = await block();
      const id = captured.proof.receiptId;
      if (kind === 'different-error')
        await fixture.owner.query(
          'UPDATE core."omniIncomingReceipt" SET "errorCode"=\'transient_failure\' WHERE id=$1',
          [id],
        );
      if (kind === 'result-present')
        await fixture.owner.query(
          'UPDATE core."omniIncomingReceipt" SET "resultId"=$1 WHERE id=$2',
          [randomUUID(), id],
        );
      if (kind === 'lease-present')
        await fixture.owner.query(
          'UPDATE core."omniIncomingReceipt" SET "leaseOwner"=\'another-worker\',"leaseUntil"=clock_timestamp()+interval \'5 minutes\' WHERE id=$1',
          [id],
        );
      if (kind === 'different-generation')
        await fixture.owner.query(
          'UPDATE core."omniIncomingReceipt" SET "routeGeneration"=2 WHERE id=$1',
          [id],
        );
      if (kind === 'quarantined')
        await fixture.owner.query(
          'UPDATE core."omniIncomingReceipt" SET state=\'quarantined\' WHERE id=$1',
          [id],
        );
      const before = await receipt(id);
      const beforeAudit = await audit();
      expect(await resume()).toEqual({
        scannedCount: 0,
        resumedReceiptIds: [],
        nextCursor: null,
      });
      expect(await receipt(id)).toEqual(before);
      expect(await audit()).toEqual(beforeAudit);
    },
  );

  it('waits for the policy writer and evaluates the committed configuration before resuming', async () => {
    const captured = await block();
    const writer = fixture.owner.createQueryRunner();
    let client: PoolClient | undefined;
    let handedToRuntime = false;
    let pendingOutcome: Promise<unknown> | undefined;
    try {
      await writer.connect();
      await writer.startTransaction();
      const [writerSession]: { pid: number }[] = await writer.query(
        'SELECT pg_backend_pid() AS pid',
      );
      await writer.query(
        'SELECT id FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1 FOR UPDATE',
        [fixture.workspaceId],
      );
      client = await fixture.pool.connect();
      const acquired = client;
      const nativeSession = await acquired.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      const query = acquired.query.bind(acquired);
      let notifyStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      jest.spyOn(acquired, 'query').mockImplementation((async (
        sql: string | { text: string; values?: unknown[] },
        values?: unknown[],
      ) => {
        const text = typeof sql === 'string' ? sql : sql.text;
        if (text.includes('omniWorkspacePolicyState')) notifyStarted();
        return query(sql, values);
      }) as typeof acquired.query);
      jest.spyOn(fixture.pool, 'connect').mockImplementationOnce(() => {
        handedToRuntime = true;
        return Promise.resolve(acquired);
      });
      const outcome = resume().then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      pendingOutcome = outcome;
      await Promise.race([
        started,
        outcome.then((settled) => {
          throw new Error('Resume settled before the policy-lock barrier', {
            cause: settled,
          });
        }),
      ]);
      let blocked = false;
      const deadline = Date.now() + 2000;
      while (!blocked && Date.now() < deadline) {
        const [state]: { blocked: boolean }[] = await fixture.owner.query(
          'SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked',
          [writerSession.pid, nativeSession.rows[0].pid],
        );
        blocked = state.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      await writer.query(
        'UPDATE core."omniAccountBinding" SET "defaultConversationMode"=\'assist\' WHERE id=$1',
        [context.bindingId],
      );
      await writer.commitTransaction();
      expect(await outcome).toMatchObject({
        result: { scannedCount: 1, resumedReceiptIds: [] },
      });
      expect((await receipt(captured.proof.receiptId)).state).toBe(
        'blocked_config',
      );
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await writer.release();
      if (client && !handedToRuntime) client.release();
      await pendingOutcome;
    }
  });

  it.each(['workspace', 'binding'] as const)(
    'rejects a foreign %s principal without exposing or auditing this binding',
    async (kind) => {
      await block();
      const before = await core('omniIncomingReceipt');
      const beforeAudit = await audit();
      const principal = {
        ...context.principal,
        ...(kind === 'workspace'
          ? { workspaceId: randomUUID() }
          : { bindingId: randomUUID() }),
      };
      const unexpectedAuthorization = jest.fn(async () => undefined);
      await expect(
        fixture.service.resumeOmniBlockedHistoryReceipts(
          principal,
          { routeGeneration: '1', limit: 10 },
          unexpectedAuthorization,
        ),
      ).rejects.toThrow();
      expect(unexpectedAuthorization).not.toHaveBeenCalled();
      expect(await core('omniIncomingReceipt')).toEqual(before);
      expect(await audit()).toEqual(beforeAudit);
    },
  );

  it.each<OmniBlockedHistoryResumeInput>([
    { routeGeneration: '1', limit: 0 },
    { routeGeneration: '1', limit: 101 },
    { routeGeneration: '1', limit: 1.5 },
    { routeGeneration: '0', limit: 1 },
    {
      routeGeneration: '1',
      limit: 1,
      after: { nextAttemptAt: 'invalid', id: randomUUID() },
    },
    {
      routeGeneration: '1',
      limit: 1,
      after: { nextAttemptAt: '2026-10-01T00:00:00.123Z', id: randomUUID() },
    },
    {
      routeGeneration: '1',
      limit: 1,
      after: { nextAttemptAt: '2026-10-01T00:00:00.123456Z', id: 'invalid' },
    },
  ])(
    'rejects invalid batch input before a transaction or audit: %j',
    async (input) => {
      await block();
      const before = await core('omniIncomingReceipt');
      const beforeAudit = await audit();
      const transaction = jest.spyOn(
        fixture.manager,
        'runInWorkspaceTransaction',
      );
      await expect(resume(input)).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
      expect(await core('omniIncomingReceipt')).toEqual(before);
      expect(await audit()).toEqual(beforeAudit);
    },
  );
});
