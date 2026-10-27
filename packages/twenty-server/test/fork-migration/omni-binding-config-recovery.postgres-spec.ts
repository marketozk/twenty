import { randomUUID } from 'node:crypto';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { mutateOmniBindingConfiguration } from 'src/modules/omnichannel/services/mutate-omni-binding-configuration';
import {
  type OmniBindingConfigWakeupAuthorizer,
  type OmniBindingConfigWakeupClaim,
} from 'src/modules/omnichannel/services/omni-binding-config-wakeup';
import {
  claimOmniIncomingReceipts,
  deferOmniIncomingReceipt,
} from 'src/modules/omnichannel/services/omni-incoming-receipt-lease';
import { type OmniBlockedHistoryResumeAuthorizer } from 'src/modules/omnichannel/services/resume-omni-blocked-history-receipts';
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
type Command = Parameters<
  typeof fixture.service.executeOmniBindingConfigRecovery
>[1];
const core = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const audit = (): Promise<Record<string, unknown>[]> =>
  fixture.owner.query('SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id');
const state = async () => ({
  receipts: await core('omniIncomingReceipt'),
  wakeups: await core('omniBindingConfigWakeup'),
});
const authorize: OmniBindingConfigWakeupAuthorizer = async (scope, request) => {
  // Synthetic explicit current grant; this does not enable production activation or ROB-766 ACL.
  expect(scope.workspaceId).toBe(fixture.workspaceId);
  expect(request.workspaceId).toBe(fixture.workspaceId);
  expect(request.bindingId).toBe(context.bindingId);
};
const authorizeResume: OmniBlockedHistoryResumeAuthorizer = async (
  scope,
  request,
) => {
  expect(scope.workspaceId).toBe(fixture.workspaceId);
  expect(request).toMatchObject({
    action: 'history.resume',
    bindingId: context.bindingId,
    policyId: context.policyId,
  });
};
const execute = (
  command: Command,
  grant = authorize,
  resumeGrant?: OmniBlockedHistoryResumeAuthorizer,
) =>
  fixture.service.executeOmniBindingConfigRecovery(
    context.principal,
    command,
    grant,
    resumeGrant,
  );
const claim = async (limit = 1) => {
  const response = await execute({
    operation: 'claim',
    input: { leaseOwner: randomUUID(), limit, leaseMilliseconds: 300000 },
  });
  if (response.operation !== 'claim')
    throw new Error('Unexpected claim response');
  return response.result;
};
const claimOne = async () => {
  const claims = await claim();
  if (claims.length !== 1) throw new Error('Expected one wakeup claim');
  return claims[0];
};
const processCommand = (claimed: OmniBindingConfigWakeupClaim): Command => ({
  operation: 'process',
  proof: {
    wakeupId: claimed.wakeupId,
    leaseOwner: claimed.leaseOwner,
    leaseToken: claimed.leaseToken,
  },
  input: { limit: 100 },
});
const process = async (claimed: OmniBindingConfigWakeupClaim) => {
  const response = await execute(
    processCommand(claimed),
    authorize,
    authorizeResume,
  );
  if (response.operation !== 'process')
    throw new Error('Unexpected process response');
  return response.result;
};
const housekeeping = async (grant = authorize) => {
  const response = await execute({ operation: 'housekeeping' }, grant);
  if (response.operation !== 'housekeeping')
    throw new Error('Unexpected housekeeping response');
  return response.result;
};
const produce = () =>
  mutateOmniBindingConfiguration(
    fixture.runtime,
    { workspaceId: fixture.workspaceId, actor: context.principal.actor },
    {
      action: 'queue.create',
      bindingId: context.bindingId,
      expectedRevision: '0',
      idempotencyKey: randomUUID(),
      name: randomUUID(),
    },
    async () => undefined,
  );
const repair = () =>
  mutateOmniBindingConfiguration(
    fixture.runtime,
    { workspaceId: fixture.workspaceId, actor: context.principal.actor },
    {
      action: 'queue.update',
      bindingId: context.bindingId,
      queueId: context.queueId,
      expectedRevision: '1',
      idempotencyKey: randomUUID(),
      active: true,
    },
    async () => undefined,
  );
const block = async () => {
  const captured = await fixture.capture(context, {
    providerMessageId: randomUUID(),
  });
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
const finishIncoming = async (receiptId: string) => {
  const [claim] = await claimOmniIncomingReceipts(
    fixture.runtime,
    context.principal,
    { leaseOwner: randomUUID(), limit: 1, leaseMilliseconds: 300000 },
    async () => undefined,
  );
  expect(claim.receiptId).toBe(receiptId);
  expect(claim.leaseToken).toBe('2');
  const result = await fixture.service.processOmniHistoryReceipt(
    context.principal,
    {
      receiptId: claim.receiptId,
      leaseOwner: claim.leaseOwner,
      leaseToken: claim.leaseToken,
      routeGeneration: claim.routeGeneration,
      externalIdentityId: context.externalIdentityId,
    },
    fixture.authorizeFor(context, { allowNewConversation: true }),
    async () => undefined,
  );
  expect(result.state).toBe('applied');
  if (result.state !== 'applied') throw new Error('Expected applied history');
  expect(await fixture.read('message')).toEqual([
    expect.objectContaining({ id: result.messageId }),
  ]);
  expect(await fixture.read('messageParticipant')).toEqual([
    expect.objectContaining({
      messageId: result.messageId,
      personId: context.personId,
    }),
  ]);
  expect(await fixture.read('person')).toEqual([
    expect.objectContaining({ id: context.personId }),
  ]);
  expect(await core('omniIncomingReceipt')).toEqual([
    expect.objectContaining({
      id: receiptId,
      state: 'applied',
      attempts: 2,
      leaseToken: '2',
    }),
  ]);
  expect(await core('omniRootExecution')).toHaveLength(2);
  expect(await core('omniEventDispatchPlan')).toHaveLength(2);
  expect(
    (await core('omniRootExecution')).every(
      (row) => row.state === 'suppressed' && row.origin === 'history_import',
    ),
  ).toBe(true);
  expect(
    (await core('omniEventDispatchPlan')).every(
      (row) =>
        row.state === 'suppressed' &&
        Array.isArray(row.targets) &&
        row.targets.length === 0,
    ),
  ).toBe(true);
  for (const table of [
    'omniAutomationAdmission',
    'omniOutgoingCommand',
    'omniConversationTarget',
  ])
    expect(await core(table)).toEqual([]);
  expect(await fixture.read('messageThreadTarget')).toEqual([]);
  expect(fixture.eventEmitter).not.toHaveBeenCalled();
};
const noNativeWrites = async () => {
  expect(await fixture.read('message')).toEqual([]);
  expect(await fixture.read('messageParticipant')).toEqual([]);
  expect(await core('omniOutgoingCommand')).toEqual([]);
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

describe('owned configuration recovery transactions', () => {
  it('carries accepted history through blocked configuration, actual repair and owner recovery into native Message and Person', async () => {
    const captured = await fixture.capture(context);
    await fixture.owner.query(
      'UPDATE core."omniQueue" SET active=false WHERE id=$1',
      [context.queueId],
    );
    expect(
      await fixture.service.processOmniHistoryReceipt(
        context.principal,
        captured.proof,
        fixture.authorizeFor(context, { allowNewConversation: true }),
        async () => undefined,
      ),
    ).toMatchObject({
      receiptId: captured.proof.receiptId,
      state: 'blocked_config',
    });
    await noNativeWrites();
    const repaired = await repair();
    const claimed = await claimOne();
    expect(claimed.eventId).toBe(repaired.eventId);
    expect(await process(claimed)).toMatchObject({
      state: 'completed',
      resumedReceiptIds: [captured.proof.receiptId],
    });
    await finishIncoming(captured.proof.receiptId);
  });

  it('recovers a real defer that commits after the configuration event was already completed', async () => {
    const captured = await fixture.capture(context);
    await fixture.owner.query(
      'UPDATE core."omniQueue" SET active=false WHERE id=$1',
      [context.queueId],
    );
    const deferredRunner = fixture.runtime.createQueryRunner();
    const connect = deferredRunner.connect.bind(deferredRunner);
    let notifyDeferred: () => void = () => undefined;
    const deferredStarted = new Promise<void>((resolve) => {
      notifyDeferred = resolve;
    });
    let releaseDeferred: () => void = () => undefined;
    const permitted = new Promise<void>((resolve) => {
      releaseDeferred = resolve;
    });
    jest.spyOn(deferredRunner, 'connect').mockImplementationOnce(async () => {
      notifyDeferred();
      await permitted;
      return connect();
    });
    jest
      .spyOn(fixture.runtime, 'createQueryRunner')
      .mockReturnValueOnce(deferredRunner);
    const pending = fixture.service
      .processOmniHistoryReceipt(
        context.principal,
        captured.proof,
        fixture.authorizeFor(context, { allowNewConversation: true }),
        async () => undefined,
      )
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    try {
      await Promise.race([
        deferredStarted,
        pending.then((settled) => {
          throw new Error(
            'History processing settled before the deferred-connection barrier',
            { cause: settled },
          );
        }),
      ]);
      const repaired = await repair();
      const claimed = await claimOne();
      expect(claimed.eventId).toBe(repaired.eventId);
      expect(await process(claimed)).toMatchObject({
        state: 'completed',
        resumedReceiptIds: [],
      });
      expect((await core('omniIncomingReceipt'))[0].state).toBe('processing');
      releaseDeferred();
      expect(await pending).toMatchObject({
        result: { state: 'blocked_config' },
      });
      expect((await core('omniBindingConfigWakeup'))[0].state).toBe(
        'completed',
      );
      expect(await housekeeping()).toMatchObject({
        rearmed: true,
        wakeupId: claimed.wakeupId,
        reason: 'rearmed',
      });
      const rearmed = await claimOne();
      expect(rearmed.leaseToken).toBe('2');
      expect(await process(rearmed)).toMatchObject({
        state: 'completed',
        resumedReceiptIds: [captured.proof.receiptId],
      });
      await finishIncoming(captured.proof.receiptId);
    } finally {
      releaseDeferred();
      await pending;
      if (!deferredRunner.isReleased) await deferredRunner.release();
    }
  });

  it('chooses the latest original event even when an older event was backfilled more recently', async () => {
    const older = await produce();
    const newer = await produce();
    for (const claimed of await claim(100)) await process(claimed);
    await fixture.owner.query(
      'UPDATE core."omniDomainEvent" SET "createdAt"=$1 WHERE id=$2',
      ['2026-10-01T00:00:00Z', older.eventId],
    );
    await fixture.owner.query(
      'UPDATE core."omniDomainEvent" SET "createdAt"=$1 WHERE id=$2',
      ['2026-10-02T00:00:00Z', newer.eventId],
    );
    await fixture.owner.query(
      'DELETE FROM core."omniBindingConfigWakeup" WHERE "eventId"=$1',
      [older.eventId],
    );
    const rebuilt = await execute({
      operation: 'reconcile',
      input: { limit: 100 },
    });
    expect(rebuilt.operation).toBe('reconcile');
    await process(await claimOne());
    await block();
    const before = await core('omniBindingConfigWakeup');
    const latest = before.find((row) => row.eventId === newer.eventId);
    const old = before.find((row) => row.eventId === older.eventId);
    if (!latest || !old) throw new Error('Expected both completed wakeups');
    expect(new Date(String(old.createdAt)).getTime()).toBeGreaterThanOrEqual(
      new Date(String(latest.createdAt)).getTime(),
    );
    expect(await housekeeping()).toEqual({
      rearmed: true,
      wakeupId: latest.id,
      reason: 'rearmed',
    });
    expect(
      (await core('omniBindingConfigWakeup')).find((row) => row.id === old.id),
    ).toEqual(old);
    expect(
      (await core('omniBindingConfigWakeup')).find(
        (row) => row.id === latest.id,
      )?.state,
    ).toBe('pending');
    await noNativeWrites();
  });

  it.each(['pending', 'running'] as const)(
    'does not rearm old work while supported %s work exists',
    async (phase) => {
      await produce();
      await process(await claimOne());
      await block();
      await produce();
      if (phase === 'running') await claimOne();
      const before = await state();
      const beforeAudit = await audit();
      expect(await housekeeping()).toEqual({
        rearmed: false,
        wakeupId: null,
        reason: 'unfinished_work',
      });
      expect(await state()).toEqual(before);
      expect(await audit()).toEqual(beforeAudit);
    },
  );

  it('does not rearm when only an old generation has blocked receipts', async () => {
    await produce();
    await process(await claimOne());
    await block();
    await fixture.owner.query(
      'UPDATE core."omniAccountBinding" SET "routeGeneration"=2 WHERE id=$1',
      [context.bindingId],
    );
    const before = await state();
    const beforeAudit = await audit();
    expect(await housekeeping()).toEqual({
      rearmed: false,
      wakeupId: null,
      reason: 'no_blocked_receipts',
    });
    expect(await state()).toEqual(before);
    expect(await audit()).toEqual(beforeAudit);
  });

  it('does not automatically activate an inactive binding during housekeeping', async () => {
    await produce();
    await process(await claimOne());
    await block();
    await fixture.owner.query(
      'UPDATE core."omniAccountBinding" SET status=\'inactive\' WHERE id=$1',
      [context.bindingId],
    );
    const before = await state();
    expect(await housekeeping()).toEqual({
      rearmed: false,
      wakeupId: null,
      reason: 'binding_inactive',
    });
    expect(await state()).toEqual(before);
    expect((await core('omniAccountBinding'))[0].status).toBe('inactive');
  });

  it('requires the separate rearm grant after housekeeping authorization', async () => {
    await produce();
    await process(await claimOne());
    await block();
    const before = await state();
    const previousAudit = await audit();
    const actions: string[] = [];
    await expect(
      housekeeping(async (scope, request) => {
        await authorize(scope, request);
        actions.push(request.action);
        if (request.action === 'config_wakeup.rearm')
          throw new Error('fixture rearm grant denied');
      }),
    ).rejects.toThrow('fixture rearm grant denied');
    expect(actions).toEqual([
      'config_wakeup.housekeeping',
      'config_wakeup.rearm',
    ]);
    expect(await state()).toEqual(before);
    expect(
      (await audit()).filter(
        (row) => !previousAudit.some((old) => old.id === row.id),
      ),
    ).toEqual([
      expect.objectContaining({
        outcome: 'denied',
        resourceId: context.bindingId,
        reasonCode: 'config_wakeup.housekeeping.denied',
      }),
    ]);
  });

  it.each(['claim', 'process', 'resume', 'housekeeping'] as const)(
    'records a separate denied attempt for a revoked %s grant after confirmed rollback',
    async (phase) => {
      await block();
      await produce();
      const claimed =
        phase === 'process' || phase === 'resume'
          ? await claimOne()
          : undefined;
      const before = await state();
      const previousAudit = await audit();
      const denied = async () => {
        throw new Error('fixture recovery authorization revoked');
      };
      let pending: Promise<unknown>;
      if (phase === 'claim')
        pending = execute(
          {
            operation: 'claim',
            input: {
              leaseOwner: randomUUID(),
              limit: 1,
              leaseMilliseconds: 300000,
            },
          },
          denied,
        );
      else if (phase === 'housekeeping') pending = housekeeping(denied);
      else {
        if (!claimed) throw new Error('Expected claimed work');
        pending = execute(
          processCommand(claimed),
          phase === 'process' ? denied : authorize,
          phase === 'resume' ? denied : authorizeResume,
        );
      }
      await expect(pending).rejects.toThrow(
        'fixture recovery authorization revoked',
      );
      expect(await state()).toEqual(before);
      expect(
        (await audit()).filter(
          (row) => !previousAudit.some((old) => old.id === row.id),
        ),
      ).toEqual([
        expect.objectContaining({
          outcome: 'denied',
          resourceKind: 'omniAccountBinding',
          resourceId: context.bindingId,
          reasonCode: `config_wakeup.${phase === 'resume' ? 'process' : phase}.denied`,
          securityDescriptor: {
            resourceKind: 'omniAccountBinding',
            resourceId: context.bindingId,
            bindingId: context.bindingId,
          },
        }),
      ]);
      await noNativeWrites();
    },
  );

  it('rolls back receipt and checkpoint writes and records a failed attempt if the final checkpoint fails', async () => {
    await block();
    await produce();
    const claimed = await claimOne();
    const before = await state();
    const previousAudit = await audit();
    await fixture.owner.query(
      `CREATE FUNCTION core.log040_fail_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state<>'running' THEN RAISE EXCEPTION 'fixture owned checkpoint failure'; END IF; RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      'CREATE TRIGGER log040_fail_checkpoint BEFORE UPDATE ON core."omniBindingConfigWakeup" FOR EACH ROW EXECUTE FUNCTION core.log040_fail_checkpoint()',
    );
    try {
      const error: unknown = await process(claimed).catch(
        (failure: unknown) => failure,
      );
      expect(errorMessages(error)).toContain(
        'fixture owned checkpoint failure',
      );
      expect(await state()).toEqual(before);
      expect(
        (await audit()).filter(
          (row) => !previousAudit.some((old) => old.id === row.id),
        ),
      ).toEqual([
        expect.objectContaining({
          outcome: 'failed',
          resourceKind: 'omniAccountBinding',
          resourceId: context.bindingId,
          reasonCode: 'config_wakeup.process.failed',
        }),
      ]);
      await noNativeWrites();
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER log040_fail_checkpoint ON core."omniBindingConfigWakeup"',
      );
      await fixture.owner.query('DROP FUNCTION core.log040_fail_checkpoint()');
    }
  });

  it('keeps actual COMMIT acknowledgement loss unknown and does not write a false failed attempt', async () => {
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
      if (text === 'COMMIT')
        throw new Error('fixture recovery lost COMMIT ACK');
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
    expect((await core('omniIncomingReceipt'))[0]).toMatchObject({
      id: captured.proof.receiptId,
      state: 'retryable_error',
    });
    expect((await audit()).every((row) => row.outcome === 'success')).toBe(
      true,
    );
    const before = await state();
    const beforeAudit = await audit();
    expect(await claim()).toEqual([]);
    expect(await state()).toEqual(before);
    expect(await audit()).toEqual(beforeAudit);
  });

  it('rejects a superseded worker lease, audits the failed attempt and preserves the replacement lease', async () => {
    await block();
    await produce();
    const original = await claimOne();
    await fixture.owner.query(
      'UPDATE core."omniBindingConfigWakeup" SET "leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE id=$1',
      [original.wakeupId],
    );
    const replacement = await claimOne();
    expect(replacement.leaseToken).toBe('2');
    const before = await state();
    const previousAudit = await audit();
    await expect(process(original)).rejects.toThrow(
      'OMNI_BINDING_CONFIG_WAKEUP_LEASE_LOST',
    );
    expect(await state()).toEqual(before);
    expect(
      (await audit()).filter(
        (row) => !previousAudit.some((old) => old.id === row.id),
      ),
    ).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        resourceId: context.bindingId,
        reasonCode: 'config_wakeup.process.failed',
      }),
    ]);
    expect(await process(replacement)).toMatchObject({ state: 'completed' });
  });

  it.each(['workspace', 'binding'] as const)(
    'refuses a foreign %s without leaking an audit into this scope',
    async (kind) => {
      await produce();
      const before = await state();
      const previousAudit = await audit();
      const principal = {
        ...context.principal,
        ...(kind === 'workspace'
          ? { workspaceId: randomUUID() }
          : { bindingId: randomUUID() }),
      };
      const grant = jest.fn(async () => undefined);
      await expect(
        fixture.service.executeOmniBindingConfigRecovery(
          principal,
          { operation: 'housekeeping' },
          grant,
        ),
      ).rejects.toThrow();
      expect(grant).not.toHaveBeenCalled();
      expect(await state()).toEqual(before);
      expect(await audit()).toEqual(previousAudit);
    },
  );
});
