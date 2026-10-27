import { randomUUID } from 'node:crypto';

import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { buildOmniNativeMessageReferences } from 'src/modules/omnichannel/services/build-omni-native-message-references';
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
let captured: Awaited<
  ReturnType<Awaited<ReturnType<typeof fixture.reset>>['capture']>
>;
let originalPeople: unknown[];
let originalThreads: unknown[];
const core = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const audit = (): Promise<Record<string, unknown>[]> =>
  fixture.owner.query('SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id');
const apply = (item = captured, grants = context.callbacks(item.observation)) =>
  fixture.service.applyOmniSentReceipt(context.principal, item.proof, grants);
const snapshot = async () => ({
  messages: await fixture.read('message'),
  participants: await fixture.read('messageParticipant'),
  associations: await fixture.read('messageChannelMessageAssociation'),
  threads: await fixture.read('messageThread'),
  people: await fixture.read('person'),
  targets: await fixture.read('messageThreadTarget'),
  core: await Promise.all(
    [
      'omniOutgoingCommand',
      'omniIncomingReceipt',
      'omniConversation',
      'omniMessageLink',
      'omniMessageRevision',
      'omniDomainEvent',
      'omniRootExecution',
      'omniEventDispatchPlan',
    ].map(core),
  ),
});
const noAutomation = async () => {
  expect(await fixture.read('person')).toEqual(originalPeople);
  expect(await fixture.read('messageThreadTarget')).toEqual([]);
  expect(await core('omniAutomationAdmission')).toEqual([]);
  expect(await core('omniReplyBudget')).toEqual([]);
  expect(await core('omniConsumerReceipt')).toEqual([]);
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
  captured = await context.capture();
  originalPeople = await fixture.read('person');
  originalThreads = await fixture.read('messageThread');
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('atomic native sent-message application', () => {
  it('creates one outgoing bubble from the actual admitted, claimed and accepted command', async () => {
    const priorAudit = await audit();
    const result = await apply();
    expect(result).toMatchObject({
      receiptId: captured.receiptId,
      conversationId: context.conversationId,
      created: true,
      state: 'applied',
    });
    expect(await fixture.read('message')).toEqual([
      expect.objectContaining({
        id: result.messageId,
        messageThreadId: context.threadId,
        text: 'Fixture human intent',
        subject: null,
        isDraft: false,
      }),
    ]);
    expect(await fixture.read('messageParticipant')).toEqual([
      expect.objectContaining({
        messageId: result.messageId,
        role: 'FROM',
        personId: null,
        workspaceMemberId: context.human.workspaceMemberId,
        handle: null,
        displayName: null,
      }),
    ]);
    expect(await fixture.read('messageChannelMessageAssociation')).toEqual([
      expect.objectContaining({
        messageId: result.messageId,
        messageChannelId: context.channelId,
        direction: 'OUTGOING',
      }),
    ]);
    expect(await fixture.read('messageThread')).toEqual(originalThreads);
    expect(await core('omniMessageLink')).toEqual([
      expect.objectContaining({
        id: result.messageLinkId,
        messageId: result.messageId,
        outgoingCommandId: context.commandId,
        nativeMessageKey: captured.observation.capture.nativeMessageKey,
        rawNativeMessageId: captured.observation.envelope.providerMessageId,
        senderProvenance: 'human_direct',
        correlationState: 'command_confirmed',
        authorVerification: 'command_identity',
        sourceAuthorId: null,
        sourceDisplayName: null,
      }),
    ]);
    expect(await core('omniMessageRevision')).toHaveLength(1);
    expect((await core('omniOutgoingCommand'))[0]).toMatchObject({
      state: 'sent',
      statusRevision: '4',
      leaseToken: null,
      leaseUntil: null,
      generation: '1',
    });
    expect((await core('omniConversation'))[0]).toMatchObject({
      conversationSequence: '2',
      replyRevision: '2',
      nextOutboundSequence: '2',
    });
    expect((await core('omniIncomingReceipt'))[0]).toMatchObject({
      state: 'applied',
      resultId: result.messageLinkId,
      leaseOwner: null,
      leaseUntil: null,
    });
    const events = await core('omniDomainEvent');
    expect(events).toHaveLength(2);
    expect(events.filter((row) => row.kind === 'message.sent')).toEqual([
      expect.objectContaining({
        origin: 'connector_outcome',
        conversationSequence: '2',
      }),
    ]);
    expect(await core('omniRootExecution')).toHaveLength(2);
    for (const row of await core('omniRootExecution'))
      expect(row).toMatchObject({
        state: 'suppressed',
        maxCrmEffects: '0',
        maxHops: '0',
        policyVersion: '0',
      });
    expect(await core('omniEventDispatchPlan')).toHaveLength(2);
    for (const row of await core('omniEventDispatchPlan'))
      expect(row).toMatchObject({
        state: 'suppressed',
        targets: [],
        policyVersion: '0',
      });
    const entries = (await audit()).filter(
      (row) => !priorAudit.some((entry) => entry.id === row.id),
    );
    expect(entries).toHaveLength(11);
    expect(entries.every((row) => row.outcome === 'success')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('Fixture human intent');
    await noAutomation();
  });

  it('reauthorizes and reverifies an applied replay without changing any graph or audit', async () => {
    const first = await apply();
    const before = await snapshot();
    const priorAudit = await audit();
    const grants = context.callbacks(captured.observation);
    const authorize = jest.fn(grants.authorize);
    const verifyEvidence = jest.fn(grants.verifyEvidence);
    expect(await apply(captured, { authorize, verifyEvidence })).toEqual({
      ...first,
      created: false,
    });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(verifyEvidence).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toEqual(priorAudit);
  });

  it.each(['same-receipt', 'different-events'] as const)(
    'serializes concurrent %s into one bubble and one sequence increment',
    async (kind) => {
      const second =
        kind === 'same-receipt' ? captured : await context.capture();
      const results = await Promise.all([apply(captured), apply(second)]);
      expect(results.filter((row) => row.created)).toHaveLength(1);
      expect(new Set(results.map((row) => row.messageId)).size).toBe(1);
      expect(new Set(results.map((row) => row.messageLinkId)).size).toBe(1);
      expect(await fixture.read('message')).toHaveLength(1);
      expect(await core('omniMessageLink')).toHaveLength(1);
      expect(await core('omniMessageRevision')).toHaveLength(1);
      expect(
        (await core('omniDomainEvent')).filter(
          (row) => row.kind === 'message.sent',
        ),
      ).toHaveLength(1);
      expect((await core('omniConversation'))[0]).toMatchObject({
        conversationSequence: '2',
        replyRevision: '2',
      });
      for (const row of await core('omniIncomingReceipt'))
        expect(row).toMatchObject({
          state: 'applied',
          resultId: results[0].messageLinkId,
        });
      expect((await audit()).every((row) => row.outcome === 'success')).toBe(
        true,
      );
      await noAutomation();
    },
  );

  it('uses the first receipt capture time when source time is null and never resets it on another event', async () => {
    const first = await context.capture({ occurredAt: null });
    await fixture.owner.query(
      'UPDATE core."omniIncomingReceipt" SET "createdAt"=\'2026-10-27T10:00:00.123456Z\' WHERE id=$1',
      [first.receiptId],
    );
    const result = await apply(first);
    const originalLink = (await core('omniMessageLink'))[0];
    expect(originalLink).toMatchObject({
      displayTimeSource: 'capture',
      displayOccurredAt: new Date('2026-10-27T10:00:00.123456Z'),
    });
    expect((await fixture.read('message'))[0].receivedAt).toEqual(
      originalLink.displayOccurredAt,
    );
    const second = await context.capture({ occurredAt: null });
    await fixture.owner.query(
      'UPDATE core."omniIncomingReceipt" SET "createdAt"=\'2026-10-27T11:00:00.654321Z\' WHERE id=$1',
      [second.receiptId],
    );
    expect(await apply(second)).toMatchObject({
      messageId: result.messageId,
      messageLinkId: result.messageLinkId,
      created: false,
    });
    expect((await core('omniMessageLink'))[0]).toEqual(originalLink);
  });

  it.each(['physical-before', 'physical-after', 'soft-after'] as const)(
    'preserves immutable authorship across %s member deletion',
    async (kind) => {
      if (kind === 'physical-before')
        await fixture.owner.query(
          `DELETE FROM "${fixture.schemaName}"."workspaceMember" WHERE id=$1`,
          [context.human.workspaceMemberId],
        );
      const first = await apply();
      const link = (await core('omniMessageLink'))[0];
      expect(JSON.stringify(link.immutableAuthorSnapshot)).toContain(
        context.human.workspaceMemberId,
      );
      if (kind === 'physical-after')
        await fixture.owner.query(
          `DELETE FROM "${fixture.schemaName}"."workspaceMember" WHERE id=$1`,
          [context.human.workspaceMemberId],
        );
      if (kind === 'soft-after')
        await fixture.owner.query(
          `UPDATE "${fixture.schemaName}"."workspaceMember" SET "deletedAt"=clock_timestamp() WHERE id=$1`,
          [context.human.workspaceMemberId],
        );
      expect((await fixture.read('messageParticipant'))[0]).toMatchObject({
        workspaceMemberId:
          kind === 'soft-after' ? context.human.workspaceMemberId : null,
        personId: null,
        handle: null,
        displayName: null,
      });
      const before = await snapshot();
      const priorAudit = await audit();
      expect(await apply()).toEqual({ ...first, created: false });
      expect(await snapshot()).toEqual(before);
      expect(await audit()).toEqual(priorAudit);
    },
  );

  it.each([
    'inactive-binding',
    'old-generation',
    'revoked-author',
    'unknown-command',
  ] as const)(
    'applies a verified historical outcome with %s without another send',
    async (kind) => {
      if (kind === 'inactive-binding')
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
      if (kind === 'unknown-command')
        await fixture.owner.query(
          'UPDATE core."omniOutgoingCommand" SET state=\'outcome_unknown\' WHERE id=$1',
          [context.commandId],
        );
      expect(await apply()).toMatchObject({ created: true, state: 'applied' });
      expect((await core('omniOutgoingCommand'))[0]).toMatchObject({
        state: 'sent',
        generation: '1',
      });
      await noAutomation();
    },
  );

  it('creates the normalized acceptance fact from verified sent evidence when its ACK was not stored', async () => {
    context = await fixture.reset({ withoutAcceptance: true });
    captured = await context.capture();
    originalPeople = await fixture.read('person');
    originalThreads = await fixture.read('messageThread');
    expect(
      (await core('omniOutgoingCommand'))[0].connectorAcceptedEvidence,
    ).toBeNull();
    await apply();
    expect((await core('omniOutgoingCommand'))[0]).toMatchObject({
      state: 'sent',
      statusRevision: '3',
      connectorJobId: captured.observation.envelope.connectorJobId,
      journalSequence: '1',
      connectorAcceptedEvidence: expect.objectContaining({
        schemaVersion: 1,
        evidenceKind: 'connector.durable_acceptance',
        commandId: context.commandId,
      }),
    });
    await noAutomation();
  });

  it.each(['workspace', 'binding'] as const)(
    'rejects a foreign %s without changing or attributing its graph',
    async (kind) => {
      const principal = { ...context.principal };
      if (kind === 'workspace') principal.workspaceId = randomUUID();
      else principal.bindingId = randomUUID();
      const before = await snapshot();
      const priorAudit = await audit();
      await expect(
        fixture.service.applyOmniSentReceipt(
          principal,
          captured.proof,
          context.callbacks(captured.observation),
        ),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(await audit()).toEqual(priorAudit);
    },
  );

  it.each([
    'leaseOwner',
    'leaseToken',
    'routeGeneration',
    'leaseUntil',
  ] as const)(
    'rejects stale %s ownership without a native write',
    async (field) => {
      const proof = {
        ...captured.proof,
        [field]:
          field === 'leaseOwner'
            ? randomUUID()
            : field === 'leaseUntil'
              ? '2026-10-27T00:00:00.000000Z'
              : '999',
      };
      const before = await snapshot();
      await expect(
        fixture.service.applyOmniSentReceipt(
          context.principal,
          proof,
          context.callbacks(captured.observation),
        ),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(['canonicalPayloadHash', 'trustedCaptureContextHash'] as const)(
    'rejects persisted %s corruption before native creation',
    async (field) => {
      await fixture.owner.query(
        `UPDATE core."omniIncomingReceipt" SET "${field}"=$1 WHERE id=$2`,
        ['0'.repeat(64), captured.receiptId],
      );
      const before = await snapshot();
      await expect(apply()).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(['pending', 'failed', 'cancelled'] as const)(
    'does not overwrite a conflicting %s command',
    async (state) => {
      await fixture.owner.query(
        'UPDATE core."omniOutgoingCommand" SET state=$1 WHERE id=$2',
        [state, context.commandId],
      );
      const before = await snapshot();
      await expect(apply()).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(['connectorJobId', 'journalSequence', 'generation'] as const)(
    'rejects a changed retained %s instead of associating the wrong source',
    async (field) => {
      await fixture.owner.query(
        `UPDATE core."omniOutgoingCommand" SET "${field}"=$1 WHERE id=$2`,
        [field === 'connectorJobId' ? 'other-job' : '2', context.commandId],
      );
      const before = await snapshot();
      await expect(apply()).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(['authorize', 'verifyEvidence'] as const)(
    'requires current %s before first application and replay',
    async (callback) => {
      const grants = {
        ...context.callbacks(captured.observation),
        [callback]: async () => {
          throw new Error(`fixture sent apply ${callback} denied`);
        },
      };
      const before = await snapshot();
      await expect(apply(captured, grants)).rejects.toThrow(
        `fixture sent apply ${callback} denied`,
      );
      expect(await snapshot()).toEqual(before);
      await apply();
      const applied = await snapshot();
      await expect(apply(captured, grants)).rejects.toThrow(
        `fixture sent apply ${callback} denied`,
      );
      expect(await snapshot()).toEqual(applied);
    },
  );

  it.each(['header', 'channel-key'] as const)(
    'does not take over a preexisting native %s',
    async (kind) => {
      const references = buildOmniNativeMessageReferences({
        bindingId: context.bindingId,
        providerChatId: captured.observation.envelope.providerChatId,
        nativeMessageKeyVersion: 1,
        nativeMessageKey: captured.observation.capture.nativeMessageKey,
      });
      const foreignId = randomUUID();
      await fixture.owner.query(
        `INSERT INTO "${fixture.schemaName}"."message" (id,"messageThreadId","headerMessageId",text,subject,"receivedAt","isDraft") VALUES ($1,$2,$3,'Foreign existing body',NULL,clock_timestamp(),false)`,
        [
          foreignId,
          context.threadId,
          kind === 'header' ? references.headerMessageId : 'foreign-header',
        ],
      );
      if (kind === 'channel-key')
        await fixture.owner.query(
          `INSERT INTO "${fixture.schemaName}"."messageChannelMessageAssociation" (id,"messageId","messageChannelId","messageExternalId","messageThreadExternalId",direction) VALUES ($1,$2,$3,$4,$5,'OUTGOING')`,
          [
            randomUUID(),
            foreignId,
            context.channelId,
            references.messageExternalId,
            references.messageThreadExternalId,
          ],
        );
      const before = await snapshot();
      await expect(apply()).rejects.toThrow(
        'OMNI_SENT_APPLY_FOREIGN_NATIVE_IDENTITY',
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(['header', 'thread', 'channel', 'key', 'author'] as const)(
    'detects native or link %s corruption on replay without repairing it silently',
    async (kind) => {
      const result = await apply();
      if (kind === 'header')
        await fixture.owner.query(
          `UPDATE "${fixture.schemaName}"."message" SET "headerMessageId"='different-header' WHERE id=$1`,
          [result.messageId],
        );
      if (kind === 'thread')
        await fixture.owner.query(
          `UPDATE "${fixture.schemaName}"."messageThread" SET "deletedAt"=clock_timestamp() WHERE id=$1`,
          [context.threadId],
        );
      if (kind === 'channel')
        await fixture.owner.query(
          `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociation" SET "messageChannelId"=$1 WHERE "messageId"=$2`,
          [randomUUID(), result.messageId],
        );
      if (kind === 'key')
        await fixture.owner.query(
          'UPDATE core."omniMessageLink" SET "nativeMessageKey"=\'different-key\' WHERE id=$1',
          [result.messageLinkId],
        );
      if (kind === 'author')
        await fixture.owner.query(
          `UPDATE "${fixture.schemaName}"."messageParticipant" SET "handle"='forged@example.test' WHERE "messageId"=$1`,
          [result.messageId],
        );
      const before = await snapshot();
      await expect(apply()).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );

  it('rejects multiple persisted links claiming the same command', async () => {
    await apply();
    await fixture.owner.query(
      `INSERT INTO core."omniMessageLink" SELECT (jsonb_populate_record(NULL::core."omniMessageLink",to_jsonb(link)||jsonb_build_object('id',$2::text,'messageId',$3::text,'nativeMessageKey','second-command-key'))).* FROM core."omniMessageLink" link WHERE "outgoingCommandId"=$1`,
      [context.commandId, randomUUID(), randomUUID()],
    );
    const before = await snapshot();
    await expect(apply()).rejects.toThrow(
      'OMNI_SENT_APPLY_MULTIPLE_COMMAND_LINKS',
    );
    expect(await snapshot()).toEqual(before);
  });

  it('does not silently backfill a sent command whose canonical graph is missing', async () => {
    await fixture.owner.query(
      'UPDATE core."omniOutgoingCommand" SET state=\'sent\' WHERE id=$1',
      [context.commandId],
    );
    const before = await snapshot();
    await expect(apply()).rejects.toThrow('OMNI_SENT_APPLY_SENT_GRAPH_MISSING');
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    'message',
    'messageParticipant',
    'messageChannelMessageAssociation',
    'omniMessageLink',
    'omniMessageRevision',
    'omniConversation',
    'omniRootExecution',
    'omniDomainEvent',
    'omniEventDispatchPlan',
    'omniOutgoingCommand',
    'omniIncomingReceipt',
    'crmAuditEntry',
  ] as const)(
    'rolls back native, command, receipt and graph when %s write fails',
    async (table) => {
      const schema =
        table === 'crmAuditEntry'
          ? 'crm_audit'
          : [
                'message',
                'messageParticipant',
                'messageChannelMessageAssociation',
              ].includes(table)
            ? fixture.schemaName
            : 'core';
      const operation = [
        'omniConversation',
        'omniOutgoingCommand',
        'omniIncomingReceipt',
      ].includes(table)
        ? 'UPDATE'
        : 'INSERT';
      const before = await snapshot();
      const priorAudit = await audit();
      await fixture.owner.query(
        `CREATE FUNCTION core.log045_fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${table === 'crmAuditEntry' ? "IF NEW.outcome='success' THEN RAISE EXCEPTION 'fixture sent apply write failure'; END IF;" : "RAISE EXCEPTION 'fixture sent apply write failure';"} RETURN NEW; END $$`,
      );
      await fixture.owner.query(
        `CREATE TRIGGER log045_fail_write BEFORE ${operation} ON "${schema}"."${table}" FOR EACH ROW EXECUTE FUNCTION core.log045_fail_write()`,
      );
      try {
        const outcome: unknown = await apply().catch((error: unknown) => error);
        expect(errorMessages(outcome)).toContain(
          'fixture sent apply write failure',
        );
        expect(await snapshot()).toEqual(before);
        expect(
          (await audit()).filter(
            (row) => !priorAudit.some((entry) => entry.id === row.id),
          ),
        ).toEqual([
          expect.objectContaining({
            outcome: 'failed',
            resourceId: captured.receiptId,
            reasonCode: 'sent_receipt.apply.failed',
          }),
        ]);
      } finally {
        await fixture.owner.query(
          `DROP TRIGGER log045_fail_write ON "${schema}"."${table}"`,
        );
        await fixture.owner.query('DROP FUNCTION core.log045_fail_write()');
      }
    },
  );

  it.each(['message', 'link'] as const)(
    'detects a silently altered %s after audit and rolls the entire application back',
    async (kind) => {
      const before = await snapshot();
      const priorAudit = await audit();
      const update =
        kind === 'message'
          ? `UPDATE "${fixture.schemaName}"."message" SET text='silently changed body' WHERE id=NEW."resourceId"::uuid;`
          : 'UPDATE core."omniMessageLink" SET "outgoingCommandId"=NULL WHERE id=NEW."resourceId"::uuid;';
      const resourceKind =
        kind === 'message' ? 'omniMessage' : 'omniMessageLink';
      await fixture.owner.query(
        `CREATE FUNCTION core.log045_tamper_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.outcome='success' AND NEW."resourceKind"='${resourceKind}' THEN ${update} END IF; RETURN NEW; END $$`,
      );
      await fixture.owner.query(
        'CREATE TRIGGER log045_tamper_audit AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION core.log045_tamper_audit()',
      );
      try {
        await expect(apply()).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
        expect(
          (await audit()).filter(
            (row) => !priorAudit.some((entry) => entry.id === row.id),
          ),
        ).toEqual([
          expect.objectContaining({
            outcome: 'failed',
            reasonCode: 'sent_receipt.apply.failed',
          }),
        ]);
      } finally {
        await fixture.owner.query(
          'DROP TRIGGER log045_tamper_audit ON crm_audit."crmAuditEntry"',
        );
        await fixture.owner.query('DROP FUNCTION core.log045_tamper_audit()');
      }
    },
  );

  it.each(['native', 'audit'] as const)(
    'rolls back when the receipt lease expires during %s persistence',
    async (stage) => {
      captured = await context.capture({}, {}, 1000);
      const before = await snapshot();
      const priorAudit = await audit();
      const table =
        stage === 'native'
          ? `"${fixture.schemaName}"."messageParticipant"`
          : 'crm_audit."crmAuditEntry"';
      await fixture.owner.query(
        `CREATE FUNCTION core.log045_slow_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${stage === 'audit' ? "IF NEW.outcome='success' AND NEW.\"resourceKind\"='omniIncomingReceipt' THEN PERFORM pg_sleep(1.2); END IF;" : 'PERFORM pg_sleep(1.2);'} RETURN NEW; END $$`,
      );
      await fixture.owner.query(
        `CREATE TRIGGER log045_slow_write BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION core.log045_slow_write()`,
      );
      try {
        const started = Date.now();
        await expect(apply()).rejects.toThrow();
        expect(Date.now() - started).toBeGreaterThanOrEqual(1100);
        expect(await snapshot()).toEqual(before);
        expect(
          (await audit()).filter(
            (row) => !priorAudit.some((entry) => entry.id === row.id),
          ),
        ).toEqual([
          expect.objectContaining({
            outcome: 'failed',
            reasonCode: 'sent_receipt.apply.failed',
          }),
        ]);
      } finally {
        await fixture.owner.query(`DROP TRIGGER log045_slow_write ON ${table}`);
        await fixture.owner.query('DROP FUNCTION core.log045_slow_write()');
      }
    },
  );

  it('recovers a lost COMMIT acknowledgement by replaying the same graph without a second bubble', async () => {
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
        throw new Error('fixture sent apply lost COMMIT ACK');
      return result;
    }) as typeof client.query);
    jest
      .spyOn(fixture.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await expect(apply()).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
    expect(statements).not.toContain('ROLLBACK');
    expect(await fixture.read('message')).toHaveLength(1);
    expect((await core('omniIncomingReceipt'))[0]).toMatchObject({
      state: 'applied',
    });
    expect(
      (await audit()).filter(
        (row) => !priorAudit.some((entry) => entry.id === row.id),
      ),
    ).toHaveLength(11);
    expect((await audit()).every((row) => row.outcome === 'success')).toBe(
      true,
    );
    const committed = await snapshot();
    const committedAudit = await audit();
    expect(await apply()).toMatchObject({ created: false, state: 'applied' });
    expect(await snapshot()).toEqual(committed);
    expect(await audit()).toEqual(committedAudit);
    await noAutomation();
  });
});
