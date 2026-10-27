import { randomUUID } from 'node:crypto';

import {
  mutateOmniBindingConfiguration,
  OmniBindingConfigurationOutcomeUnknownError,
  type OmniBindingConfigurationAuthorizer,
} from 'src/modules/omnichannel/services/mutate-omni-binding-configuration';
import { claimOmniIncomingReceipts } from 'src/modules/omnichannel/services/omni-incoming-receipt-lease';
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
type Command = Parameters<typeof mutateOmniBindingConfiguration>[2];
const principal = () => ({
  workspaceId: fixture.workspaceId,
  actor: context.principal.actor,
});
const authorize: OmniBindingConfigurationAuthorizer = async (
  runner,
  request,
) => {
  // Synthetic current configuration/activation grant; not production ROB-766 authorization.
  expect(runner.isTransactionActive).toBe(true);
  expect(request.workspaceId).toBe(fixture.workspaceId);
  expect(request.resourceDescriptor.bindingId).toBe(context.bindingId);
};
const mutate = (
  command: Command,
  authorization: OmniBindingConfigurationAuthorizer = authorize,
) =>
  mutateOmniBindingConfiguration(
    fixture.runtime,
    principal(),
    command,
    authorization,
  );
const createCommand = (name = 'Additional queue'): Command => ({
  action: 'queue.create',
  bindingId: context.bindingId,
  name,
  expectedRevision: '0',
  idempotencyKey: randomUUID(),
});
const updateCommand = (
  queueId: string,
  expectedRevision: string,
  update: { name?: string; active?: boolean },
): Command => ({
  action: 'queue.update',
  bindingId: context.bindingId,
  queueId,
  expectedRevision,
  idempotencyKey: randomUUID(),
  ...update,
});
const core = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const audit = (): Promise<Record<string, unknown>[]> =>
  fixture.owner.query('SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id');
const binding = async () =>
  (await core('omniAccountBinding')).find(
    (row) => row.id === context.bindingId,
  );
const configuration = async () => ({
  queues: await core('omniQueue'),
  bindings: await core('omniAccountBinding'),
  policy: await core('omniWorkspacePolicyState'),
  events: await core('omniDomainEvent'),
  receipts: await core('omniPolicyMutationReceipt'),
  wakeups: await core('omniBindingConfigWakeup'),
});
const createActiveQueue = async (name = 'Replacement queue') => {
  const created = await mutate(createCommand(name));
  return mutate(
    updateCommand(created.resourceId, created.revision, { active: true }),
  );
};
const defaultsCommand = async (queueId: string): Promise<Command> => {
  const current = await binding();
  if (!current || typeof current.revision !== 'string')
    throw new Error('Missing fixture binding');
  return {
    action: 'binding.defaults.update',
    bindingId: context.bindingId,
    idempotencyKey: randomUUID(),
    expectedRevision: current.revision,
    defaultQueueId: queueId,
    defaultConversationMode: 'human',
  };
};
const noAutomation = async () => {
  for (const table of [
    'omniRootExecution',
    'omniEventDispatchPlan',
    'omniAutomationAdmission',
    'omniOutgoingCommand',
    'omniReplyBudget',
  ])
    expect(await core(table)).toEqual([]);
  for (const table of [
    'message',
    'messageParticipant',
    'messageThreadTarget',
  ] as const)
    expect(await fixture.read(table)).toEqual([]);
  expect(fixture.eventEmitter).not.toHaveBeenCalled();
};

beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    `GRANT INSERT,UPDATE ON core."omniBindingConfigWakeup" TO "${fixture.roleName}"`,
  );
  await fixture.owner.query(
    `GRANT INSERT,UPDATE ON core."omniQueue" TO "${fixture.roleName}"`,
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

describe('current authorized binding configuration mutations', () => {
  it('creates an inactive queue with one durable configuration event and atomic mutation receipt/audit', async () => {
    const command = createCommand();
    const result = await mutate(command);
    expect(result).toMatchObject({
      bindingId: context.bindingId,
      revision: '1',
      changed: true,
    });
    expect(
      (await core('omniQueue')).find((row) => row.id === result.resourceId),
    ).toMatchObject({
      name: 'Additional queue',
      active: false,
      revision: '1',
      bindingId: context.bindingId,
    });
    const [event] = await core('omniDomainEvent');
    expect(event).toMatchObject({
      id: result.eventId,
      kind: 'binding.config_changed',
      origin: 'configuration_change',
      payloadVersion: 1,
      conversationId: null,
      conversationSequence: null,
      rootExecutionId: null,
      causationId: null,
      payload: {
        bindingId: context.bindingId,
        bindingRevision: '1',
        resourceKind: 'omniQueue',
        resourceId: result.resourceId,
        resourceRevision: '1',
        policyEpoch: '2',
      },
    });
    expect(await core('omniPolicyMutationReceipt')).toEqual([
      expect.objectContaining({
        operationId: result.operationId,
        idempotencyKey: command.idempotencyKey,
        action: 'queue.create',
      }),
    ]);
    expect(await core('omniBindingConfigWakeup')).toEqual([
      expect.objectContaining({
        workspaceId: fixture.workspaceId,
        bindingId: context.bindingId,
        eventId: result.eventId,
        handlerVersion: 1,
        state: 'pending',
        attempts: 0,
        leaseToken: '0',
        leaseOwner: null,
        leaseUntil: null,
        cursorNextAttemptAt: null,
        cursorReceiptId: null,
        needsRescan: false,
      }),
    ]);
    expect((await audit()).every((row) => row.outcome === 'success')).toBe(
      true,
    );
    expect(await audit()).toHaveLength(4);
    expect(
      (await audit()).some(
        (row) =>
          row.resourceId === result.resourceId && row.action === 'create',
      ),
    ).toBe(true);
    expect((await core('omniWorkspacePolicyState'))[0].epoch).toBe(
      result.policyEpoch,
    );
    expect((await binding())?.revision).toBe(result.bindingRevision);
    await noAutomation();
  });

  it('never activates an inactive binding or queue merely by creating configuration', async () => {
    await fixture.owner.query(
      'UPDATE core."omniAccountBinding" SET status=\'inactive\' WHERE id=$1',
      [context.bindingId],
    );
    const created = await mutate(createCommand());
    expect((await binding())?.status).toBe('inactive');
    expect(
      (await core('omniQueue')).find((row) => row.id === created.resourceId)
        ?.active,
    ).toBe(false);
    await noAutomation();
  });

  it('activates only with a fresh activation grant and applies new defaults without moving existing Conversations', async () => {
    context = await fixture.reset();
    const conversations = await core('omniConversation');
    const threads = await fixture.read('messageThread');
    const created = await mutate(createCommand());
    const activation = updateCommand(created.resourceId, created.revision, {
      active: true,
      name: 'Ready queue',
    });
    const activationAuthorize = jest.fn<
      ReturnType<OmniBindingConfigurationAuthorizer>,
      Parameters<OmniBindingConfigurationAuthorizer>
    >(async (runner, request) => {
      await authorize(runner, request);
      expect(request.activatingQueue).toBe(true);
    });
    const activated = await mutate(activation, activationAuthorize);
    expect(activated.revision).toBe('2');
    const result = await mutate(await defaultsCommand(created.resourceId));
    expect((await binding())?.defaultQueueId).toBe(created.resourceId);
    expect((await binding())?.defaultConversationMode).toBe('human');
    expect(result.changed).toBe(true);
    expect(await core('omniConversation')).toEqual(conversations);
    expect(await fixture.read('messageThread')).toEqual(threads);
    expect(activationAuthorize).toHaveBeenCalledTimes(1);
    expect(await core('omniDomainEvent')).toHaveLength(3);
    await noAutomation();
  });

  it('returns the original durable result on replay after fresh authorization without new writes', async () => {
    const command = createCommand();
    const first = await mutate(command);
    const before = await configuration();
    const previousAudit = await audit();
    const replayAuthorize: OmniBindingConfigurationAuthorizer = async (
      runner,
      request,
    ) => {
      await authorize(runner, request);
      expect(request.replay).toBe(true);
    };
    expect(await mutate(command, replayAuthorize)).toEqual(first);
    expect(await configuration()).toEqual(before);
    expect(await audit()).toEqual(previousAudit);
  });

  it('rejects the same idempotency key with another payload without a second mutation', async () => {
    const command = createCommand();
    if (command.action !== 'queue.create')
      throw new Error('Expected create command');
    await mutate(command);
    const before = await configuration();
    await expect(
      mutate({ ...command, name: 'Conflicting name' }),
    ).rejects.toThrow();
    expect(await configuration()).toEqual(before);
    expect(
      (await audit()).filter((row) => row.outcome === 'failed'),
    ).toHaveLength(1);
  });

  it('rejects expired replay results instead of recreating configuration', async () => {
    const command = createCommand();
    await mutate(command);
    await fixture.owner.query(
      'UPDATE core."omniPolicyMutationReceipt" SET "resultPublic"=NULL WHERE "idempotencyKey"=$1',
      [command.idempotencyKey],
    );
    const before = await configuration();
    await expect(mutate(command)).rejects.toThrow();
    expect(await configuration()).toEqual(before);
  });

  it('rejects a retained result with a foreign event ID instead of returning the corrupted result', async () => {
    const command = createCommand();
    await mutate(command);
    await fixture.owner.query(
      'UPDATE core."omniPolicyMutationReceipt" SET "resultPublic"=jsonb_set("resultPublic",\'{eventId}\',to_jsonb($1::text)) WHERE "idempotencyKey"=$2',
      [randomUUID(), command.idempotencyKey],
    );
    const before = await configuration();
    await expect(mutate(command)).rejects.toThrow(
      'OMNI_BINDING_CONFIGURATION_RECEIPT_INTEGRITY',
    );
    expect(await configuration()).toEqual(before);
    expect(
      (await audit()).filter((row) => row.outcome === 'failed'),
    ).toHaveLength(1);
  });

  it('rechecks revoked authorization on replay and records denial without returning the stored success', async () => {
    const command = createCommand();
    await mutate(command);
    const before = await configuration();
    await expect(
      mutate(command, async (_runner, request) => {
        expect(request.replay).toBe(true);
        throw new Error('fixture revoked configuration grant');
      }),
    ).rejects.toThrow('fixture revoked configuration grant');
    expect(await configuration()).toEqual(before);
    expect(
      (await audit()).filter((row) => row.outcome === 'denied'),
    ).toHaveLength(1);
  });

  it('rejects stale queue revision and leaves queue/binding/epoch/event untouched', async () => {
    const created = await mutate(createCommand());
    await mutate(
      updateCommand(created.resourceId, '1', { name: 'Current name' }),
    );
    const before = await configuration();
    await expect(
      mutate(
        updateCommand(created.resourceId, '1', { name: 'Stale overwrite' }),
      ),
    ).rejects.toThrow();
    expect(await configuration()).toEqual(before);
  });

  it('rejects stale binding revision before changing defaults', async () => {
    const target = await createActiveQueue();
    const command = await defaultsCommand(target.resourceId);
    const another = await createActiveQueue('Intervening configuration');
    await mutate(await defaultsCommand(another.resourceId));
    const before = await configuration();
    await expect(mutate(command)).rejects.toThrow();
    expect(await configuration()).toEqual(before);
  });

  it('records an idempotent no-op without changing revisions, epoch, events or success audit', async () => {
    const created = await mutate(createCommand());
    const before = await configuration();
    const beforeAudit = await audit();
    const command = updateCommand(created.resourceId, '1', {
      name: 'Additional queue',
      active: false,
    });
    const result = await mutate(command);
    expect(result).toMatchObject({
      changed: false,
      eventId: null,
      revision: '1',
    });
    const after = await configuration();
    expect({ ...after, receipts: before.receipts }).toEqual(before);
    expect(after.receipts).toHaveLength(before.receipts.length + 1);
    expect(await audit()).toEqual(beforeAudit);
    expect(await mutate(command)).toEqual(result);
  });

  it('refuses disabling an active binding default queue', async () => {
    const before = await configuration();
    await expect(
      mutate(updateCommand(context.queueId, '1', { active: false })),
    ).rejects.toThrow();
    expect(await configuration()).toEqual(before);
  });

  it.each(['open', 'closed'] as const)(
    'refuses disabling a non-default queue retaining a %s Conversation',
    async (status) => {
      context = await fixture.reset();
      await fixture.owner.query(
        'UPDATE core."omniConversation" SET status=$1 WHERE id=$2',
        [status, context.conversationId],
      );
      const target = await createActiveQueue();
      await mutate(await defaultsCommand(target.resourceId));
      const before = await configuration();
      const conversations = await core('omniConversation');
      await expect(
        mutate(updateCommand(context.queueId, '1', { active: false })),
      ).rejects.toThrow();
      expect(await configuration()).toEqual(before);
      expect(await core('omniConversation')).toEqual(conversations);
    },
  );

  it('allows disabling an empty non-default queue and bumps queue revision and epoch once', async () => {
    const queue = await createActiveQueue();
    const before = await binding();
    const epoch = (await core('omniWorkspacePolicyState'))[0].epoch;
    const disabled = await mutate(
      updateCommand(queue.resourceId, '2', { active: false }),
    );
    expect(disabled.revision).toBe('3');
    expect(
      (await core('omniQueue')).find((row) => row.id === queue.resourceId)
        ?.active,
    ).toBe(false);
    expect(BigInt(disabled.policyEpoch)).toBe(BigInt(String(epoch)) + 1n);
    expect(disabled.bindingRevision).toBe(before?.revision);
  });

  it('refuses an inactive default target', async () => {
    const created = await mutate(createCommand());
    const before = await configuration();
    await expect(
      mutate(await defaultsCommand(created.resourceId)),
    ).rejects.toThrow();
    expect(await configuration()).toEqual(before);
  });

  it('refuses assigning or modifying a queue owned by another binding', async () => {
    const channelId = await fixture.coreInsert('messageChannel', {
      workspaceId: fixture.workspaceId,
      type: 'APP',
      connectedAccountId: context.connectedAccountId,
    });
    const otherBindingId = await fixture.coreInsert('omniAccountBinding', {
      workspaceId: fixture.workspaceId,
      platform: 'telegram',
      connectorInstanceId: 'other-fixture',
      accountId: randomUUID(),
      connectedAccountId: context.connectedAccountId,
      messageChannelId: channelId,
      capabilitiesVersion: 'fixture-v1',
      capabilities: '{}',
    });
    const foreignQueueId = await fixture.coreInsert('omniQueue', {
      workspaceId: fixture.workspaceId,
      bindingId: otherBindingId,
      name: 'Foreign queue',
      active: true,
    });
    const before = await configuration();
    await expect(
      mutate(await defaultsCommand(foreignQueueId)),
    ).rejects.toThrow();
    await expect(
      mutate(
        updateCommand(foreignQueueId, '1', { name: 'Unauthorized transfer' }),
      ),
    ).rejects.toThrow();
    expect(await configuration()).toEqual(before);
  });

  it('rolls back a first mutation when its current authorization is denied', async () => {
    const before = await configuration();
    await expect(
      mutate(createCommand(), async () => {
        throw new Error('fixture current grant denied');
      }),
    ).rejects.toThrow('fixture current grant denied');
    expect(await configuration()).toEqual(before);
    expect(await audit()).toEqual([
      expect.objectContaining({
        outcome: 'denied',
        resourceId: context.bindingId,
      }),
    ]);
  });

  it.each(['workspace', 'binding'] as const)(
    'rejects a foreign %s scope without exposing or auditing this binding',
    async (kind) => {
      const before = await configuration();
      const otherPrincipal = {
        ...principal(),
        ...(kind === 'workspace' ? { workspaceId: randomUUID() } : {}),
      };
      const command = {
        ...createCommand(),
        ...(kind === 'binding' ? { bindingId: randomUUID() } : {}),
      };
      const grant = jest.fn(async () => undefined);
      await expect(
        mutateOmniBindingConfiguration(
          fixture.runtime,
          otherPrincipal,
          command,
          grant,
        ),
      ).rejects.toThrow();
      expect(grant).not.toHaveBeenCalled();
      expect(await configuration()).toEqual(before);
      expect(await audit()).toEqual([]);
    },
  );

  it('repairs blocked history with the actual config writer and resumes, claims and applies the same receipt', async () => {
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
    ).toMatchObject({ state: 'blocked_config' });
    const repaired = await mutate(
      updateCommand(context.queueId, '1', { active: true }),
    );
    expect(repaired.changed).toBe(true);
    expect((await core('omniIncomingReceipt'))[0].state).toBe('blocked_config');
    expect(
      await fixture.service.resumeOmniBlockedHistoryReceipts(
        context.principal,
        { routeGeneration: '1', limit: 10 },
        async () => undefined,
      ),
    ).toMatchObject({ resumedReceiptIds: [captured.proof.receiptId] });
    const [claim] = await claimOmniIncomingReceipts(
      fixture.runtime,
      context.principal,
      { leaseOwner: randomUUID(), limit: 1, leaseMilliseconds: 300000 },
      async () => undefined,
    );
    expect(claim).toMatchObject({
      receiptId: captured.proof.receiptId,
      leaseToken: '2',
    });
    const result = await fixture.service.processOmniHistoryReceipt(
      context.principal,
      {
        receiptId: claim.receiptId,
        leaseOwner: claim.leaseOwner,
        leaseToken: claim.leaseToken,
        routeGeneration: claim.routeGeneration,
        externalIdentityId: context.externalIdentityId,
      },
      historyAuthorize,
      async () => undefined,
    );
    expect(result).toMatchObject({ state: 'applied', created: true });
    expect(await core('omniIncomingReceipt')).toHaveLength(1);
    expect(await fixture.read('message')).toHaveLength(1);
    expect(
      (await core('omniDomainEvent')).filter(
        (row) => row.kind === 'binding.config_changed',
      ),
    ).toHaveLength(1);
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });

  it.each([
    'omniQueue',
    'omniAccountBinding',
    'omniWorkspacePolicyState',
    'omniDomainEvent',
    'crmAuditEntry',
    'omniPolicyMutationReceipt',
    'omniBindingConfigWakeup',
  ])(
    'rolls back every configuration write if %s persistence fails',
    async (table) => {
      const schema = table === 'crmAuditEntry' ? 'crm_audit' : 'core';
      const operation = [
        'omniAccountBinding',
        'omniWorkspacePolicyState',
      ].includes(table)
        ? 'UPDATE'
        : 'INSERT';
      const command =
        table === 'omniAccountBinding'
          ? await defaultsCommand((await createActiveQueue()).resourceId)
          : createCommand();
      const before = await configuration();
      const beforeAudit = await audit();
      await fixture.owner.query(
        `CREATE FUNCTION core.log038_fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${table === 'crmAuditEntry' ? "IF NEW.outcome='success' THEN RAISE EXCEPTION 'fixture config write failure'; END IF;" : "RAISE EXCEPTION 'fixture config write failure';"} RETURN NEW; END $$`,
      );
      await fixture.owner.query(
        `CREATE TRIGGER log038_fail_write BEFORE ${operation} ON "${schema}"."${table}" FOR EACH ROW EXECUTE FUNCTION core.log038_fail_write()`,
      );
      try {
        await expect(mutate(command)).rejects.toThrow(
          'fixture config write failure',
        );
        expect(await configuration()).toEqual(before);
        expect(
          (await audit()).filter(
            (row) => !beforeAudit.some((old) => old.id === row.id),
          ),
        ).toEqual([expect.objectContaining({ outcome: 'failed' })]);
        await noAutomation();
      } finally {
        await fixture.owner.query(
          `DROP TRIGGER log038_fail_write ON "${schema}"."${table}"`,
        );
        await fixture.owner.query('DROP FUNCTION core.log038_fail_write()');
      }
    },
  );

  it('reconciles actual COMMIT acknowledgement loss through the same idempotency key', async () => {
    const command = createCommand();
    const runner = fixture.runtime.createQueryRunner();
    const commit = runner.commitTransaction.bind(runner);
    const rollback = jest.spyOn(runner, 'rollbackTransaction');
    jest.spyOn(runner, 'commitTransaction').mockImplementationOnce(async () => {
      await commit();
      throw new Error('fixture config lost COMMIT ACK');
    });
    jest
      .spyOn(fixture.runtime, 'createQueryRunner')
      .mockReturnValueOnce(runner);
    await expect(mutate(command)).rejects.toBeInstanceOf(
      OmniBindingConfigurationOutcomeUnknownError,
    );
    expect(rollback).not.toHaveBeenCalled();
    expect(await core('omniPolicyMutationReceipt')).toHaveLength(1);
    expect((await audit()).every((row) => row.outcome === 'success')).toBe(
      true,
    );
    const before = await configuration();
    const beforeAudit = await audit();
    const replay = await mutate(command);
    expect(replay.changed).toBe(true);
    expect(await configuration()).toEqual(before);
    expect(await audit()).toEqual(beforeAudit);
  });

  it('serializes identical concurrent keys into a single configuration mutation', async () => {
    const command = createCommand();
    const [first, second] = await Promise.all([
      mutate(command),
      mutate(command),
    ]);
    expect(second).toEqual(first);
    expect(await core('omniPolicyMutationReceipt')).toHaveLength(1);
    expect(await core('omniDomainEvent')).toHaveLength(1);
    expect((await audit()).every((row) => row.outcome === 'success')).toBe(
      true,
    );
    expect(await core('omniQueue')).toHaveLength(2);
  });

  it('preserves an unknown rollback outcome after actual rollback loses its acknowledgement', async () => {
    const before = await configuration();
    const runner = fixture.runtime.createQueryRunner();
    const query = runner.query.bind(runner);
    const rollback = runner.rollbackTransaction.bind(runner);
    let reachedPersistedEvent = false;
    jest
      .spyOn(runner, 'query')
      .mockImplementation(async (...args: Parameters<typeof runner.query>) => {
        if (args[0].includes('INSERT INTO core."omniPolicyMutationReceipt"')) {
          const events: { count: string }[] = await query(
            'SELECT count(*)::text AS count FROM core."omniDomainEvent"',
          );
          reachedPersistedEvent = events[0].count === '1';
          throw new Error('fixture receipt persistence interrupted');
        }
        return query(...args);
      });
    jest
      .spyOn(runner, 'rollbackTransaction')
      .mockImplementationOnce(async () => {
        await rollback();
        throw new Error('fixture lost ROLLBACK ACK');
      });
    jest
      .spyOn(fixture.runtime, 'createQueryRunner')
      .mockReturnValueOnce(runner);
    const outcome: unknown = await mutate(createCommand()).catch(
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(OmniBindingConfigurationOutcomeUnknownError);
    expect(outcome).toMatchObject({ phase: 'rollback' });
    expect(reachedPersistedEvent).toBe(true);
    expect(await configuration()).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(runner.isReleased).toBe(true);
  });

  it('preserves committed configuration after actual release loses its acknowledgement and replays the same key', async () => {
    const command = createCommand();
    const runner = fixture.runtime.createQueryRunner();
    const release = runner.release.bind(runner);
    jest.spyOn(runner, 'release').mockImplementationOnce(async () => {
      await release();
      throw new Error('fixture lost release ACK');
    });
    jest
      .spyOn(fixture.runtime, 'createQueryRunner')
      .mockReturnValueOnce(runner);
    const outcome: unknown = await mutate(command).catch(
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(OmniBindingConfigurationOutcomeUnknownError);
    expect(outcome).toMatchObject({ phase: 'release' });
    expect(runner.isReleased).toBe(true);
    expect(await core('omniPolicyMutationReceipt')).toHaveLength(1);
    const before = await configuration();
    const beforeAudit = await audit();
    expect(beforeAudit).toHaveLength(4);
    expect(beforeAudit.every((row) => row.outcome === 'success')).toBe(true);
    expect(await mutate(command)).toMatchObject({ changed: true });
    expect(await configuration()).toEqual(before);
    expect(await audit()).toEqual(beforeAudit);
  });

  it('retains both rollback failures and explicitly cleans the fixture connection before pool release', async () => {
    const before = await configuration();
    const runner = fixture.runtime.createQueryRunner();
    const query = runner.query.bind(runner);
    const release = runner.release.bind(runner);
    let fixtureCleanedConnection = false;
    let reachedPersistedEvent = false;
    jest
      .spyOn(runner, 'query')
      .mockImplementation(async (...args: Parameters<typeof runner.query>) => {
        if (args[0] === 'ROLLBACK')
          throw new Error('fixture raw rollback failed');
        if (args[0].includes('INSERT INTO core."omniPolicyMutationReceipt"')) {
          const events: { count: string }[] = await query(
            'SELECT count(*)::text AS count FROM core."omniDomainEvent"',
          );
          reachedPersistedEvent = events[0].count === '1';
          throw new Error('fixture receipt persistence interrupted');
        }
        return query(...args);
      });
    jest
      .spyOn(runner, 'rollbackTransaction')
      .mockRejectedValueOnce(new Error('fixture rollback method failed'));
    jest.spyOn(runner, 'release').mockImplementationOnce(async () => {
      // The injected double failure must not return an open transaction to the test pool.
      await query('ROLLBACK');
      fixtureCleanedConnection = true;
      await release();
    });
    jest
      .spyOn(fixture.runtime, 'createQueryRunner')
      .mockReturnValueOnce(runner);
    try {
      const outcome: unknown = await mutate(createCommand()).catch(
        (error: unknown) => error,
      );
      expect(outcome).toBeInstanceOf(
        OmniBindingConfigurationOutcomeUnknownError,
      );
      expect(outcome).toMatchObject({ phase: 'rollback' });
      const errorMessages = (error: unknown): string[] => {
        if (!(error instanceof Error)) return [];
        return [
          error.message,
          ...errorMessages(error.cause),
          ...(error instanceof AggregateError
            ? error.errors.flatMap(errorMessages)
            : []),
        ];
      };
      expect(errorMessages(outcome)).toEqual(
        expect.arrayContaining([
          'fixture receipt persistence interrupted',
          'fixture rollback method failed',
          'fixture raw rollback failed',
        ]),
      );
      expect(reachedPersistedEvent).toBe(true);
      expect(fixtureCleanedConnection).toBe(true);
      expect(await configuration()).toEqual(before);
      expect(await audit()).toEqual([]);
    } finally {
      if (!runner.isReleased) {
        await query('ROLLBACK');
        await release();
      }
    }
  });

  it('allows only one concurrent queue revision contender to commit', async () => {
    const created = await mutate(createCommand());
    const results = await Promise.allSettled([
      mutate(
        updateCommand(created.resourceId, '1', { name: 'First contender' }),
      ),
      mutate(
        updateCommand(created.resourceId, '1', { name: 'Second contender' }),
      ),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      (await core('omniQueue')).find((row) => row.id === created.resourceId)
        ?.revision,
    ).toBe('2');
    expect((await core('omniWorkspacePolicyState'))[0].epoch).toBe('3');
    expect(await core('omniDomainEvent')).toHaveLength(2);
    expect(await core('omniPolicyMutationReceipt')).toHaveLength(2);
  });

  it('waits behind the parent policy lock and checks the committed queue revision', async () => {
    const created = await mutate(createCommand());
    const writer = fixture.owner.createQueryRunner();
    const runner = fixture.runtime.createQueryRunner();
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
      await runner.connect();
      const [runtimeSession]: { pid: number }[] = await runner.query(
        'SELECT pg_backend_pid() AS pid',
      );
      const query = runner.query.bind(runner);
      let notifyStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      jest
        .spyOn(runner, 'query')
        .mockImplementation(
          async (...args: Parameters<typeof runner.query>) => {
            if (args[0].includes('omniWorkspacePolicyState')) notifyStarted();
            return query(...args);
          },
        );
      jest
        .spyOn(fixture.runtime, 'createQueryRunner')
        .mockReturnValueOnce(runner);
      const outcome = mutate(
        updateCommand(created.resourceId, '1', { name: 'Stale waiting edit' }),
      ).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      pendingOutcome = outcome;
      await Promise.race([
        started,
        outcome.then((settled) => {
          throw new Error(
            'Configuration mutation settled before policy barrier',
            { cause: settled },
          );
        }),
      ]);
      let blocked = false;
      const deadline = Date.now() + 2000;
      while (!blocked && Date.now() < deadline) {
        const [state]: { blocked: boolean }[] = await fixture.owner.query(
          'SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked',
          [writerSession.pid, runtimeSession.pid],
        );
        blocked = state.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      await writer.query(
        'UPDATE core."omniQueue" SET name=\'Committed concurrent edit\',revision=2 WHERE id=$1',
        [created.resourceId],
      );
      await writer.commitTransaction();
      expect(await outcome).toMatchObject({
        error: expect.objectContaining({
          message: 'OMNI_BINDING_CONFIGURATION_REVISION_CONFLICT',
        }),
      });
      expect(
        (await core('omniQueue')).find((row) => row.id === created.resourceId),
      ).toMatchObject({ revision: '2', name: 'Committed concurrent edit' });
      expect(await core('omniDomainEvent')).toHaveLength(1);
      expect(await core('omniPolicyMutationReceipt')).toHaveLength(1);
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await writer.release();
      await pendingOutcome;
      if (!runner.isReleased) await runner.release();
    }
  });
});
