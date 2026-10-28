import { randomUUID } from 'node:crypto';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/datasource/utils/run-in-rollback-safe-transaction.util';
import { type MessageParticipantWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-participant.workspace-entity';
import { omniHistoryApplyOperationId } from 'src/modules/omnichannel/services/apply-omni-history-receipt';
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

const fixture = createOmniHistoryApplyFixture();
let context: Awaited<ReturnType<typeof fixture.reset>>;
let captured: Awaited<ReturnType<typeof fixture.capture>>;
let originalThreads: unknown[];
const core = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const apply = () =>
  fixture.service.applyOmniHistoryReceipt(
    context.principal,
    captured.proof,
    fixture.authorizeFor(context),
  );
const operationAudit = (): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" WHERE "operationId"=$1 ORDER BY id',
    [omniHistoryApplyOperationId(captured.proof.receiptId)],
  );
const tables = [
  'omniMessageLink',
  'omniMessageRevision',
  'omniDomainEvent',
  'omniRootExecution',
  'omniEventDispatchPlan',
] as const;
const canonicalSnapshot = async () => ({
  messages: await fixture.read('message'),
  participants: await fixture.read('messageParticipant'),
  associations: await fixture.read('messageChannelMessageAssociation'),
  threads: await fixture.read('messageThread'),
  core: await Promise.all(
    [...tables, 'omniIncomingReceipt', 'omniConversation'].map(core),
  ),
  audit: await operationAudit(),
});
const expectNoAppliedMutation = async (attempts = 1) => {
  expect(await fixture.read('message')).toEqual([]);
  expect(await fixture.read('messageParticipant')).toEqual([]);
  expect(await fixture.read('messageChannelMessageAssociation')).toEqual([]);
  expect(await fixture.read('messageThread')).toEqual(originalThreads);
  for (const table of tables) expect(await core(table)).toEqual([]);
  expect((await core('omniIncomingReceipt'))[0]).toMatchObject({
    state: 'processing',
    resultId: null,
  });
  expect((await core('omniConversation'))[0]).toMatchObject({
    conversationSequence: '0',
    replyRevision: '1',
  });
  const audit = await operationAudit();
  expect(audit.filter((row) => row.outcome === 'success')).toEqual([]);
  expect(
    audit.filter((row) => row.outcome === 'failed' || row.outcome === 'denied'),
  ).toHaveLength(attempts);
  expect(fixture.eventEmitter).not.toHaveBeenCalled();
};

beforeAll(() => fixture.initialize());
beforeEach(async () => {
  context = await fixture.reset();
  captured = await fixture.capture(context);
  originalThreads = await fixture.read('messageThread');
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('qualified history receipt through actual native messaging composition', () => {
  it('atomically applies the claimed receipt to a bound Person and suppressed durable history event', async () => {
    const result = await apply();
    expect(result).toMatchObject({
      receiptId: captured.proof.receiptId,
      conversationId: context.conversationId,
      created: true,
      state: 'applied',
    });
    expect(await fixture.read('message')).toEqual([
      expect.objectContaining({
        id: result.messageId,
        messageThreadId: context.threadId,
        text: captured.envelope.payload.text,
        subject: null,
        isDraft: false,
      }),
    ]);
    const related = await fixture.dataSource.transaction(
      async (scope) =>
        scope
          .getRepository<MessageParticipantWorkspaceEntity>(
            'messageParticipant',
            { shouldBypassPermissionChecks: true },
          )
          .find({ relations: { person: true, message: true } }),
      { commitOutcome: 'strict' },
    );
    expect(related).toEqual([
      expect.objectContaining({
        personId: context.personId,
        workspaceMemberId: null,
        person: expect.objectContaining({ id: context.personId }),
        message: expect.objectContaining({ id: result.messageId }),
      }),
    ]);
    expect(await fixture.read('messageThread')).toEqual(originalThreads);
    expect((await core('omniIncomingReceipt'))[0]).toMatchObject({
      state: 'applied',
      resultId: result.messageLinkId,
      leaseOwner: null,
      leaseUntil: null,
    });
    expect((await core('omniConversation'))[0]).toMatchObject({
      conversationSequence: '1',
      replyRevision: '2',
    });
    for (const table of tables) expect(await core(table)).toHaveLength(1);
    expect((await core('omniRootExecution'))[0]).toMatchObject({
      origin: 'history_import',
      state: 'suppressed',
      maxCrmEffects: '0',
      usedCrmEffects: '0',
      maxHops: '0',
      usedHops: '0',
      policyVersion: '0',
    });
    expect((await core('omniEventDispatchPlan'))[0]).toMatchObject({
      state: 'suppressed',
      targets: [],
      policyVersion: '0',
      activationVersion: null,
    });
    expect((await core('omniDomainEvent'))[0]).toMatchObject({
      origin: 'history_import',
    });
    for (const table of [
      'omniAutomationAdmission',
      'omniOutgoingCommand',
      'omniConsumerReceipt',
    ])
      expect(await core(table)).toEqual([]);
    const audit = await operationAudit();
    expect(audit).toHaveLength(10);
    expect(audit.every((row) => row.outcome === 'success')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('Private imported body');
    expect(JSON.stringify(audit)).not.toContain('Captured author');
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });

  it('reauthorizes an applied replay and leaves native/core/audit state unchanged', async () => {
    const first = await apply();
    const before = await canonicalSnapshot();
    const authorize = jest.fn(fixture.authorizeFor(context));
    const again = await fixture.service.applyOmniHistoryReceipt(
      context.principal,
      captured.proof,
      authorize,
    );
    expect(again).toEqual({ ...first, created: false });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(await canonicalSnapshot()).toEqual(before);
  });

  it('uses captured receipt time when source occurrence time is absent', async () => {
    await fixture.owner.query(
      'DELETE FROM core."omniIncomingReceipt" WHERE id=$1',
      [captured.proof.receiptId],
    );
    captured = await fixture.capture(context, { occurredAt: null });
    const receipt = (await core('omniIncomingReceipt'))[0];
    await apply();
    expect((await fixture.read('message'))[0].receivedAt).toEqual(
      receipt.createdAt,
    );
    expect((await core('omniMessageLink'))[0]).toMatchObject({
      displayOccurredAt: receipt.createdAt,
      displayTimeSource: 'capture',
    });
  });

  it('serializes simultaneous same-receipt apply into one creation and one authorized replay', async () => {
    const results = await Promise.all([apply(), apply()]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(1);
    expect(results[0].messageId).toBe(results[1].messageId);
    expect(await fixture.read('message')).toHaveLength(1);
    for (const table of tables) expect(await core(table)).toHaveLength(1);
    expect(
      (await operationAudit()).filter((row) => row.outcome !== 'success'),
    ).toEqual([]);
    expect(await operationAudit()).toHaveLength(10);
  });

  it('T01: 20 concurrent deliveries and apply retries retain one receipt/message/link and one success audit set', async () => {
    context = await fixture.reset();
    captured = await fixture.capture(context, {}, 'history_import', 20);
    originalThreads = await fixture.read('messageThread');
    expect(captured.deliveryResults).toHaveLength(20);
    expect(
      captured.deliveryResults.filter((result) => result.created),
    ).toHaveLength(1);
    expect(
      new Set(captured.deliveryResults.map((result) => result.receiptId)).size,
    ).toBe(1);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => apply()),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(19);
    expect(new Set(results.map((result) => result.messageId)).size).toBe(1);
    expect(await core('omniIncomingReceipt')).toHaveLength(1);
    expect(await fixture.read('message')).toHaveLength(1);
    for (const table of tables) expect(await core(table)).toHaveLength(1);
    expect(await fixture.read('messageParticipant')).toEqual([
      expect.objectContaining({
        personId: context.personId,
        messageId: results[0].messageId,
      }),
    ]);
    expect(await fixture.read('messageThread')).toEqual(originalThreads);
    const audit = await operationAudit();
    expect(audit).toHaveLength(10);
    expect(audit.every((row) => row.outcome === 'success')).toBe(true);
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });

  it('snapshots caller data before waiting for workspace context', async () => {
    const principal = {
      ...context.principal,
      actor: { ...context.principal.actor },
    };
    const proof = { ...captured.proof };
    const execute = fixture.manager.executeInWorkspaceContext.bind(
      fixture.manager,
    );
    jest
      .spyOn(fixture.manager, 'executeInWorkspaceContext')
      .mockImplementationOnce((async (...args: Parameters<typeof execute>) => {
        principal.actor.id = 'mutated-actor';
        proof.leaseOwner = randomUUID();
        proof.receiptId = randomUUID();
        await Promise.resolve();
        return execute(...args);
      }) as typeof execute);
    expect(
      await fixture.service.applyOmniHistoryReceipt(
        principal,
        proof,
        fixture.authorizeFor(context),
      ),
    ).toMatchObject({ receiptId: captured.proof.receiptId, created: true });
    expect(JSON.stringify(await operationAudit())).not.toContain(
      'mutated-actor',
    );
  });

  it('does not merge another receipt with conflicting content into an existing canonical message', async () => {
    await apply();
    const firstMessages = await fixture.read('message');
    captured = await fixture.capture(context, {
      payload: {
        text: 'Conflicting body',
        sourceAuthorId: 'history-author',
        sourceDisplayName: 'Captured author',
      },
    });
    await expect(apply()).rejects.toThrow();
    expect(await fixture.read('message')).toEqual(firstMessages);
    expect(await core('omniMessageLink')).toHaveLength(1);
    expect(await core('omniMessageRevision')).toHaveLength(1);
    expect(
      (await core('omniIncomingReceipt')).find(
        (row) => row.id === captured.proof.receiptId,
      ),
    ).toMatchObject({ state: 'processing', resultId: null });
  });

  it.each(['leaseToken', 'leaseOwner', 'routeGeneration'] as const)(
    'rejects stale %s without any canonical writes',
    async (field) => {
      const proof = {
        ...captured.proof,
        [field]: field === 'leaseOwner' ? randomUUID() : '2',
      };
      await expect(
        fixture.service.applyOmniHistoryReceipt(
          context.principal,
          proof,
          fixture.authorizeFor(context),
        ),
      ).rejects.toThrow();
      await expectNoAppliedMutation();
    },
  );

  it('rejects current binding generation drift after claim', async () => {
    await fixture.owner.query(
      'UPDATE core."omniAccountBinding" SET "routeGeneration"=2 WHERE id=$1',
      [context.bindingId],
    );
    await expect(apply()).rejects.toThrow();
    await expectNoAppliedMutation();
  });

  it.each(['trustedCaptureContextHash', 'canonicalPayloadHash'] as const)(
    'rejects modified %s',
    async (field) => {
      await fixture.owner.query(
        `UPDATE core."omniIncomingReceipt" SET "${field}"=$1 WHERE id=$2`,
        ['f'.repeat(64), captured.proof.receiptId],
      );
      await expect(apply()).rejects.toThrow();
      await expectNoAppliedMutation();
    },
  );

  it('rejects an attached application account instead of treating it as the canonical own account', async () => {
    await fixture.owner.query(
      'UPDATE core."connectedAccount" SET "applicationId"=$1 WHERE id=$2',
      [randomUUID(), context.connectedAccountId],
    );
    await expect(apply()).rejects.toThrow();
    await expectNoAppliedMutation();
  });

  it('rejects a deleted bound Person before native message creation', async () => {
    await fixture.owner.query(
      `UPDATE "${fixture.schemaName}".person SET "deletedAt"=clock_timestamp() WHERE id=$1`,
      [context.personId],
    );
    await expect(apply()).rejects.toThrow();
    await expectNoAppliedMutation();
  });

  it('requires current authorization for source to identity mapping', async () => {
    await fixture.owner.query(
      'UPDATE core."omniExternalIdentity" SET "providerPeerId"=$1 WHERE id=$2',
      ['different-author', context.externalIdentityId],
    );
    await expect(apply()).rejects.toThrow();
    await expectNoAppliedMutation();
  });

  it('records denial separately after rollback without changing the receipt state', async () => {
    await expect(
      fixture.service.applyOmniHistoryReceipt(
        context.principal,
        captured.proof,
        async () => {
          throw new Error('fixture denied');
        },
      ),
    ).rejects.toThrow('fixture denied');
    await expectNoAppliedMutation();
    expect((await operationAudit())[0]).toMatchObject({
      outcome: 'denied',
      reasonCode: 'history.apply.denied',
    });
  });

  it('rejects an applied replay after authorization revocation', async () => {
    await apply();
    const messages = await fixture.read('message');
    await expect(
      fixture.service.applyOmniHistoryReceipt(
        context.principal,
        captured.proof,
        async () => {
          throw new Error('fixture revoked');
        },
      ),
    ).rejects.toThrow('fixture revoked');
    expect(await fixture.read('message')).toEqual(messages);
    expect(
      (await operationAudit()).filter((row) => row.outcome === 'success'),
    ).toHaveLength(10);
    expect(
      (await operationAudit()).filter((row) => row.outcome === 'denied'),
    ).toHaveLength(1);
  });

  it.each(['live', 'placeholder', 'legacy'] as const)(
    'rejects unsupported %s provenance without guessing',
    async (kind) => {
      await fixture.owner.query(
        'DELETE FROM core."omniIncomingReceipt" WHERE id=$1',
        [captured.proof.receiptId],
      );
      captured = await fixture.capture(
        context,
        kind === 'placeholder' ? { sourceVariant: 'placeholder' } : {},
        kind === 'live' ? 'live' : kind === 'legacy' ? null : 'history_import',
      );
      await expect(apply()).rejects.toThrow();
      await expectNoAppliedMutation();
    },
  );

  it('keeps native writes invisible to another connection and rolls them back after participant failure', async () => {
    const save = fixture.participants.saveMessageParticipants.bind(
      fixture.participants,
    );
    jest
      .spyOn(fixture.participants, 'saveMessageParticipants')
      .mockImplementationOnce(async (...args) => {
        await save(...args);
        expect(await fixture.read('message')).toEqual([]);
        expect(await fixture.read('messageParticipant')).toEqual([]);
        throw new Error('fixture after participant write');
      });
    await expect(apply()).rejects.toThrow('fixture after participant write');
    await expectNoAppliedMutation();
  });

  it('rejects false native IDs after actual writes and rolls back the entire scope', async () => {
    const save = fixture.participants.saveMessageParticipants.bind(
      fixture.participants,
    );
    jest
      .spyOn(fixture.participants, 'saveMessageParticipants')
      .mockImplementationOnce(async (...args) =>
        (await save(...args)).map((row) => ({ ...row, id: randomUUID() })),
      );
    await expect(apply()).rejects.toThrow();
    await expectNoAppliedMutation();
  });

  it('checks lease expiry after native persistence before committing applied state', async () => {
    const save = fixture.participants.saveMessageParticipants.bind(
      fixture.participants,
    );
    jest
      .spyOn(fixture.participants, 'saveMessageParticipants')
      .mockImplementationOnce(async (...args) => {
        const rows = await save(...args);
        await fixture.owner.query(
          `UPDATE core."omniIncomingReceipt" SET "leaseUntil"=clock_timestamp()-interval '1 second' WHERE id=$1`,
          [captured.proof.receiptId],
        );
        return rows;
      });
    await expect(apply()).rejects.toThrow();
    await expectNoAppliedMutation();
  });

  it.each([...tables, 'crmAuditEntry', 'omniIncomingReceipt'] as const)(
    'rolls back native and core writes when %s persistence fails',
    async (table) => {
      const schema = table === 'crmAuditEntry' ? 'crm_audit' : 'core';
      const raise = "RAISE EXCEPTION 'fixture durable persistence failure';";
      const body =
        table === 'crmAuditEntry'
          ? `IF NEW.outcome='success' THEN ${raise} END IF;`
          : table === 'omniIncomingReceipt'
            ? `IF NEW.state='applied' THEN ${raise} END IF;`
            : raise;
      const event = table === 'omniIncomingReceipt' ? 'UPDATE' : 'INSERT';
      await fixture.owner.query(
        `CREATE FUNCTION core.log033_fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$`,
      );
      await fixture.owner.query(
        `CREATE TRIGGER log033_fail_write BEFORE ${event} ON "${schema}"."${table}" FOR EACH ROW EXECUTE FUNCTION core.log033_fail_write()`,
      );
      try {
        await expect(apply()).rejects.toThrow();
        await expectNoAppliedMutation();
      } finally {
        await fixture.owner.query(
          `DROP TRIGGER log033_fail_write ON "${schema}"."${table}"`,
        );
        await fixture.owner.query('DROP FUNCTION core.log033_fail_write()');
      }
    },
  );

  it('surfaces audit failure and rolls back canonical writes when append permission is absent', async () => {
    await fixture.owner.query(
      `REVOKE INSERT ON crm_audit."crmAuditEntry" FROM "${fixture.roleName}"`,
    );
    try {
      await expect(apply()).rejects.toThrow(
        'OMNI_HISTORY_FAILURE_AUDIT_UNCONFIRMED',
      );
      await expectNoAppliedMutation(0);
    } finally {
      await fixture.owner.query(
        `GRANT INSERT ON crm_audit."crmAuditEntry" TO "${fixture.roleName}"`,
      );
    }
  });

  it('checks lease validity after a slow real audit insert and rolls back all success rows', async () => {
    await fixture.owner.query(
      `CREATE FUNCTION crm_audit.log033_delay_success() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."resourceKind"='omniMessage' AND NEW.outcome='success' THEN PERFORM pg_sleep(2); END IF; RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      `CREATE TRIGGER log033_delay_success BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.log033_delay_success()`,
    );
    await fixture.owner.query(
      `UPDATE core."omniIncomingReceipt" SET "leaseUntil"=clock_timestamp()+interval '1 second' WHERE id=$1`,
      [captured.proof.receiptId],
    );
    try {
      await expect(apply()).rejects.toThrow('LEASE');
      await expectNoAppliedMutation();
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER log033_delay_success ON crm_audit."crmAuditEntry"',
      );
      await fixture.owner.query(
        'DROP FUNCTION crm_audit.log033_delay_success()',
      );
    }
  });

  it('returns unknown after a real COMMIT ACK loss and reconciles the persisted applied result', async () => {
    const client = await fixture.pool.connect();
    const query = client.query.bind(client);
    const statements: string[] = [];
    jest.spyOn(client, 'query').mockImplementation((async (
      sql: string,
      values?: unknown[],
    ) => {
      statements.push(sql);
      const result = await query(sql, values);
      if (sql === 'COMMIT') throw new Error('fixture lost commit ACK');
      return result;
    }) as typeof client.query);
    jest
      .spyOn(fixture.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await expect(apply()).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
    expect(statements).not.toContain('ROLLBACK');
    expect((await core('omniIncomingReceipt'))[0].state).toBe('applied');
    expect(
      (await operationAudit()).filter((row) => row.outcome !== 'success'),
    ).toEqual([]);
    const before = await canonicalSnapshot();
    expect(await apply()).toMatchObject({ state: 'applied', created: false });
    expect(await canonicalSnapshot()).toEqual(before);
  });
});
