import { randomUUID } from 'node:crypto';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { type OmniHumanTextCommandAuthorizer } from 'src/modules/omnichannel/services/admit-omni-human-text-command';
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

const fixture = createOmniHistoryApplyFixture({ includeWorkspaceMember: true });
let context: Awaited<ReturnType<typeof fixture.reset>>;
let principal: {
  workspaceId: string;
  userId: string;
  workspaceMemberId: string;
};
const TEXT = 'Private human-composed message';
type Input = Parameters<typeof fixture.service.admitOmniHumanTextCommand>[1];
const input = (overrides: Partial<Input> = {}): Input => ({
  conversationId: context.conversationId,
  text: TEXT,
  idempotencyKey: randomUUID(),
  expectedControlEpoch: '1',
  observedReplyRevision: '1',
  ...overrides,
});
const authorize: OmniHumanTextCommandAuthorizer = async (scope, request) => {
  // Explicit fixture grant only; native membership is still queried by the real admission code.
  expect(scope.workspaceId).toBe(principal.workspaceId);
  expect(request).toMatchObject({
    workspaceId: principal.workspaceId,
    userId: principal.userId,
    workspaceMemberId: principal.workspaceMemberId,
    action: 'command.admit',
    bindingId: context.bindingId,
    queueId: context.queueId,
    policyId: context.policyId,
    policyVersion: '0',
  });
};
const admit = (command = input(), grant = authorize, actor = principal) =>
  fixture.service.admitOmniHumanTextCommand(actor, command, grant);
const core = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const audit = (): Promise<Record<string, unknown>[]> =>
  fixture.owner.query('SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id');
const snapshot = async () => ({
  commands: await core('omniOutgoingCommand'),
  conversations: await core('omniConversation'),
  roots: await core('omniRootExecution'),
  events: await core('omniDomainEvent'),
  plans: await core('omniEventDispatchPlan'),
});
const noDelivery = async () => {
  expect(await fixture.read('message')).toEqual([]);
  expect(await fixture.read('messageParticipant')).toEqual([]);
  expect(await fixture.read('messageChannelMessageAssociation')).toEqual([]);
  expect(await core('omniMessageLink')).toEqual([]);
  expect(await core('omniAutomationAdmission')).toEqual([]);
  expect(await core('omniReplyBudget')).toEqual([]);
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
  // Minimal core identity projection only; native WorkspaceMember uses standard generated metadata/DDL.
  await fixture.owner.query(
    'CREATE TABLE core."user" (id uuid PRIMARY KEY,"deletedAt" timestamptz)',
  );
  await fixture.owner.query(
    'CREATE TABLE core."userWorkspace" (id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,"workspaceId" uuid NOT NULL REFERENCES core.workspace(id) ON DELETE CASCADE,"deletedAt" timestamptz)',
  );
  await fixture.owner.query(
    'CREATE UNIQUE INDEX "IDX_USER_WORKSPACE_USER_ID_WORKSPACE_ID_UNIQUE" ON core."userWorkspace" ("userId","workspaceId") WHERE "deletedAt" IS NULL',
  );
  await fixture.owner.query(
    `GRANT SELECT,UPDATE(id) ON core."user",core."userWorkspace" TO "${fixture.roleName}"`,
  );
  await fixture.owner.query(
    `GRANT INSERT ON core."omniOutgoingCommand" TO "${fixture.roleName}"`,
  );
});
beforeEach(async () => {
  context = await fixture.reset();
  await fixture.owner.query('TRUNCATE core."user" CASCADE');
  principal = {
    workspaceId: fixture.workspaceId,
    userId: randomUUID(),
    workspaceMemberId: randomUUID(),
  };
  await fixture.owner.query('INSERT INTO core."user" (id) VALUES ($1)', [
    principal.userId,
  ]);
  await fixture.owner.query(
    'INSERT INTO core."userWorkspace" (id,"userId","workspaceId") VALUES ($1,$2,$3)',
    [randomUUID(), principal.userId, fixture.workspaceId],
  );
  await fixture.withContext(() =>
    fixture.dataSource.transaction(
      async (scope) => {
        await scope
          .getRepository('workspaceMember', {
            shouldBypassPermissionChecks: true,
          })
          .insert({
            id: principal.workspaceMemberId,
            userId: principal.userId,
            name: { firstName: 'Human', lastName: 'Operator' },
            userEmail: 'operator@example.test',
          });
      },
      { commitOutcome: 'strict' },
    ),
  );
  fixture.eventEmitter.mockClear();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('human text command admission through the strict owner', () => {
  it.each(['human', 'assist'] as const)(
    'admits a %s intent with server provenance, counters, suppressed event and five atomic audits',
    async (mode) => {
      await fixture.owner.query(
        'UPDATE core."omniConversation" SET mode=$1 WHERE id=$2',
        [mode, context.conversationId],
      );
      const command = input();
      const result = await admit(command);
      expect(result).toMatchObject({
        state: 'pending',
        created: true,
        replyRevision: '2',
        controlEpoch: '1',
        mode,
      });
      expect(await core('omniOutgoingCommand')).toEqual([
        expect.objectContaining({
          id: result.commandId,
          actorKind: 'workspaceMember',
          actorId: principal.workspaceMemberId,
          initiatingActorId: principal.workspaceMemberId,
          senderClass: 'human',
          contentProvenance: 'human_direct',
          state: 'pending',
          generation: '1',
          outboundSequence: '1',
          expectedAutomationEpoch: null,
          producerTurnId: null,
          capturedTurnFence: null,
          referenceId: null,
          connectorJobId: null,
          replacesCommandId: null,
          replyToMessageLinkId: null,
          resolvedReplyNativeRef: null,
          workflowCancellationRefs: [],
          payload: {
            version: 1,
            workspaceId: fixture.workspaceId,
            conversationId: context.conversationId,
            bindingId: context.bindingId,
            providerChatId: 'history-chat',
            text: TEXT,
            readyFileIds: [],
            replyToMessageLinkId: null,
            resolvedReplyNativeRef: null,
          },
        }),
      ]);
      expect((await core('omniConversation'))[0]).toMatchObject({
        conversationSequence: '1',
        replyRevision: '2',
        nextOutboundSequence: '2',
        mode,
        controlEpoch: '1',
      });
      expect(await core('omniDomainEvent')).toEqual([
        expect.objectContaining({
          kind: 'command.created',
          origin: 'human_composer',
          conversationSequence: '1',
          payload: {
            commandId: result.commandId,
            outboundSequence: '1',
            senderClass: 'human',
            dispatchSuppressed: true,
          },
        }),
      ]);
      expect(await core('omniRootExecution')).toEqual([
        expect.objectContaining({
          state: 'suppressed',
          origin: 'human_composer',
          maxCrmEffects: '0',
          maxHops: '0',
          policyVersion: '0',
        }),
      ]);
      expect(await core('omniEventDispatchPlan')).toEqual([
        expect.objectContaining({
          state: 'suppressed',
          targets: [],
          policyVersion: '0',
        }),
      ]);
      expect(await audit()).toHaveLength(5);
      expect((await audit()).every((row) => row.outcome === 'success')).toBe(
        true,
      );
      expect(JSON.stringify(await audit())).not.toContain(TEXT);
      await noDelivery();
    },
  );

  it('replays only after current authorization, without consuming counters or writing another command', async () => {
    const command = input();
    const created = await admit(command);
    const before = await snapshot();
    const previousAudit = await audit();
    const grant: OmniHumanTextCommandAuthorizer = async (scope, request) => {
      await authorize(scope, request);
      expect(request.replay).toBe(true);
    };
    expect(await admit(command, grant)).toMatchObject({
      commandId: created.commandId,
      created: false,
      replyRevision: '2',
    });
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toEqual(previousAudit);
  });

  it('serializes concurrent identical keys in one Conversation into one command and one audit set', async () => {
    const command = input();
    const results = await Promise.all([admit(command), admit(command)]);
    expect(results.map((row) => row.created).sort()).toEqual([false, true]);
    expect(new Set(results.map((row) => row.commandId)).size).toBe(1);
    expect(await core('omniOutgoingCommand')).toHaveLength(1);
    expect(await audit()).toHaveLength(5);
    expect((await core('omniConversation'))[0]).toMatchObject({
      conversationSequence: '1',
      replyRevision: '2',
      nextOutboundSequence: '2',
    });
  });

  it('returns current authorized revisions on replay after later intents and route/control changes', async () => {
    const original = input();
    const created = await admit(original);
    await admit(input({ observedReplyRevision: '2', text: 'Later intent' }));
    await fixture.owner.query(
      'UPDATE core."omniAccountBinding" SET "routeGeneration"=2 WHERE id=$1',
      [context.bindingId],
    );
    await fixture.owner.query(
      'UPDATE core."omniConversation" SET "controlEpoch"=2,mode=\'assist\' WHERE id=$1',
      [context.conversationId],
    );
    const before = await snapshot();
    const previousAudit = await audit();
    const result = await admit(original, async (scope, request) => {
      await authorize(scope, request);
      expect(request).toMatchObject({
        replay: true,
        routeGeneration: '2',
        mode: 'assist',
      });
    });
    expect(result).toMatchObject({
      commandId: created.commandId,
      created: false,
      replyRevision: '3',
      controlEpoch: '2',
      mode: 'assist',
    });
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toEqual(previousAudit);
  });

  it.each(['readyFileIds', 'replyToMessageLinkId'] as const)(
    'rejects unsupported composer field %s before opening a transaction',
    async (field) => {
      const supplied = {
        ...input(),
        [field]: field === 'readyFileIds' ? [randomUUID()] : randomUUID(),
      };
      const transaction = jest.spyOn(
        fixture.manager,
        'runInWorkspaceTransaction',
      );
      await expect(admit(supplied)).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
      expect(await core('omniOutgoingCommand')).toEqual([]);
      expect(await audit()).toEqual([]);
    },
  );

  it('preserves legitimate Unicode emoji in human text', async () => {
    const text = 'Здравствуйте 👋🙂';
    expect(await admit(input({ text }))).toMatchObject({ created: true });
    expect((await core('omniOutgoingCommand'))[0].payload).toEqual(
      expect.objectContaining({ text }),
    );
    await noDelivery();
  });

  it('denies a revoked current grant even for a previously successful idempotency key', async () => {
    const command = input();
    await admit(command);
    const before = await snapshot();
    await expect(
      admit(command, async () => {
        throw new Error('fixture revoked send grant');
      }),
    ).rejects.toThrow('fixture revoked send grant');
    expect(await snapshot()).toEqual(before);
    expect((await audit()).filter((row) => row.outcome === 'denied')).toEqual([
      expect.objectContaining({
        resourceId: context.conversationId,
        reasonCode: 'command.admit.denied',
      }),
    ]);
  });

  it('rejects different text under the same key and never overwrites its original payload', async () => {
    const command = input();
    await admit(command);
    const before = await snapshot();
    await expect(
      admit({ ...command, text: 'Another message' }),
    ).rejects.toThrow('OMNI_HUMAN_TEXT_COMMAND_IDEMPOTENCY_CONFLICT');
    expect(await snapshot()).toEqual(before);
  });

  it.each(['workspaceMember', 'userWorkspace', 'user'] as const)(
    'denies retained but revoked %s identity with a separate denied audit',
    async (table) => {
      const target =
        table === 'workspaceMember'
          ? `"${fixture.schemaName}"."workspaceMember"`
          : `core."${table}"`;
      await fixture.owner.query(
        `UPDATE ${target} SET "deletedAt"=clock_timestamp()`,
      );
      const before = await snapshot();
      await expect(admit()).rejects.toThrow(
        'OMNI_HUMAN_TEXT_COMMAND_MEMBERSHIP_DENIED',
      );
      expect(await snapshot()).toEqual(before);
      expect(await audit()).toEqual([
        expect.objectContaining({
          outcome: 'denied',
          resourceId: context.conversationId,
          reasonCode: 'command.admit.denied',
        }),
      ]);
      await noDelivery();
    },
  );

  it.each(['workspace', 'workspaceMember', 'user'] as const)(
    'rejects a forged %s principal without manufacturing actor audit',
    async (kind) => {
      const supplied = {
        ...principal,
        ...(kind === 'workspace'
          ? { workspaceId: randomUUID() }
          : kind === 'workspaceMember'
            ? { workspaceMemberId: randomUUID() }
            : { userId: randomUUID() }),
      };
      const before = await snapshot();
      const grant = jest.fn(async () => undefined);
      await expect(admit(input(), grant, supplied)).rejects.toThrow();
      expect(grant).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
      expect(await audit()).toEqual([]);
    },
  );

  it('writes one denied attempt for a rejoined member with multiple retained userWorkspace rows', async () => {
    await fixture.owner.query(
      'INSERT INTO core."userWorkspace" (id,"userId","workspaceId","deletedAt") VALUES ($1,$2,$3,clock_timestamp())',
      [randomUUID(), principal.userId, fixture.workspaceId],
    );
    const before = await snapshot();
    await expect(
      admit(input(), async () => {
        throw new Error('fixture rejoined member grant denied');
      }),
    ).rejects.toThrow('fixture rejoined member grant denied');
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toEqual([
      expect.objectContaining({
        outcome: 'denied',
        resourceId: context.conversationId,
        reasonCode: 'command.admit.denied',
      }),
    ]);
  });

  it('does not manufacture actor audit when no retained workspace membership exists', async () => {
    await fixture.owner.query(
      'DELETE FROM core."userWorkspace" WHERE "userId"=$1',
      [principal.userId],
    );
    const before = await snapshot();
    await expect(admit()).rejects.toThrow(
      'OMNI_HUMAN_TEXT_COMMAND_MEMBERSHIP_DENIED',
    );
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toEqual([]);
  });

  it('rechecks actual userWorkspace revocation on idempotent replay', async () => {
    const command = input();
    await admit(command);
    await fixture.owner.query(
      'UPDATE core."userWorkspace" SET "deletedAt"=clock_timestamp() WHERE "userId"=$1',
      [principal.userId],
    );
    const before = await snapshot();
    await expect(admit(command)).rejects.toThrow(
      'OMNI_HUMAN_TEXT_COMMAND_MEMBERSHIP_DENIED',
    );
    expect(await snapshot()).toEqual(before);
    expect(
      (await audit()).filter((row) => row.outcome === 'denied'),
    ).toHaveLength(1);
  });

  it('serializes membership revocation behind admission and denies the next intent', async () => {
    const revoker = fixture.owner.createQueryRunner();
    await revoker.connect();
    await revoker.startTransaction();
    const [{ pid: revokerPid }] = await revoker.query(
      'SELECT pg_backend_pid() AS pid',
    );
    let releaseAdmission = () => {};
    const releaseGate = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let signalIdentityLocked = (pid: number) => {
      void pid;
    };
    const identityLocked = new Promise<number>((resolve) => {
      signalIdentityLocked = resolve;
    });
    const admission = admit(input(), async (scope, request) => {
      await authorize(scope, request);
      const [row] = await scope.executeRawQuery(
        'SELECT pg_backend_pid() AS pid',
      );
      signalIdentityLocked(Number(row.pid));
      await releaseGate;
    });
    const admissionOutcome = admission.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    let revocationOutcome: Promise<{ error?: unknown }> | undefined;
    try {
      // The real admission has already SHARE-locked membership before authorization.
      const admissionPid = await Promise.race([
        identityLocked,
        admissionOutcome.then((outcome) => {
          if ('error' in outcome) throw outcome.error;
          throw new Error(
            'Admission completed before the identity lock barrier',
          );
        }),
      ]);
      revocationOutcome = revoker
        .query(
          'UPDATE core."userWorkspace" SET "deletedAt"=clock_timestamp() WHERE "userId"=$1 AND "workspaceId"=$2 AND "deletedAt" IS NULL',
          [principal.userId, fixture.workspaceId],
        )
        .then(
          () => ({}),
          (error: unknown) => ({ error }),
        );
      let blocked = false;
      const deadline = Date.now() + 2000;
      while (!blocked && Date.now() < deadline) {
        const [row] = await fixture.owner.query(
          'SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked',
          [admissionPid, revokerPid],
        );
        blocked = row.blocked === true;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      releaseAdmission();
      await expect(admission).resolves.toMatchObject({ created: true });
      expect(await revocationOutcome).toEqual({});
      await revoker.commitTransaction();
      const before = await snapshot();
      await expect(
        admit(input({ observedReplyRevision: '2' })),
      ).rejects.toThrow('OMNI_HUMAN_TEXT_COMMAND_MEMBERSHIP_DENIED');
      expect(await snapshot()).toEqual(before);
      expect(await core('omniOutgoingCommand')).toHaveLength(1);
      expect(
        (await audit()).filter((row) => row.outcome === 'denied'),
      ).toHaveLength(1);
      await noDelivery();
    } finally {
      releaseAdmission();
      await admissionOutcome;
      await revocationOutcome;
      if (revoker.isTransactionActive) await revoker.rollbackTransaction();
      await revoker.release();
    }
  });

  it.each([
    'auto',
    'closed',
    'binding-inactive',
    'queue-inactive',
    'policy-corrupt',
  ] as const)(
    'rejects a new intent when current configuration is %s',
    async (kind) => {
      if (kind === 'auto')
        await fixture.owner.query(
          'UPDATE core."omniConversation" SET mode=\'auto\' WHERE id=$1',
          [context.conversationId],
        );
      if (kind === 'closed')
        await fixture.owner.query(
          'UPDATE core."omniConversation" SET status=\'closed\' WHERE id=$1',
          [context.conversationId],
        );
      if (kind === 'binding-inactive')
        await fixture.owner.query(
          'UPDATE core."omniAccountBinding" SET status=\'inactive\' WHERE id=$1',
          [context.bindingId],
        );
      if (kind === 'queue-inactive')
        await fixture.owner.query(
          'UPDATE core."omniQueue" SET active=false WHERE id=$1',
          [context.queueId],
        );
      if (kind === 'policy-corrupt')
        await fixture.owner.query(
          'UPDATE core."omniAutomationPolicyVersion" SET "settingsHash"=$1 WHERE "policyId"=$2',
          ['0'.repeat(64), context.policyId],
        );
      const before = await snapshot();
      await expect(admit()).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      await noDelivery();
    },
  );

  it.each(['expectedControlEpoch', 'observedReplyRevision'] as const)(
    'rejects stale %s for new commands',
    async (field) => {
      const before = await snapshot();
      await expect(admit(input({ [field]: '2' }))).rejects.toThrow(
        field === 'expectedControlEpoch'
          ? 'OMNI_HUMAN_TEXT_COMMAND_STALE_CONTROL'
          : 'OMNI_HUMAN_TEXT_COMMAND_STALE_VIEW',
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  it('allows only one different-key writer for the same observed reply revision', async () => {
    const results = await Promise.allSettled([
      admit(input({ text: 'First' })),
      admit(input({ text: 'Second' })),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((row) => row.status === 'rejected');
    if (!rejected || rejected.status !== 'rejected')
      throw new Error('Expected stale contender');
    expect(errorMessages(rejected.reason)).toContain(
      'OMNI_HUMAN_TEXT_COMMAND_STALE_VIEW',
    );
    expect(await core('omniOutgoingCommand')).toHaveLength(1);
    expect((await core('omniConversation'))[0]).toMatchObject({
      conversationSequence: '1',
      replyRevision: '2',
      nextOutboundSequence: '2',
    });
    expect(
      (await audit()).filter((row) => row.outcome === 'success'),
    ).toHaveLength(5);
  });

  it('fences the global actor/key race across two independently locked Conversations before counters advance', async () => {
    const otherThreadId = randomUUID();
    await fixture.owner.query(
      `INSERT INTO "${fixture.schemaName}"."messageThread" (id,subject) VALUES ($1,'Other conversation')`,
      [otherThreadId],
    );
    const otherConversationId = await fixture.coreInsert('omniConversation', {
      workspaceId: fixture.workspaceId,
      bindingId: context.bindingId,
      providerChatId: 'other-chat',
      messageThreadId: otherThreadId,
      queueId: context.queueId,
      policyId: context.policyId,
      policyVersion: '0',
      mode: 'human',
    });
    const key = randomUUID();
    let waiting = 0;
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const grant: OmniHumanTextCommandAuthorizer = async (scope, request) => {
      await authorize(scope, request);
      waiting += 1;
      if (waiting === 2) release();
      await barrier;
    };
    const results = await Promise.allSettled([
      admit(input({ idempotencyKey: key }), grant).catch((error: unknown) => {
        release();
        throw error;
      }),
      admit(
        input({ conversationId: otherConversationId, idempotencyKey: key }),
        grant,
      ).catch((error: unknown) => {
        release();
        throw error;
      }),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((row) => row.status === 'rejected');
    if (!failed || failed.status !== 'rejected')
      throw new Error('Expected global-key conflict');
    expect(errorMessages(failed.reason)).toContain(
      'OMNI_HUMAN_TEXT_COMMAND_IDEMPOTENCY_CONFLICT',
    );
    const [command] = await core('omniOutgoingCommand');
    expect(await core('omniOutgoingCommand')).toHaveLength(1);
    for (const conversation of await core('omniConversation'))
      expect(conversation).toMatchObject(
        conversation.id === command.conversationId
          ? {
              conversationSequence: '1',
              replyRevision: '2',
              nextOutboundSequence: '2',
            }
          : {
              conversationSequence: '0',
              replyRevision: '1',
              nextOutboundSequence: '1',
            },
      );
    expect(await core('omniRootExecution')).toHaveLength(1);
    expect(await core('omniDomainEvent')).toHaveLength(1);
    await noDelivery();
  });

  it('snapshots the principal and composer input before waiting for a native connection', async () => {
    const original = input();
    const mutable = { ...original };
    const actor = { ...principal };
    const client = await fixture.pool.connect();
    let handoff = false;
    let notify: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      notify = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(fixture.pool, 'connect').mockImplementationOnce(async () => {
      handoff = true;
      notify();
      await gate;
      return client;
    });
    const pending = admit(mutable, authorize, actor);
    try {
      await Promise.race([
        started,
        pending.then(
          (result) => {
            throw new Error('Admission completed before connection barrier', {
              cause: result,
            });
          },
          (error: unknown) => {
            throw new Error('Admission failed before connection barrier', {
              cause: error,
            });
          },
        ),
      ]);
      mutable.text = 'Changed while waiting';
      mutable.idempotencyKey = randomUUID();
      actor.workspaceMemberId = randomUUID();
      release();
      expect(await pending).toMatchObject({ created: true });
      expect((await core('omniOutgoingCommand'))[0]).toMatchObject({
        idempotencyKey: original.idempotencyKey,
        actorId: principal.workspaceMemberId,
        payload: expect.objectContaining({ text: original.text }),
      });
    } finally {
      release();
      await pending.catch(() => undefined);
      if (!handoff) client.release();
    }
  });

  it.each([
    'omniOutgoingCommand',
    'omniConversation',
    'omniRootExecution',
    'omniDomainEvent',
    'omniEventDispatchPlan',
    'crmAuditEntry',
  ])(
    'rolls back the complete intent graph when %s persistence fails',
    async (table) => {
      const schema = table === 'crmAuditEntry' ? 'crm_audit' : 'core';
      const operation = table === 'omniConversation' ? 'UPDATE' : 'INSERT';
      const before = await snapshot();
      await fixture.owner.query(
        `CREATE FUNCTION core.log041_fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${table === 'crmAuditEntry' ? "IF NEW.outcome='success' THEN RAISE EXCEPTION 'fixture human command write failure'; END IF;" : "RAISE EXCEPTION 'fixture human command write failure';"} RETURN NEW; END $$`,
      );
      await fixture.owner.query(
        `CREATE TRIGGER log041_fail_write BEFORE ${operation} ON "${schema}"."${table}" FOR EACH ROW EXECUTE FUNCTION core.log041_fail_write()`,
      );
      try {
        const outcome: unknown = await admit().catch((error: unknown) => error);
        expect(errorMessages(outcome)).toContain(
          'fixture human command write failure',
        );
        expect(await snapshot()).toEqual(before);
        expect(await audit()).toEqual([
          expect.objectContaining({
            outcome: 'failed',
            resourceId: context.conversationId,
            reasonCode: 'command.admit.failed',
          }),
        ]);
        await noDelivery();
      } finally {
        await fixture.owner.query(
          `DROP TRIGGER log041_fail_write ON "${schema}"."${table}"`,
        );
        await fixture.owner.query('DROP FUNCTION core.log041_fail_write()');
      }
    },
  );

  it('keeps a committed intent after a lost COMMIT acknowledgement and replays its key without another command', async () => {
    const command = input();
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
        throw new Error('fixture human command lost COMMIT ACK');
      return result;
    }) as typeof client.query);
    jest
      .spyOn(fixture.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await expect(admit(command)).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
    expect(statements).not.toContain('ROLLBACK');
    expect(await core('omniOutgoingCommand')).toHaveLength(1);
    expect(await audit()).toHaveLength(5);
    expect((await audit()).every((row) => row.outcome === 'success')).toBe(
      true,
    );
    const before = await snapshot();
    const previousAudit = await audit();
    expect(await admit(command)).toMatchObject({ created: false });
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toEqual(previousAudit);
    await noDelivery();
  });
});
