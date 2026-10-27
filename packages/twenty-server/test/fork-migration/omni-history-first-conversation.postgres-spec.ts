import { randomUUID } from 'node:crypto';

import { type PoolClient } from 'pg';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { omniHistoryApplyOperationId } from 'src/modules/omnichannel/services/apply-omni-history-receipt';
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
let captured: Awaited<ReturnType<typeof fixture.capture>>;
const core = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const authorize = () =>
  fixture.authorizeFor(context, { allowNewConversation: true });
const apply = () =>
  fixture.service.applyOmniHistoryReceipt(
    context.principal,
    captured.proof,
    authorize(),
  );
const process = () =>
  fixture.service.processOmniHistoryReceipt(
    context.principal,
    captured.proof,
    authorize(),
    async () => undefined,
  );
const audit = (): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" WHERE "operationId"=$1 ORDER BY id',
    [omniHistoryApplyOperationId(captured.proof.receiptId)],
  );
const projectionTables = [
  'omniMessageLink',
  'omniMessageRevision',
  'omniConversation',
  'omniRootExecution',
  'omniDomainEvent',
  'omniEventDispatchPlan',
] as const;
const snapshot = async () => ({
  native: await Promise.all(
    [
      'messageThread',
      'message',
      'messageParticipant',
      'messageChannelMessageAssociation',
      'messageThreadTarget',
    ].map((table) =>
      fixture.owner.query(
        `SELECT * FROM "${fixture.schemaName}"."${table}" ORDER BY id`,
      ),
    ),
  ),
  core: await Promise.all(projectionTables.map(core)),
  receipt: await core('omniIncomingReceipt'),
  audit: await audit(),
});
const noProjection = async () => {
  for (const table of projectionTables) expect(await core(table)).toEqual([]);
  for (const table of [
    'messageThread',
    'message',
    'messageParticipant',
    'messageChannelMessageAssociation',
    'messageThreadTarget',
  ] as const)
    expect(await fixture.read(table)).toEqual([]);
  expect(await fixture.read('person')).toHaveLength(1);
  expect((await audit()).filter((row) => row.outcome === 'success')).toEqual(
    [],
  );
  expect(fixture.eventEmitter).not.toHaveBeenCalled();
};

beforeAll(() => fixture.initialize());
beforeEach(async () => {
  context = await fixture.reset({ withoutConversation: true });
  captured = await fixture.capture(context);
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('first qualified history receipt creates one native conversation graph', () => {
  it('creates one Thread and Conversation with default queue, one existing Person and suppressed sequence1/2 events', async () => {
    const result = await apply();
    const [conversation] = await core('omniConversation');
    const [thread] = await fixture.read('messageThread');
    expect(result).toMatchObject({
      state: 'applied',
      created: true,
      conversationId: conversation.id,
    });
    expect(conversation).toMatchObject({
      messageThreadId: thread.id,
      queueId: context.queueId,
      mode: 'human',
      policyVersion: '0',
      conversationSequence: '2',
      replyRevision: '2',
    });
    expect(await fixture.read('person')).toEqual([
      expect.objectContaining({ id: context.personId }),
    ]);
    expect(await fixture.read('message')).toEqual([
      expect.objectContaining({
        id: result.messageId,
        messageThreadId: thread.id,
      }),
    ]);
    expect(await fixture.read('messageParticipant')).toEqual([
      expect.objectContaining({
        messageId: result.messageId,
        personId: context.personId,
        workspaceMemberId: null,
      }),
    ]);
    const events = (await core('omniDomainEvent')).sort(
      (left, right) =>
        Number(left.conversationSequence) - Number(right.conversationSequence),
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'conversation.created',
        conversationSequence: '1',
        origin: 'history_import',
        causationId: null,
      }),
      expect.objectContaining({
        kind: 'message.received',
        conversationSequence: '2',
        origin: 'history_import',
        causationId: null,
      }),
    ]);
    expect(await core('omniRootExecution')).toEqual([
      expect.objectContaining({
        state: 'suppressed',
        origin: 'history_import',
        maxCrmEffects: '0',
        maxHops: '0',
        policyVersion: '0',
      }),
      expect.objectContaining({
        state: 'suppressed',
        origin: 'history_import',
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
      expect.objectContaining({
        state: 'suppressed',
        targets: [],
        policyVersion: '0',
      }),
    ]);
    for (const table of [
      'omniConversationTarget',
      'omniAutomationAdmission',
      'omniOutgoingCommand',
      'omniConsumerReceipt',
    ])
      expect(await core(table)).toEqual([]);
    expect(await fixture.read('messageThreadTarget')).toEqual([]);
    expect(await audit()).toHaveLength(14);
    expect((await audit()).every((row) => row.outcome === 'success')).toBe(
      true,
    );
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });

  it('serializes two first receipts for the same chat into one Conversation and two Messages', async () => {
    const second = await fixture.capture(context, {
      providerMessageId: 'history-message-2',
    });
    const results = await Promise.all([
      apply(),
      fixture.service.applyOmniHistoryReceipt(
        context.principal,
        second.proof,
        authorize(),
      ),
    ]);
    expect(results[0].conversationId).toBe(results[1].conversationId);
    expect(results[0].messageId).not.toBe(results[1].messageId);
    expect(await core('omniConversation')).toHaveLength(1);
    expect(await fixture.read('messageThread')).toHaveLength(1);
    expect(await fixture.read('message')).toHaveLength(2);
    const events = (await core('omniDomainEvent')).sort(
      (left, right) =>
        Number(left.conversationSequence) - Number(right.conversationSequence),
    );
    expect(events.map((row) => [row.kind, row.conversationSequence])).toEqual([
      ['conversation.created', '1'],
      ['message.received', '2'],
      ['message.received', '3'],
    ]);
    expect((await core('omniConversation'))[0]).toMatchObject({
      conversationSequence: '3',
      replyRevision: '3',
    });
    expect(
      (await core('omniIncomingReceipt')).every(
        (row) => row.state === 'applied',
      ),
    ).toBe(true);
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });

  it('replays the same first receipt without additional Thread, Conversation or creation effects', async () => {
    const first = await apply();
    const before = await snapshot();
    expect(await apply()).toEqual({ ...first, created: false });
    expect(await snapshot()).toEqual(before);
  });

  it('rejects a foreign Thread inserted after the initial absence check instead of auditing it as newly created', async () => {
    let foreignThreadId: string | undefined;
    await expect(
      fixture.service.applyOmniHistoryReceipt(
        context.principal,
        captured.proof,
        async (scope, authorization) => {
          await authorize()(scope, authorization);
          const rows = await scope.executeRawQuery(
            'SELECT "messageThreadId" FROM core."omniConversation" WHERE "workspaceId"=$1 AND id=$2',
            [fixture.workspaceId, authorization.conversationId],
          );
          const threadId = rows[0]?.messageThreadId;
          if (rows.length !== 1 || typeof threadId !== 'string')
            throw new Error('Fixture reserved Conversation missing');
          foreignThreadId = threadId;
          await fixture.owner.query(
            `INSERT INTO "${fixture.schemaName}"."messageThread" (id, subject) VALUES ($1,NULL)`,
            [threadId],
          );
        },
      ),
    ).rejects.toThrow('OMNI_HISTORY_NATIVE_THREAD_CREATION_POSTCONDITION');
    expect(foreignThreadId).toBeDefined();
    expect(await fixture.read('messageThread')).toEqual([
      expect.objectContaining({ id: foreignThreadId, subject: null }),
    ]);
    for (const table of projectionTables) expect(await core(table)).toEqual([]);
    for (const table of [
      'message',
      'messageParticipant',
      'messageChannelMessageAssociation',
      'messageThreadTarget',
    ] as const)
      expect(await fixture.read(table)).toEqual([]);
    expect((await core('omniIncomingReceipt'))[0].state).toBe('processing');
    expect((await audit()).filter((row) => row.outcome === 'success')).toEqual(
      [],
    );
    expect(
      (await audit()).filter((row) => row.outcome === 'failed'),
    ).toHaveLength(1);
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });

  it('reconciles an actual lost COMMIT acknowledgement without duplicate creation', async () => {
    const client = await fixture.pool.connect();
    const query = client.query.bind(client);
    const statements: string[] = [];
    jest.spyOn(client, 'query').mockImplementation((async (
      sql: string,
      values?: unknown[],
    ) => {
      statements.push(sql);
      const result = await query(sql, values);
      if (sql === 'COMMIT') throw new Error('fixture lost first commit ACK');
      return result;
    }) as typeof client.query);
    jest
      .spyOn(fixture.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await expect(process()).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
    expect(statements).not.toContain('ROLLBACK');
    expect((await core('omniIncomingReceipt'))[0].state).toBe('applied');
    expect((await audit()).filter((row) => row.outcome !== 'success')).toEqual(
      [],
    );
    const before = await snapshot();
    expect(await apply()).toMatchObject({ created: false });
    expect(await snapshot()).toEqual(before);
  });

  it('rejects a foreign-thread Message inserted between domain precheck and real native helper lookup', async () => {
    context = await fixture.reset();
    captured = await fixture.capture(context);
    const foreignMessageId = randomUUID();
    const foreignThreadId = randomUUID();
    await fixture.owner.query(
      `INSERT INTO "${fixture.schemaName}"."messageThread" (id,subject) VALUES ($1,'Foreign thread')`,
      [foreignThreadId],
    );
    const threads = await fixture.read('messageThread');
    const conversations = await core('omniConversation');
    const save = fixture.messages.saveMessagesWithinTransaction.bind(
      fixture.messages,
    );
    jest
      .spyOn(fixture.messages, 'saveMessagesWithinTransaction')
      .mockImplementationOnce(async (...args) => {
        const [incoming] = args[0];
        await fixture.owner.query(
          `INSERT INTO "${fixture.schemaName}"."message" (id,"messageThreadId","headerMessageId",subject,text,"receivedAt","isDraft") VALUES ($1,$2,$3,$4,$5,$6,false)`,
          [
            foreignMessageId,
            foreignThreadId,
            incoming.headerMessageId,
            incoming.subject,
            incoming.text,
            incoming.receivedAt,
          ],
        );
        return save(...args);
      });
    await expect(process()).rejects.toThrow(
      'Canonical message thread conflicts with existing messages',
    );
    expect(await fixture.read('message')).toEqual([
      expect.objectContaining({
        id: foreignMessageId,
        messageThreadId: foreignThreadId,
      }),
    ]);
    expect(await fixture.read('messageThread')).toEqual(threads);
    expect(await core('omniConversation')).toEqual(conversations);
    for (const table of [
      'messageParticipant',
      'messageChannelMessageAssociation',
      'messageThreadTarget',
    ] as const)
      expect(await fixture.read(table)).toEqual([]);
    for (const table of [
      'omniMessageLink',
      'omniMessageRevision',
      'omniDomainEvent',
      'omniRootExecution',
      'omniEventDispatchPlan',
    ])
      expect(await core(table)).toEqual([]);
    expect((await audit()).filter((row) => row.outcome === 'success')).toEqual(
      [],
    );
    expect(
      (await audit()).filter((row) => row.outcome === 'failed'),
    ).toHaveLength(1);
    expect((await core('omniIncomingReceipt'))[0].state).toBe('processing');
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });

  it.each(['missing', 'deleted'] as const)(
    'does not repair an existing Conversation with a %s native Thread',
    async (kind) => {
      context = await fixture.reset();
      captured = await fixture.capture(context);
      await fixture.owner.query(
        kind === 'missing'
          ? `DELETE FROM "${fixture.schemaName}"."messageThread" WHERE id=$1`
          : `UPDATE "${fixture.schemaName}"."messageThread" SET "deletedAt"=clock_timestamp() WHERE id=$1`,
        [context.threadId],
      );
      const conversations = await core('omniConversation');
      const threads = await fixture.read('messageThread');
      await expect(process()).rejects.toThrow();
      expect(await core('omniConversation')).toEqual(conversations);
      expect(await fixture.read('messageThread')).toEqual(threads);
      expect(await fixture.read('message')).toEqual([]);
      expect((await core('omniIncomingReceipt'))[0].state).toBe('processing');
    },
  );

  it('does not reconstruct a missing Conversation for a previously applied receipt', async () => {
    await apply();
    for (const table of [
      'omniEventDispatchPlan',
      'omniDomainEvent',
      'omniRootExecution',
      'omniMessageRevision',
      'omniMessageLink',
      'omniConversation',
    ])
      await fixture.owner.query(`DELETE FROM core."${table}"`);
    const threads = await fixture.read('messageThread');
    const messages = await fixture.read('message');
    await expect(process()).rejects.toThrow();
    expect(await core('omniConversation')).toEqual([]);
    expect(await fixture.read('messageThread')).toEqual(threads);
    expect(await fixture.read('message')).toEqual(messages);
    expect((await core('omniIncomingReceipt'))[0].state).toBe('applied');
  });

  it.each(['queue', 'assist', 'auto'] as const)(
    'persists blocked_config for invalid %s defaults only after confirmed native rollback',
    async (configuration) => {
      if (configuration === 'queue')
        await fixture.owner.query(
          'UPDATE core."omniQueue" SET active=false WHERE id=$1',
          [context.queueId],
        );
      else
        await fixture.owner.query(
          'UPDATE core."omniAccountBinding" SET "defaultConversationMode"=$1 WHERE id=$2',
          [configuration, context.bindingId],
        );
      const before = (await core('omniIncomingReceipt'))[0];
      expect(await process()).toMatchObject({
        receiptId: captured.proof.receiptId,
        state: 'blocked_config',
        errorCode: 'configuration_missing',
      });
      await noProjection();
      expect((await core('omniIncomingReceipt'))[0]).toMatchObject({
        state: 'blocked_config',
        leaseOwner: null,
        leaseUntil: null,
        leaseToken: before.leaseToken,
        validatedEnvelope: before.validatedEnvelope,
        trustedCaptureContextHash: before.trustedCaptureContextHash,
      });
      expect(
        await claimOmniIncomingReceipts(
          fixture.runtime,
          context.principal,
          { leaseOwner: randomUUID(), limit: 1, leaseMilliseconds: 300000 },
          async () => undefined,
        ),
      ).toEqual([]);
    },
  );

  it('does not turn current history authorization denial into a configuration defer', async () => {
    const leaseAuthorize = jest.fn(async () => undefined);
    await expect(
      fixture.service.processOmniHistoryReceipt(
        context.principal,
        captured.proof,
        async () => {
          throw new Error('fixture history denied');
        },
        leaseAuthorize,
      ),
    ).rejects.toThrow('fixture history denied');
    await noProjection();
    expect(leaseAuthorize).not.toHaveBeenCalled();
    expect((await core('omniIncomingReceipt'))[0].state).toBe('processing');
    expect((await audit())[0].outcome).toBe('denied');
  });

  it('does not clear the lease when fresh defer authorization is denied', async () => {
    await fixture.owner.query(
      'UPDATE core."omniQueue" SET active=false WHERE id=$1',
      [context.queueId],
    );
    await expect(
      fixture.service.processOmniHistoryReceipt(
        context.principal,
        captured.proof,
        authorize(),
        async () => {
          throw new Error('fixture defer denied');
        },
      ),
    ).rejects.toThrow('fixture defer denied');
    await noProjection();
    expect((await core('omniIncomingReceipt'))[0]).toMatchObject({
      state: 'processing',
      leaseOwner: captured.proof.leaseOwner,
      leaseToken: captured.proof.leaseToken,
    });
  });

  it.each([
    'messageThread',
    'omniConversation',
    'omniRootExecution',
    'omniDomainEvent',
    'omniEventDispatchPlan',
    'crmAuditEntry',
  ] as const)(
    'rolls back first-conversation creation if %s persistence fails',
    async (table) => {
      const schema =
        table === 'messageThread'
          ? fixture.schemaName
          : table === 'crmAuditEntry'
            ? 'crm_audit'
            : 'core';
      const raise =
        "RAISE EXCEPTION 'fixture first creation persistence failure';";
      const body =
        table === 'crmAuditEntry'
          ? `IF NEW.outcome='success' THEN ${raise} END IF;`
          : raise;
      await fixture.owner.query(
        `CREATE FUNCTION core.log036_fail_creation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$`,
      );
      await fixture.owner.query(
        `CREATE TRIGGER log036_fail_creation BEFORE INSERT ON "${schema}"."${table}" FOR EACH ROW EXECUTE FUNCTION core.log036_fail_creation()`,
      );
      try {
        await expect(process()).rejects.toThrow();
        await noProjection();
        expect((await core('omniIncomingReceipt'))[0].state).toBe('processing');
        expect(
          (await audit()).filter((row) => row.outcome === 'failed'),
        ).toHaveLength(1);
      } finally {
        await fixture.owner.query(
          `DROP TRIGGER log036_fail_creation ON "${schema}"."${table}"`,
        );
        await fixture.owner.query('DROP FUNCTION core.log036_fail_creation()');
      }
    },
  );

  it('rolls back Thread and Conversation if the lease expires while success audit is being written', async () => {
    await fixture.owner.query(
      `CREATE FUNCTION crm_audit.log036_delay_creation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."resourceKind"='omniMessageThread' AND NEW.outcome='success' THEN PERFORM pg_sleep(2); END IF; RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      'CREATE TRIGGER log036_delay_creation BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.log036_delay_creation()',
    );
    await fixture.owner.query(
      `UPDATE core."omniIncomingReceipt" SET "leaseUntil"=clock_timestamp()+interval '1 second' WHERE id=$1`,
      [captured.proof.receiptId],
    );
    try {
      await expect(process()).rejects.toThrow('LEASE');
      await noProjection();
      expect((await core('omniIncomingReceipt'))[0].state).toBe('processing');
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER log036_delay_creation ON crm_audit."crmAuditEntry"',
      );
      await fixture.owner.query(
        'DROP FUNCTION crm_audit.log036_delay_creation()',
      );
    }
  });

  it('rereads defaults after waiting for the workspace policy writer', async () => {
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
      const acquiredClient = client;
      const nativeSession = await acquiredClient.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      const query = acquiredClient.query.bind(acquiredClient);
      let notifyStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      jest.spyOn(acquiredClient, 'query').mockImplementation((async (
        sql: string | { text: string; values?: unknown[] },
        values?: unknown[],
      ) => {
        const text = typeof sql === 'string' ? sql : sql.text;
        if (text.includes('omniWorkspacePolicyState')) notifyStarted();
        return query(sql, values);
      }) as typeof acquiredClient.query);
      jest.spyOn(fixture.pool, 'connect').mockImplementationOnce(() => {
        handedToRuntime = true;
        return Promise.resolve(acquiredClient);
      });
      const outcome = process().then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      pendingOutcome = outcome;
      await Promise.race([
        started,
        outcome.then((settled) => {
          throw new Error('Apply settled before policy-lock barrier', {
            cause: 'error' in settled ? settled.error : settled.result,
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
        result: { state: 'blocked_config' },
      });
      await noProjection();
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await writer.release();
      if (client && !handedToRuntime) client.release();
      await pendingOutcome;
    }
  });
});
