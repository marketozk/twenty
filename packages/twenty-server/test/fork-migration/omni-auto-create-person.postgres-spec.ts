import { randomUUID } from 'node:crypto';
import { type OmniIncomingRevisionAdapter } from 'src/modules/omnichannel/contracts/omni-incoming-text-revision';
import { type OmniIncomingAutoCreatePersonAuthorizer } from 'src/modules/omnichannel/services/apply-omni-history-receipt';
import { mutateOmniBindingConfiguration } from 'src/modules/omnichannel/services/mutate-omni-binding-configuration';
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

const core = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const snapshot = async () => ({
  people: await fixture.read('person'),
  messages: await fixture.read('message'),
  participants: await fixture.read('messageParticipant'),
  threads: await fixture.read('messageThread'),
  associations: await fixture.read('messageChannelMessageAssociation'),
  data: await Promise.all(
    [
      'omniExternalIdentity',
      'omniWorkspacePolicyState',
      'omniConversation',
      'omniMessageLink',
      'omniMessageRevision',
      'omniIncomingReceipt',
      'omniPolicyMutationReceipt',
      'omniDomainEvent',
      'omniRootExecution',
      'omniEventDispatchPlan',
      'omniConversationTarget',
    ].map(core),
  ),
  audit: await fixture.owner.query(
    `SELECT * FROM crm_audit."crmAuditEntry" WHERE outcome='success' ORDER BY id`,
  ),
});
const setting = async (enabled: boolean) => {
  const binding = (await core('omniAccountBinding')).find(
    (x) => x.id === context.bindingId,
  )!;
  return mutateOmniBindingConfiguration(
    fixture.runtime,
    { workspaceId: fixture.workspaceId, actor: context.principal.actor },
    {
      action: 'binding.defaults.update',
      bindingId: context.bindingId,
      expectedRevision: String(binding.revision),
      idempotencyKey: randomUUID(),
      defaultQueueId: context.queueId,
      defaultConversationMode: 'human',
      autoCreatePersonEnabled: enabled,
    },
    async (_runner, facts) => {
      expect(facts.enablingAutoCreatePerson).toBe(enabled);
    },
  );
};
const capture = (
  changes: Record<string, unknown> = {},
  origin: 'live' | 'history_import' | 'restore_replay' = 'live',
) => fixture.capture(context, changes, origin);
const authorizeCreate: OmniIncomingAutoCreatePersonAuthorizer = async (
  _scope,
  facts,
) => {
  expect(facts.workspaceId).toBe(fixture.workspaceId);
  expect(facts.action).toBe('identity.createPerson');
  expect(facts.currentIdentity.id).toBe(context.externalIdentityId);
  expect(facts.incoming.queueId).toBe(context.queueId);
  expect(facts.incoming.captureContext.origin).toBe('live');
  expect(facts.incoming.conversationId).toBeTruthy();
};
const apply = (
  captured: Captured,
  authorization: OmniIncomingAutoCreatePersonAuthorizer | null = authorizeCreate,
) =>
  fixture.service.applyOmniIncomingTextReceipt(
    context.principal,
    captured.proof,
    async (_scope, facts) => {
      expect(facts.queueId).toBe(context.queueId);
      expect(facts.externalIdentityId).toBe(context.externalIdentityId);
    },
    adapter,
    authorization ?? undefined,
  );
const identity = async () =>
  (await core('omniExternalIdentity')).find(
    (x) => x.id === context.externalIdentityId,
  )!;
const people = () => fixture.read('person');
const unlink = async () =>
  fixture.service.setOmniIdentityPerson(
    { workspaceId: fixture.workspaceId, actor: context.principal.actor },
    {
      bindingId: context.bindingId,
      externalIdentityId: context.externalIdentityId,
      expectedRevision: String((await identity()).revision),
      personId: null,
      idempotencyKey: randomUUID(),
    },
    async () => {},
  );
beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    `GRANT INSERT,UPDATE ON core."omniPolicyMutationReceipt",core."omniExternalIdentity",core."omniWorkspacePolicyState",core."omniConversationTarget",core."omniAccountBinding",core."omniBindingConfigWakeup" TO "${fixture.roleName}"`,
  );
});
beforeEach(async () => {
  context = await fixture.reset({ withoutConversation: true });
  fixture.recordStock.acquireRecordStock.mockClear();
  fixture.eventEmitter.mockClear();
  await fixture.owner.query(
    'UPDATE core."omniExternalIdentity" SET "personId"=NULL WHERE id=$1',
    [context.externalIdentityId],
  );
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('opt-in live automatic Person creation', () => {
  it('defaults to disabled and enables without processing stored messages', async () => {
    expect((await core('omniAccountBinding'))[0].autoCreatePersonEnabled).toBe(
      false,
    );
    const captured = await capture();
    const before = await people();
    await apply(captured, null);
    await setting(true);
    expect(await people()).toEqual(before);
    expect((await identity()).personId).toBeNull();
    expect((await apply(captured, null)).replayed).toBe(true);
    expect(await people()).toEqual(before);
  });
  it('creates Person, first native Thread/Message and binding atomically with redacted audit', async () => {
    await setting(true);
    const captured = await capture();
    const before = await people();
    const auth = jest.fn(authorizeCreate);
    const result = await apply(captured, auth);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(auth.mock.calls[0][1].incoming.creatingConversation).toBe(true);
    const current = await identity();
    expect(current).toMatchObject({
      revision: '2',
      personId: expect.any(String),
    });
    expect(await people()).toHaveLength(before.length + 1);
    expect(
      (await people()).find(
        (row: { id: string }) => row.id === current.personId,
      ),
    ).toMatchObject({ nameFirstName: 'Captured author', nameLastName: '' });
    expect((await fixture.read('messageParticipant'))[0].personId).toBe(
      current.personId,
    );
    expect(
      (await core('omniMessageLink'))[0].immutableAuthorSnapshot,
    ).toMatchObject({ personId: current.personId, identityRevision: '2' });
    expect(await fixture.read('messageThread')).toHaveLength(1);
    expect(result.created).toBe(true);
    expect(await core('omniConversationTarget')).toHaveLength(0);
    const audits = await fixture.owner.query(
      `SELECT * FROM crm_audit."crmAuditEntry" WHERE "resourceKind"='omniPerson'`,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].redactedDiff).toEqual({
      changedFields: ['name'],
      values: {},
    });
    expect(JSON.stringify(audits)).not.toContain('Captured author');
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
    expect(fixture.recordStock.acquireRecordStock).toHaveBeenCalled();
  });
  it.each(['history_import', 'restore_replay'] as const)(
    'never auto-creates for %s',
    async (origin) => {
      await setting(true);
      const captured = await capture({}, origin);
      const before = await people();
      const auth = jest.fn(authorizeCreate);
      await apply(captured, auth);
      expect(auth).not.toHaveBeenCalled();
      expect(await people()).toEqual(before);
      expect((await identity()).personId).toBeNull();
    },
  );
  it.each(['placeholder', 'edit', 'delete', 'stale'])(
    'does not create from %s',
    async (variant) => {
      await setting(true);
      const before = await people();
      if (variant === 'stale') {
        await apply(
          await capture({
            kind: 'message.deleted',
            payload: {
              text: null,
              sourceAuthorId: 'history-author',
              sourceDisplayName: 'Captured author',
            },
          }),
        );
        const result = await apply(
          await capture({ sourcePosition: { type: 'journal', value: '1' } }),
        );
        expect(result.applicationResult.disposition).toBe('stale');
      } else
        await apply(
          await capture({
            ...(variant === 'placeholder'
              ? { sourceVariant: 'placeholder' }
              : {
                  kind:
                    variant === 'edit' ? 'message.edited' : 'message.deleted',
                }),
            payload: {
              text:
                variant === 'delete' || variant === 'placeholder'
                  ? null
                  : 'edited',
              sourceAuthorId: 'history-author',
              sourceDisplayName: 'Captured author',
            },
          }),
        );
      expect(await people()).toEqual(before);
      expect((await identity()).personId).toBeNull();
    },
  );
  it('binds an imported unbound author when the same message arrives live without rewriting birth history', async () => {
    await setting(true);
    const imported = await capture({}, 'history_import');
    await apply(imported);
    const beforeLinks = await core('omniMessageLink');
    const live = await capture();
    expect((await apply(live)).applicationResult.disposition).toBe('duplicate');
    expect(await core('omniMessageLink')).toEqual(beforeLinks);
    expect((await fixture.read('messageParticipant'))[0].personId).toBe(
      (await identity()).personId,
    );
    expect((await identity()).personId).not.toBeNull();
    const before = await snapshot();
    await apply(imported);
    await apply(live);
    expect(await snapshot()).toEqual(before);
  });
  it('completes a placeholder and binds it once live content is available', async () => {
    await setting(true);
    await apply(
      await capture({
        sourceVariant: 'placeholder',
        payload: {
          text: null,
          sourceAuthorId: 'history-author',
          sourceDisplayName: 'Captured author',
        },
      }),
    );
    const result = await apply(await capture());
    expect(result.applicationResult.disposition).toBe('advanced');
    expect((await identity()).personId).not.toBeNull();
    expect((await fixture.read('messageParticipant'))[0].personId).toBe(
      (await identity()).personId,
    );
  });
  it.each([false, true])(
    'does not recreate during applied replay after unlink; disabled: %s',
    async (disabled) => {
      await setting(true);
      const captured = await capture();
      await apply(captured);
      await unlink();
      if (disabled) await setting(false);
      const before = await snapshot();
      expect((await apply(captured)).replayed).toBe(true);
      expect(await snapshot()).toEqual(before);
      expect((await identity()).personId).toBeNull();
    },
  );
  it('creates only one Person for two concurrent live messages and twenty retries', async () => {
    await setting(true);
    const first = await capture();
    const second = await capture({ providerMessageId: 'another-message' });
    const before = await people();
    await Promise.all([apply(first), apply(second)]);
    await Promise.all(Array.from({ length: 20 }, () => apply(first)));
    expect(await people()).toHaveLength(before.length + 1);
    expect(await fixture.read('message')).toHaveLength(2);
    expect(
      new Set(
        (await fixture.read('messageParticipant')).map(
          (row: { personId: string }) => row.personId,
        ),
      ),
    ).toEqual(new Set([(await identity()).personId]));
  });
  it.each([false, true])(
    'requires current create authorization including replay %s',
    async (replay) => {
      await setting(true);
      const captured = await capture();
      if (replay) await apply(captured);
      const before = await snapshot();
      await expect(
        apply(captured, async () => {
          throw new Error('CREATE_DENIED');
        }),
      ).rejects.toThrow('CREATE_DENIED');
      expect(await snapshot()).toEqual(before);
    },
  );
  it('fails closed without the create authorizer, even when ingress permission exists', async () => {
    await setting(true);
    const captured = await capture();
    const before = await snapshot();
    await expect(apply(captured, null)).rejects.toThrow(
      'AUTO_PERSON_AUTHORIZER_REQUIRED',
    );
    expect(await snapshot()).toEqual(before);
  });
  it.each(['person', 'message', 'participant', 'audit', 'receipt'])(
    'rolls back Person and message on %s failure',
    async (stage) => {
      await setting(true);
      const captured = await capture();
      const before = await snapshot();
      const table =
        stage === 'audit'
          ? 'crm_audit."crmAuditEntry"'
          : stage === 'receipt'
            ? 'core."omniIncomingReceipt"'
            : `"${fixture.schemaName}"."${stage === 'participant' ? 'messageParticipant' : stage}"`;
      await fixture.owner.query(
        `CREATE FUNCTION crm_audit.fail_auto_person_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${stage === 'audit' ? "IF NEW.outcome <> 'success' THEN RETURN NEW; END IF;" : ''} RAISE EXCEPTION 'AUTO_PERSON_INJECTED'; END $$`,
      );
      await fixture.owner.query(
        `CREATE TRIGGER fail_auto_person_test BEFORE ${stage === 'receipt' ? 'UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_auto_person_test()`,
      );
      try {
        await expect(apply(captured)).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
        expect(fixture.recordStock.acquireRecordStock).not.toHaveBeenCalled();
      } finally {
        await fixture.owner.query(
          `DROP TRIGGER fail_auto_person_test ON ${table}`,
        );
        await fixture.owner.query(
          'DROP FUNCTION crm_audit.fail_auto_person_test()',
        );
      }
    },
  );
  it('recovers real COMMIT acknowledgement loss without duplicate Person or false failed audit', async () => {
    await setting(true);
    const captured = await capture();
    const client = await fixture.pool.connect();
    const query = client.query.bind(client);
    jest.spyOn(client, 'query').mockImplementation((async (
      sql: string,
      values?: unknown[],
    ) => {
      const result = await query(sql, values);
      if (sql === 'COMMIT') throw new Error('LOST_ACK');
      return result;
    }) as typeof client.query);
    jest
      .spyOn(fixture.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await expect(apply(captured)).rejects.toThrow(/unknown/i);
    const before = await snapshot();
    await apply(captured);
    expect(await snapshot()).toEqual(before);
    expect(
      await fixture.owner.query(
        `SELECT id FROM crm_audit."crmAuditEntry" WHERE outcome<>'success'`,
      ),
    ).toHaveLength(0);
  });
  it('uses a verified identifier as the label when the source display name is absent', async () => {
    await setting(true);
    await apply(
      await capture({
        payload: {
          text: 'body',
          sourceAuthorId: 'history-author',
          sourceDisplayName: null,
        },
      }),
    );
    const current = await identity();
    expect(
      (await people()).find(
        (row: { id: string }) => row.id === current.personId,
      ),
    ).toMatchObject({ nameFirstName: 'history-author', nameLastName: '' });
  });
  it.each(['receipt', 'person-audit'])(
    'refuses replay after retained %s proof is removed',
    async (target) => {
      await setting(true);
      const captured = await capture();
      await apply(captured);
      if (target === 'receipt')
        await fixture.owner.query(
          `DELETE FROM core."omniPolicyMutationReceipt" WHERE action='identity.createPerson'`,
        );
      else
        await fixture.owner.query(
          `DELETE FROM crm_audit."crmAuditEntry" WHERE "resourceKind"='omniPerson'`,
        );
      const before = await snapshot();
      await expect(apply(captured)).rejects.toThrow(
        /AUTO_PERSON_RECEIPT_MISSING|CREATED_PERSON_AUDIT|MISSING_OR_AMBIGUOUS/,
      );
      expect(await snapshot()).toEqual(before);
    },
  );
});

describe('auto Person final transaction integrity', () => {
  it.each(['outer-audit-name', 'receipt-identity'])(
    'rolls back when %s corrupts the child after its own postconditions',
    async (stage) => {
      await setting(true);
      const captured = await capture();
      const before = await snapshot();
      const table =
        stage === 'outer-audit-name'
          ? 'crm_audit."crmAuditEntry"'
          : 'core."omniIncomingReceipt"';
      const condition =
        stage === 'outer-audit-name'
          ? `NEW."resourceKind"='omniMessageLink' AND NEW.outcome='success'`
          : `NEW.state='applied'`;
      const corruption =
        stage === 'outer-audit-name'
          ? `UPDATE "${fixture.schemaName}".person SET "nameFirstName"='Corrupted' WHERE id=(SELECT "personId" FROM core."omniExternalIdentity" WHERE id='${context.externalIdentityId}');`
          : `UPDATE core."omniExternalIdentity" SET revision=revision+1 WHERE id='${context.externalIdentityId}';`;
      await fixture.owner.query(
        `CREATE FUNCTION crm_audit.corrupt_auto_person_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN ${corruption} END IF; RETURN NEW; END $$`,
      );
      await fixture.owner.query(
        `CREATE TRIGGER corrupt_auto_person_test AFTER ${stage === 'outer-audit-name' ? 'INSERT' : 'UPDATE'} ON ${table} FOR EACH ROW EXECUTE FUNCTION crm_audit.corrupt_auto_person_test()`,
      );
      try {
        await expect(apply(captured)).rejects.toThrow(
          'AUTO_PERSON_FINAL_POSTCONDITION',
        );
        expect(await snapshot()).toEqual(before);
      } finally {
        await fixture.owner.query(
          `DROP TRIGGER corrupt_auto_person_test ON ${table}`,
        );
        await fixture.owner.query(
          'DROP FUNCTION crm_audit.corrupt_auto_person_test()',
        );
      }
    },
  );
  it('rolls back the automatic Person when the incoming lease expires after native writes', async () => {
    await setting(true);
    const captured = await capture();
    const before = await snapshot();
    await fixture.owner.query(
      `CREATE FUNCTION crm_audit.expire_auto_person_lease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."resourceKind"='omniIncomingReceipt' AND NEW.outcome='success' THEN UPDATE core."omniIncomingReceipt" SET "leaseUntil"=clock_timestamp()-interval '1 second' WHERE id='${captured.proof.receiptId}'; END IF; RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      `CREATE TRIGGER expire_auto_person_lease AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.expire_auto_person_lease()`,
    );
    try {
      await expect(apply(captured)).rejects.toThrow('LEASE_LOST');
      expect(await snapshot()).toEqual(before);
    } finally {
      await fixture.owner.query(
        `DROP TRIGGER expire_auto_person_lease ON crm_audit."crmAuditEntry"`,
      );
      await fixture.owner.query(
        'DROP FUNCTION crm_audit.expire_auto_person_lease()',
      );
    }
  });
});
