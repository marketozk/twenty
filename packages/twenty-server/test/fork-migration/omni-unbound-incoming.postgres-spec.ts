import { randomUUID } from 'node:crypto';
import { type OmniHistoryApplyAuthorizer } from 'src/modules/omnichannel/services/apply-omni-history-receipt';
import { type OmniIncomingRevisionAdapter } from 'src/modules/omnichannel/contracts/omni-incoming-text-revision';
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
type Captured = Awaited<ReturnType<typeof fixture.capture>>;
const adapter: OmniIncomingRevisionAdapter = {
  adapterId: 'fixture-history',
  adapterVersion: '1',
  revisionKey: ({ envelope }) =>
    `${envelope.sourcePosition?.value}:${envelope.kind}:${envelope.sourceVariant}`,
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
    return current.envelope.sourceVariant === 'placeholder' &&
      candidate.envelope.sourceVariant === 'complete'
      ? 'newer'
      : 'equal';
  },
};
const authorize: OmniHistoryApplyAuthorizer = async (_scope, facts) => {
  if (
    facts.workspaceId !== fixture.workspaceId ||
    facts.bindingId !== context.bindingId ||
    facts.queueId !== context.queueId ||
    facts.externalIdentityId !== context.externalIdentityId ||
    facts.personId !== null ||
    facts.providerPeerId !== 'history-author' ||
    facts.verificationSource !== 'fixture-confirmed' ||
    facts.envelope.providerChatId !== 'history-chat'
  )
    throw new Error('UNBOUND_FIXTURE_DENIED');
};
const core = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const capture = (
  position: number,
  kind = 'message.received',
  text: string | null = 'unbound body',
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
const apply = (captured: Captured) =>
  fixture.service.applyOmniIncomingTextReceipt(
    context.principal,
    captured.proof,
    authorize,
    adapter,
  );
const snapshot = async () => ({
  persons: await fixture.read('person'),
  participants: await fixture.read('messageParticipant'),
  messages: await fixture.read('message'),
  targets: await fixture.read('messageThreadTarget'),
  core: await Promise.all(
    [
      'omniMessageLink',
      'omniMessageRevision',
      'omniConversation',
      'omniIncomingReceipt',
      'omniConversationTarget',
      'omniExternalIdentity',
    ].map(core),
  ),
  success: await fixture.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" WHERE outcome=\'success\' ORDER BY id',
  ),
});
const reset = async (newConversation = false) => {
  context = await fixture.reset({ withoutConversation: newConversation });
  await fixture.owner.query(
    'UPDATE core."omniExternalIdentity" SET "personId"=NULL WHERE id=$1',
    [context.externalIdentityId],
  );
};
beforeAll(() => fixture.initialize());
beforeEach(() => reset());
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('qualified incoming identity without a Person binding', () => {
  it.each([
    ['history', false],
    ['history', true],
    ['live', false],
    ['live', true],
  ] as const)(
    'stores %s in newConversation=%s without creating or guessing a Person',
    async (origin, newConversation) => {
      if (newConversation) await reset(true);
      const persons = await fixture.read('person');
      const captured = await fixture.capture(
        context,
        {},
        origin === 'history' ? 'history_import' : 'live',
      );
      const write = () =>
        origin === 'history'
          ? fixture.service.applyOmniHistoryReceipt(
              context.principal,
              captured.proof,
              authorize,
            )
          : apply(captured);
      const result = await write();
      expect(result.created).toBe(true);
      expect(await fixture.read('messageParticipant')).toEqual([
        expect.objectContaining({
          messageId: result.messageId,
          personId: null,
          workspaceMemberId: null,
          handle: 'history-author',
          role: 'FROM',
        }),
      ]);
      expect(await fixture.read('person')).toEqual(persons);
      expect(await fixture.read('messageThreadTarget')).toEqual([]);
      expect(await core('omniConversationTarget')).toEqual([]);
      const before = await snapshot();
      expect(await write()).toMatchObject({
        receiptId: result.receiptId,
        messageId: result.messageId,
        created: false,
      });
      expect(await snapshot()).toEqual(before);
      expect(fixture.eventEmitter).not.toHaveBeenCalled();
    },
  );
  it('fills, edits and deletes an unbound message while preserving author and replay', async () => {
    const first = await capture(1, 'message.received', null, 'placeholder');
    const created = await apply(first);
    const author = await fixture.read('messageParticipant');
    const persons = await fixture.read('person');
    const fill = await capture(1);
    await apply(fill);
    const edit = await capture(2, 'message.edited', 'edited');
    await apply(edit);
    const deleted = await capture(3, 'message.deleted', null);
    await apply(deleted);
    expect(await fixture.read('message')).toEqual([
      expect.objectContaining({
        id: created.messageId,
        text: null,
        deletedAt: null,
      }),
    ]);
    expect(await fixture.read('messageParticipant')).toEqual(author);
    expect(await fixture.read('person')).toEqual(persons);
    const before = await snapshot();
    for (const item of [first, fill, edit, deleted]) await apply(item);
    expect(await snapshot()).toEqual(before);
  });
  it('supports legacy null-head replay and a new revision while identity remains unbound', async () => {
    const initial = await fixture.capture(context);
    const result = await fixture.service.applyOmniHistoryReceipt(
      context.principal,
      initial.proof,
      authorize,
    );
    await fixture.owner.query(
      'UPDATE core."omniMessageLink" SET "currentRevisionId"=NULL',
    );
    await fixture.service.applyOmniHistoryReceipt(
      context.principal,
      initial.proof,
      authorize,
    );
    await apply(await capture(13, 'message.edited', 'new'));
    const before = await snapshot();
    expect(
      await fixture.service.applyOmniHistoryReceipt(
        context.principal,
        initial.proof,
        authorize,
      ),
    ).toEqual({ ...result, created: false });
    expect(await snapshot()).toEqual(before);
  });
  it('requires current explicit unbound authorization before persistence and replay', async () => {
    const item = await capture(1);
    const deny = async () => {
      throw new Error('unbound denied');
    };
    const before = await snapshot();
    await expect(
      fixture.service.applyOmniIncomingTextReceipt(
        context.principal,
        item.proof,
        deny,
        adapter,
      ),
    ).rejects.toThrow('unbound denied');
    expect(await snapshot()).toEqual(before);
    await apply(item);
    const after = await snapshot();
    await expect(
      fixture.service.applyOmniIncomingTextReceipt(
        context.principal,
        item.proof,
        deny,
        adapter,
      ),
    ).rejects.toThrow('unbound denied');
    expect(await snapshot()).toEqual(after);
  });
  it('does not convert a missing bound Person into unbound acceptance', async () => {
    await fixture.owner.query(
      'UPDATE core."omniExternalIdentity" SET "personId"=$1 WHERE id=$2',
      [randomUUID(), context.externalIdentityId],
    );
    const item = await capture(1);
    const before = await snapshot();
    await expect(
      fixture.service.applyOmniIncomingTextReceipt(
        context.principal,
        item.proof,
        async () => undefined,
        adapter,
      ),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it('does not create an ExternalIdentity from an unknown identity UUID', async () => {
    const item = await capture(1);
    const before = await snapshot();
    await expect(
      fixture.service.applyOmniIncomingTextReceipt(
        context.principal,
        { ...item.proof, externalIdentityId: randomUUID() },
        authorize,
        adapter,
      ),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it('rolls back a native adapter that silently assigns the unrelated existing Person', async () => {
    const item = await capture(1);
    const before = await snapshot();
    const save = fixture.participants.saveMessageParticipants.bind(
      fixture.participants,
    );
    jest
      .spyOn(fixture.participants, 'saveMessageParticipants')
      .mockImplementationOnce(async (inputs, workspaceId, scope) =>
        save(
          inputs.map((input) => ({ ...input, personId: context.personId })),
          workspaceId,
          scope,
        ),
      );
    await expect(apply(item)).rejects.toThrow('PARTICIPANT');
    expect(await snapshot()).toEqual(before);
  });
  it('does not treat two null Person bindings as the same external author', async () => {
    const first = await capture(1);
    await apply(first);
    const otherId = await fixture.coreInsert('omniExternalIdentity', {
      workspaceId: fixture.workspaceId,
      bindingId: context.bindingId,
      providerPeerId: 'different-peer',
      personId: null,
      verificationSource: 'fixture-confirmed',
    });
    const edit = await capture(2, 'message.edited', 'foreign');
    const before = await snapshot();
    await expect(
      fixture.service.applyOmniIncomingTextReceipt(
        context.principal,
        { ...edit.proof, externalIdentityId: otherId },
        async () => undefined,
        adapter,
      ),
    ).rejects.toThrow('AUTHOR_INTEGRITY');
    expect(await snapshot()).toEqual(before);
  });
  it.each(['head', 'receipt'])(
    'rolls back unbound graph on %s failure',
    async (boundary) => {
      const item = await capture(1);
      const before = await snapshot();
      const table =
        boundary === 'head' ? 'omniMessageLink' : 'omniIncomingReceipt';
      const condition = boundary === 'head' ? 'true' : "NEW.state='applied'";
      await fixture.owner.query(
        `CREATE FUNCTION core.fail_unbound() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'unbound fault'; END IF; RETURN NEW; END $$`,
      );
      await fixture.owner.query(
        `CREATE TRIGGER fail_unbound BEFORE UPDATE ON core."${table}" FOR EACH ROW EXECUTE FUNCTION core.fail_unbound()`,
      );
      try {
        await expect(apply(item)).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
      } finally {
        await fixture.owner.query(
          `DROP TRIGGER fail_unbound ON core."${table}"`,
        );
        await fixture.owner.query('DROP FUNCTION core.fail_unbound()');
      }
    },
  );
  it.each(['message', 'messageParticipant'])(
    'retains generic write protection for unbound %s',
    async (table) => {
      await apply(await capture(1));
      const rows = await fixture.read(
        table as 'message' | 'messageParticipant',
      );
      const before = await snapshot();
      await expect(
        fixture.dataSource.transaction(
          async (scope) =>
            scope
              .getRepository(
                table,
                { shouldBypassPermissionChecks: true },
                { shouldSkipEventEmission: true },
              )
              .update(
                { id: rows[0].id },
                table === 'message'
                  ? { text: 'unauthorized' }
                  : { personId: context.personId },
              ),
          { commitOutcome: 'strict' },
        ),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );
});
