import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/datasource/utils/run-in-rollback-safe-transaction.util';
import { randomUUID } from 'node:crypto';
import { type OmniIncomingRevisionAdapter } from 'src/modules/omnichannel/contracts/omni-incoming-text-revision';
import { type OmniHistoryApplyAuthorizer } from 'src/modules/omnichannel/services/apply-omni-history-receipt';
import { omniIncomingTextApplyOperationId } from 'src/modules/omnichannel/services/load-omni-incoming-revision-chain';
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
type Captured = Awaited<ReturnType<typeof fixture.capture>>;
const adapter: OmniIncomingRevisionAdapter = {
  adapterId: 'fixture-history',
  adapterVersion: '1',
  revisionKey: ({ envelope }) =>
    `${envelope.sourcePosition?.type}:${envelope.sourcePosition?.value}:${envelope.kind}:${envelope.sourceVariant}`,
  compare: (candidate, current) => {
    const a = candidate.envelope.sourcePosition,
      b = current.envelope.sourcePosition;
    if (
      a?.type !== 'journal' ||
      b?.type !== 'journal' ||
      !/^\d+$/.test(a.value) ||
      !/^\d+$/.test(b.value)
    )
      return 'incomparable';
    if (BigInt(a.value) > BigInt(b.value)) return 'newer';
    if (BigInt(a.value) < BigInt(b.value)) return 'older';
    if (
      current.envelope.sourceVariant === 'placeholder' &&
      candidate.envelope.sourceVariant === 'complete'
    )
      return 'newer';
    return 'equal';
  },
};
const authorize: OmniHistoryApplyAuthorizer = async (_scope, facts) => {
  if (
    facts.action !== 'incoming.text.apply' ||
    facts.workspaceId !== fixture.workspaceId ||
    facts.bindingId !== context.bindingId ||
    facts.queueId !== context.queueId ||
    facts.externalIdentityId !== context.externalIdentityId ||
    facts.personId !== context.personId ||
    facts.providerPeerId !== 'history-author' ||
    facts.verificationSource !== 'fixture-confirmed' ||
    facts.envelope.providerChatId !== 'history-chat'
  )
    throw new Error('FIXTURE_INCOMING_DENIED');
};
const capture = (
  position: number,
  kind = 'message.received',
  text: string | null = 'body',
  variant = 'complete',
) =>
  fixture.capture(
    context,
    {
      kind,
      sourcePosition: { type: 'journal', value: String(position) },
      sourceVariant: variant,
      payload: {
        text,
        sourceAuthorId: 'history-author',
        sourceDisplayName: 'Captured author',
      },
    },
    'live',
  );
const apply = (captured: Captured, selectedAdapter = adapter) =>
  fixture.service.applyOmniIncomingTextReceipt(
    context.principal,
    captured.proof,
    authorize,
    selectedAdapter,
  );
const process = (captured: Captured, selectedAdapter = adapter) =>
  fixture.service.processOmniIncomingTextReceipt(
    context.principal,
    captured.proof,
    authorize,
    selectedAdapter,
    async () => undefined,
  );
const core = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const snapshot = async () => ({
  messages: await fixture.read('message'),
  participants: await fixture.read('messageParticipant'),
  associations: await fixture.read('messageChannelMessageAssociation'),
  threads: await fixture.read('messageThread'),
  core: await Promise.all(
    [
      'omniMessageLink',
      'omniMessageRevision',
      'omniConversation',
      'omniDomainEvent',
      'omniRootExecution',
      'omniEventDispatchPlan',
      'omniIncomingReceipt',
    ].map(core),
  ),
  success: await fixture.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" WHERE outcome=\'success\' ORDER BY id',
  ),
});
const audit = (captured: Captured): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" WHERE "operationId"=$1 ORDER BY id',
    [omniIncomingTextApplyOperationId(captured.proof.receiptId)],
  );
beforeAll(() => fixture.initialize());
beforeEach(async () => {
  context = await fixture.reset();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('qualified incoming revisions through actual native composition', () => {
  it('creates, edits, deletes one native message and replays retained outcomes without restoring old text', async () => {
    const first = await capture(1);
    const created = await apply(first);
    const original = (await fixture.read('message'))[0];
    const authors = await fixture.read('messageParticipant');
    const edit = await capture(2, 'message.edited', 'edited');
    const changed = await apply(edit);
    expect(changed.applicationResult.disposition).toBe('advanced');
    expect(changed.messageId).toBe(created.messageId);
    const deletion = await capture(3, 'message.deleted', null);
    await apply(deletion);
    expect(await fixture.read('message')).toEqual([
      { ...original, text: null, updatedAt: expect.anything() },
    ]);
    expect(await fixture.read('messageParticipant')).toEqual(authors);
    expect(await core('omniMessageRevision')).toHaveLength(3);
    expect((await core('omniConversation'))[0]).toMatchObject({
      replyRevision: '4',
      conversationSequence: '3',
    });
    const before = await snapshot();
    for (const item of [first, edit, deletion])
      expect((await apply(item)).replayed).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(
      (await core('omniRootExecution')).every(
        (row) => row.state === 'suppressed',
      ),
    ).toBe(true);
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'fills a placeholder in existing/new conversation=%s with one canonical message',
    async (newConversation) => {
      if (newConversation)
        context = await fixture.reset({ withoutConversation: true });
      const placeholder = await capture(
        1,
        'message.received',
        null,
        'placeholder',
      );
      const first = await apply(placeholder);
      expect((await fixture.read('message'))[0].text).toBeNull();
      const filled = await capture(1, 'message.received', 'filled');
      const result = await apply(filled);
      expect(result.messageId).toBe(first.messageId);
      expect(result.applicationResult.disposition).toBe('advanced');
      expect(await fixture.read('message')).toHaveLength(1);
      expect((await fixture.read('message'))[0].text).toBe('filled');
      expect(await core('omniMessageRevision')).toHaveLength(2);
      const before = await snapshot();
      await apply(placeholder);
      await apply(filled);
      expect(await snapshot()).toEqual(before);
    },
  );
  it('persists delete-before-create and treats late create as stale without resurrecting body', async () => {
    const deletion = await capture(4, 'message.deleted', null);
    const first = await apply(deletion);
    const late = await capture(1);
    const result = await apply(late);
    expect(result.messageId).toBe(first.messageId);
    expect(result.applicationResult.disposition).toBe('stale');
    expect((await fixture.read('message'))[0]).toMatchObject({
      text: null,
      deletedAt: null,
    });
    expect(await core('omniMessageRevision')).toHaveLength(1);
    expect(await core('omniDomainEvent')).toHaveLength(1);
    const before = await snapshot();
    await apply(late);
    expect(await snapshot()).toEqual(before);
  });
  it('stores duplicate outcome selecting an older revision, preserving it after further edits', async () => {
    const first = await capture(1);
    await apply(first);
    await apply(await capture(3, 'message.edited', 'third'));
    const duplicate = await capture(1);
    const result = await apply(duplicate);
    expect(result.applicationResult.disposition).toBe('duplicate');
    expect(result.applicationResult.selectedRevisionId).not.toBe(
      result.applicationResult.observedHeadRevisionId,
    );
    expect(
      (await audit(duplicate)).filter((row) => row.outcome === 'success'),
    ).toHaveLength(1);
    await apply(await capture(4, 'message.edited', 'fourth'));
    const before = await snapshot();
    expect((await apply(duplicate)).applicationResult).toEqual(
      result.applicationResult,
    );
    expect(await snapshot()).toEqual(before);
  });
  it('stores stale decision and replays it after another head without new mutation or audit', async () => {
    await apply(await capture(3));
    const stale = await capture(2, 'message.edited', 'old');
    const result = await apply(stale);
    expect(result.applicationResult.disposition).toBe('stale');
    await apply(await capture(4, 'message.edited', 'new'));
    const before = await snapshot();
    expect((await apply(stale)).applicationResult).toEqual(
      result.applicationResult,
    );
    expect(await snapshot()).toEqual(before);
    expect(
      (await audit(stale)).filter((row) => row.outcome === 'success'),
    ).toHaveLength(1);
  });
  it.each(['conflict', 'incomparable', 'equal-key-change', 'resurrection'])(
    'quarantines %s only after rollback',
    async (kind) => {
      await apply(
        await capture(
          2,
          kind === 'resurrection' ? 'message.deleted' : 'message.received',
          kind === 'resurrection' ? null : 'body',
        ),
      );
      const candidate = await capture(
        kind === 'conflict' ? 2 : 3,
        kind === 'conflict' ? 'message.received' : 'message.edited',
        'different',
      );
      const before = await fixture.read('message');
      const selected =
        kind === 'incomparable'
          ? { ...adapter, compare: () => 'incomparable' as const }
          : kind === 'equal-key-change'
            ? { ...adapter, compare: () => 'equal' as const }
            : adapter;
      expect(await process(candidate, selected)).toMatchObject({
        state: 'quarantined',
        errorCode: 'inconsistent_source',
      });
      expect(await fixture.read('message')).toEqual(before);
      expect(await core('omniMessageRevision')).toHaveLength(1);
      expect(
        (await audit(candidate)).filter((row) => row.outcome === 'success'),
      ).toEqual([]);
    },
  );
  it.each([false, true])(
    'edits legacy initial with null head=%s and keeps old history replay read-only',
    async (legacyNull) => {
      const initial = await fixture.capture(context);
      const first = await fixture.service.applyOmniHistoryReceipt(
        context.principal,
        initial.proof,
        fixture.authorizeFor(context),
      );
      if (legacyNull)
        await fixture.owner.query(
          'UPDATE core."omniMessageLink" SET "currentRevisionId"=NULL',
        );
      const edited = await capture(13, 'message.edited', 'new');
      await apply(edited);
      const deletion = await capture(14, 'message.deleted', null);
      await apply(deletion);
      const before = await snapshot();
      expect(
        await fixture.service.applyOmniHistoryReceipt(
          context.principal,
          initial.proof,
          fixture.authorizeFor(context),
        ),
      ).toEqual({ ...first, created: false });
      expect(await snapshot()).toEqual(before);
    },
  );
  it('serializes 20 same-receipt writers into one creation and 19 replays', async () => {
    const receipt = await capture(1);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => apply(receipt)),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(19);
    expect(await fixture.read('message')).toHaveLength(1);
    expect(await core('omniMessageRevision')).toHaveLength(1);
  });
  it('serializes different ordered edits and retains highest source revision', async () => {
    await apply(await capture(1));
    const a = await capture(2, 'message.edited', 'second');
    const b = await capture(3, 'message.edited', 'third');
    await Promise.all([apply(b), apply(a)]);
    expect((await fixture.read('message'))[0].text).toBe('third');
    const before = await snapshot();
    await apply(a);
    await apply(b);
    expect(await snapshot()).toEqual(before);
  });
  it.each(['audit', 'receipt', 'head'])(
    'rolls back text, revision and counters on %s failure',
    async (boundary) => {
      await apply(await capture(1));
      const candidate = await capture(2, 'message.edited', 'new');
      const before = await snapshot();
      const schema = boundary === 'audit' ? 'crm_audit' : 'core';
      const table =
        boundary === 'audit'
          ? 'crmAuditEntry'
          : boundary === 'receipt'
            ? 'omniIncomingReceipt'
            : 'omniMessageLink';
      const event = boundary === 'audit' ? 'INSERT' : 'UPDATE';
      const condition =
        boundary === 'audit'
          ? "NEW.outcome='success'"
          : boundary === 'receipt'
            ? "NEW.state='applied'"
            : 'true';
      await fixture.owner.query(
        `CREATE FUNCTION core.fail_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'revision failure'; END IF; RETURN NEW; END $$`,
      );
      await fixture.owner.query(
        `CREATE TRIGGER fail_revision BEFORE ${event} ON "${schema}"."${table}" FOR EACH ROW EXECUTE FUNCTION core.fail_revision()`,
      );
      try {
        await expect(apply(candidate)).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
      } finally {
        await fixture.owner.query(
          `DROP TRIGGER fail_revision ON "${schema}"."${table}"`,
        );
        await fixture.owner.query('DROP FUNCTION core.fail_revision()');
      }
    },
  );
  it('rejects current authorization before edit and before replay', async () => {
    const first = await capture(1);
    await apply(first);
    const before = await snapshot();
    await expect(
      fixture.service.applyOmniIncomingTextReceipt(
        context.principal,
        first.proof,
        async () => {
          throw new Error('revoked');
        },
        adapter,
      ),
    ).rejects.toThrow('revoked');
    expect(await snapshot()).toEqual(before);
  });
  it('preserves initial author display and display timestamp across edit', async () => {
    const first = await capture(1);
    await apply(first);
    const authors = await fixture.read('messageParticipant');
    const original = (await fixture.read('message'))[0];
    const candidate = await fixture.capture(
      context,
      {
        kind: 'message.edited',
        sourcePosition: { type: 'journal', value: '2' },
        occurredAt: '2026-10-27T12:00:00.000Z',
        payload: {
          text: 'new',
          sourceAuthorId: 'history-author',
          sourceDisplayName: 'Changed display',
        },
      },
      'live',
    );
    await apply(candidate);
    expect(await fixture.read('messageParticipant')).toEqual(authors);
    expect((await fixture.read('message'))[0].receivedAt).toEqual(
      original.receivedAt,
    );
  });
  it('rejects complete-to-placeholder regression even if adapter orders it later', async () => {
    await apply(await capture(1));
    const candidate = await capture(2, 'message.received', null, 'placeholder');
    expect(await process(candidate)).toMatchObject({
      state: 'quarantined',
      errorCode: 'inconsistent_source',
    });
    expect((await fixture.read('message'))[0].text).toBe('body');
  });
  it('does not quarantine unauthorized malformed content or call the revision adapter', async () => {
    const candidate = await capture(1, 'message.deleted', 'invalid');
    const revisionKey = jest.fn(adapter.revisionKey);
    await expect(
      fixture.service.processOmniIncomingTextReceipt(
        context.principal,
        candidate.proof,
        async () => {
          throw new Error('revoked');
        },
        { ...adapter, revisionKey },
        async () => undefined,
      ),
    ).rejects.toThrow('revoked');
    expect(revisionKey).not.toHaveBeenCalled();
    expect((await core('omniIncomingReceipt'))[0].state).toBe('processing');
  });
  it('expires lease during actual audit and rolls back advanced native text', async () => {
    await apply(await capture(1));
    const candidate = await capture(2, 'message.edited', 'edited');
    await fixture.owner.query(
      `UPDATE core."omniIncomingReceipt" SET "leaseUntil"=clock_timestamp()+interval '1 second' WHERE id=$1`,
      [candidate.proof.receiptId],
    );
    const before = await snapshot();
    await fixture.owner.query(
      `CREATE FUNCTION crm_audit.delay_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."resourceKind"='omniMessage' AND NEW.outcome='success' THEN PERFORM pg_sleep(2); END IF; RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      'CREATE TRIGGER delay_revision BEFORE INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.delay_revision()',
    );
    try {
      await expect(apply(candidate)).rejects.toThrow('LEASE');
      expect(await snapshot()).toEqual(before);
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER delay_revision ON crm_audit."crmAuditEntry"',
      );
      await fixture.owner.query('DROP FUNCTION crm_audit.delay_revision()');
    }
  });
  it('reports actual COMMIT ACK loss as unknown and replays persisted advanced result', async () => {
    await apply(await capture(1));
    const candidate = await capture(2, 'message.edited', 'edited');
    const client = await fixture.pool.connect();
    const query = client.query.bind(client);
    const statements: string[] = [];
    jest.spyOn(client, 'query').mockImplementation((async (
      sql: string,
      values?: unknown[],
    ) => {
      statements.push(sql);
      const result = await query(sql, values);
      if (sql === 'COMMIT') throw new Error('lost commit ACK');
      return result;
    }) as typeof client.query);
    jest
      .spyOn(fixture.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await expect(process(candidate)).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
    expect(statements).not.toContain('ROLLBACK');
    expect((await fixture.read('message'))[0].text).toBe('edited');
    expect(
      (await audit(candidate)).filter((row) => row.outcome !== 'success'),
    ).toEqual([]);
    const before = await snapshot();
    expect(await apply(candidate)).toMatchObject({
      replayed: true,
      applicationResult: { disposition: 'advanced' },
    });
    expect(await snapshot()).toEqual(before);
  });
  it.each(['head', 'outcome', 'text'])(
    'rejects a late %s mutation after applied receipt CAS',
    async (kind) => {
      await apply(await capture(1));
      const candidate = await capture(2, 'message.edited', 'edited');
      const before = await snapshot();
      const change =
        kind === 'head'
          ? 'UPDATE core."omniMessageLink" SET "currentRevisionId"=NULL;'
          : kind === 'outcome'
            ? `UPDATE core."omniIncomingReceipt" SET "applicationResult"=NULL WHERE id=NEW.id;`
            : `UPDATE "${fixture.schemaName}"."message" SET text='tampered';`;
      await fixture.owner.query(
        `CREATE FUNCTION core.late_revision_corruption() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='applied' AND pg_trigger_depth()=1 THEN ${change} END IF; RETURN NEW; END $$`,
      );
      await fixture.owner.query(
        'CREATE TRIGGER late_revision_corruption AFTER UPDATE ON core."omniIncomingReceipt" FOR EACH ROW EXECUTE FUNCTION core.late_revision_corruption()',
      );
      try {
        await expect(apply(candidate)).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
      } finally {
        await fixture.owner.query(
          'DROP TRIGGER late_revision_corruption ON core."omniIncomingReceipt"',
        );
        await fixture.owner.query(
          'DROP FUNCTION core.late_revision_corruption()',
        );
      }
    },
  );
  it.each([
    'receipt-hash',
    'revision-hash',
    'missing-audit',
    'duplicate-source',
    'foreign-observed',
    'head-null',
  ])(
    'rejects retained %s corruption before another native write',
    async (kind) => {
      const first = await capture(1);
      await apply(first);
      const edit = await capture(2, 'message.edited', 'edited');
      await apply(edit);
      const head = (await core('omniMessageLink'))[0].currentRevisionId;
      if (kind === 'receipt-hash')
        await fixture.owner.query(
          'UPDATE core."omniIncomingReceipt" SET "canonicalPayloadHash"=$1 WHERE id=$2',
          ['f'.repeat(64), edit.proof.receiptId],
        );
      if (kind === 'revision-hash')
        await fixture.owner.query(
          'UPDATE core."omniMessageRevision" SET "contentHash"=$1 WHERE id=$2',
          ['f'.repeat(64), head],
        );
      if (kind === 'missing-audit')
        await fixture.owner.query(
          'DELETE FROM crm_audit."crmAuditEntry" WHERE "operationId"=$1 AND "resourceKind"=\'omniMessageRevision\'',
          [omniIncomingTextApplyOperationId(edit.proof.receiptId)],
        );
      if (kind === 'duplicate-source')
        await fixture.owner.query(
          `UPDATE core."omniIncomingReceipt" SET "applicationResult"=jsonb_set("applicationResult",'{disposition}','"duplicate"'::jsonb) WHERE id=$1`,
          [edit.proof.receiptId],
        );
      if (kind === 'foreign-observed')
        await fixture.owner.query(
          `UPDATE core."omniIncomingReceipt" SET "applicationResult"=jsonb_set("applicationResult",'{observedHeadRevisionId}',to_jsonb($2::text)) WHERE id=$1`,
          [edit.proof.receiptId, randomUUID()],
        );
      if (kind === 'head-null')
        await fixture.owner.query(
          'UPDATE core."omniMessageLink" SET "currentRevisionId"=NULL',
        );
      const candidate = await capture(3, 'message.edited', 'third');
      const before = await snapshot();
      await expect(process(candidate)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(
        (await core('omniIncomingReceipt')).find(
          (row) => row.id === candidate.proof.receiptId,
        )?.state,
      ).toBe('processing');
    },
  );
  it.each(['event', 'root', 'dispatch'])(
    'rejects missing retained %s semantics on replay and before next edit',
    async (kind) => {
      const first = await capture(1);
      await apply(first);
      if (kind === 'event')
        await fixture.owner.query(
          'UPDATE core."omniDomainEvent" SET payload=\'{}\'::jsonb',
        );
      if (kind === 'root')
        await fixture.owner.query(
          'UPDATE core."omniRootExecution" SET "sourceKey"=\'corrupt\'',
        );
      if (kind === 'dispatch')
        await fixture.owner.query(
          'UPDATE core."omniEventDispatchPlan" SET "payloadHash"=$1',
          ['e'.repeat(64)],
        );
      const before = await snapshot();
      await expect(apply(first)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      const next = await capture(2, 'message.edited', 'new');
      const nextBefore = await snapshot();
      await expect(apply(next)).rejects.toThrow();
      expect(await snapshot()).toEqual(nextBefore);
    },
  );
  it('snapshots principal, proof and adapter callbacks before first workspace wait', async () => {
    const candidate = await capture(1);
    const principal = {
      ...context.principal,
      actor: { ...context.principal.actor },
    };
    const proof = { ...candidate.proof };
    const selected = { ...adapter };
    const execute = fixture.manager.executeInWorkspaceContext.bind(
      fixture.manager,
    );
    jest
      .spyOn(fixture.manager, 'executeInWorkspaceContext')
      .mockImplementationOnce((async (...args: Parameters<typeof execute>) => {
        principal.actor.id = 'mutated';
        proof.receiptId = randomUUID();
        selected.adapterId = 'mutated';
        selected.revisionKey = () => {
          throw new Error('mutated callback');
        };
        await Promise.resolve();
        return execute(...args);
      }) as typeof execute);
    expect(
      await fixture.service.applyOmniIncomingTextReceipt(
        principal,
        proof,
        authorize,
        selected,
      ),
    ).toMatchObject({ receiptId: candidate.proof.receiptId, created: true });
    expect(JSON.stringify(await audit(candidate))).not.toContain('mutated');
  });
  it('retains route generation beyond JavaScript integer precision while verifying revisions', async () => {
    const generation = '9007199254740993';
    await fixture.owner.query(
      'UPDATE core."omniAccountBinding" SET "routeGeneration"=$1',
      [generation],
    );
    const first = await fixture.capture(
      context,
      { routeGeneration: generation },
      'live',
    );
    await apply(first);
    const edit = await fixture.capture(
      context,
      {
        routeGeneration: generation,
        kind: 'message.edited',
        sourcePosition: { type: 'journal', value: '13' },
        payload: {
          text: 'new',
          sourceAuthorId: 'history-author',
          sourceDisplayName: 'Captured author',
        },
      },
      'live',
    );
    await apply(edit);
    expect((await fixture.read('message'))[0].text).toBe('new');
    const before = await snapshot();
    await apply(first);
    await apply(edit);
    expect(await snapshot()).toEqual(before);
  });
  it('does not quarantine an issued source conflict after unconfirmed rollback', async () => {
    await apply(await capture(1));
    const candidate = await capture(1, 'message.received', 'conflict');
    const before = await snapshot();
    const client = await fixture.pool.connect();
    const query = client.query.bind(client);
    jest.spyOn(client, 'query').mockImplementation((async (
      sql: string,
      values?: unknown[],
    ) => {
      const result = await query(sql, values);
      if (sql === 'ROLLBACK') throw new Error('lost rollback ACK');
      return result;
    }) as typeof client.query);
    jest
      .spyOn(fixture.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await expect(process(candidate)).rejects.toBeInstanceOf(
      NativeTransactionOutcomeUnknownError,
    );
    expect(await snapshot()).toEqual(before);
    expect(await audit(candidate)).toEqual([]);
  });
});
