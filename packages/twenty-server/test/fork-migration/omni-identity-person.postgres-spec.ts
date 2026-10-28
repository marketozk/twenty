import { type OmniIncomingRevisionAdapter } from 'src/modules/omnichannel/contracts/omni-incoming-text-revision';
import { randomUUID } from 'node:crypto';
import { STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS } from 'twenty-shared/metadata';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type OmniIdentityPersonAuthorizer } from 'src/modules/omnichannel/services/set-omni-identity-person';
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
let otherPersonId: string;
const principal = () => ({
  workspaceId: fixture.workspaceId,
  actor: { kind: 'system' as const, id: 'identity-operator' },
});
const command = (
  personId: string | null,
  revision = '1',
  key = 'set-person',
) => ({
  bindingId: context.bindingId,
  externalIdentityId: context.externalIdentityId,
  personId,
  expectedRevision: revision,
  idempotencyKey: key,
});
const authorize: OmniIdentityPersonAuthorizer = async (_scope, facts) => {
  if (
    facts.workspaceId !== fixture.workspaceId ||
    facts.currentIdentity.id !== context.externalIdentityId ||
    facts.command.bindingId !== context.bindingId ||
    facts.conversations.some((c) => c.id !== context.conversationId)
  )
    throw new Error('DENIED');
};
const apply = (
  personId: string | null,
  revision = '1',
  key = 'set-person',
  auth = authorize,
) =>
  fixture.service.setOmniIdentityPerson(
    principal(),
    command(personId, revision, key),
    auth,
  );
const rows = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const audit = (): Promise<Record<string, unknown>[]> =>
  fixture.owner.query('SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id');
const snapshot = async () => ({
  identities: await rows('omniExternalIdentity'),
  state: await rows('omniWorkspacePolicyState'),
  receipts: await rows('omniPolicyMutationReceipt'),
  links: await rows('omniMessageLink'),
  targets: await rows('omniConversationTarget'),
  participants: await fixture.read('messageParticipant'),
  projections: await fixture.read('messageThreadTarget'),
  messages: await fixture.read('message'),
});
const replay = () =>
  fixture.service.applyOmniHistoryReceipt(
    context.principal,
    captured.proof,
    async (_scope, facts) => {
      expect(facts.externalIdentityId).toBe(context.externalIdentityId);
    },
  );
const target = async () => {
  const objectMetadataId = await fixture.withContext(
    async () =>
      getWorkspaceContext().flatObjectMetadataMaps.byUniversalIdentifier[
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person
      ]!.id,
  );
  const projectionId = randomUUID();
  await fixture.owner.query(
    `INSERT INTO "${fixture.schemaName}"."messageThreadTarget" (id,"messageThreadId","targetPersonId","isManuallyAssigned","isAutomaticallyAssigned") VALUES ($1,$2,$3,true,false)`,
    [projectionId, context.threadId, context.personId],
  );
  const targetId = await fixture.coreInsert('omniConversationTarget', {
    workspaceId: fixture.workspaceId,
    conversationId: context.conversationId,
    objectMetadataId,
    recordId: context.personId,
    projectionId,
    active: true,
    revision: '1',
  });
  return { projectionId, targetId };
};
beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    `GRANT INSERT,UPDATE ON core."omniPolicyMutationReceipt",core."omniExternalIdentity",core."omniWorkspacePolicyState",core."omniConversationTarget" TO "${fixture.roleName}"`,
  );
});
beforeEach(async () => {
  context = await fixture.reset();
  otherPersonId = randomUUID();
  await fixture.owner.query(
    `INSERT INTO "${fixture.schemaName}".person (id) VALUES ($1)`,
    [otherPersonId],
  );
  captured = await fixture.capture(context);
  await fixture.service.applyOmniHistoryReceipt(
    context.principal,
    captured.proof,
    fixture.authorizeFor(context),
  );
  fixture.eventEmitter.mockClear();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());
describe('explicit identity Person binding', () => {
  it('rebinds and unlinks participants without rewriting birth snapshots or text', async () => {
    const before = await snapshot();
    const changed = await apply(otherPersonId);
    expect(changed).toMatchObject({
      personId: otherPersonId,
      revision: '2',
      replayed: false,
    });
    expect((await fixture.read('messageParticipant'))[0].personId).toBe(
      otherPersonId,
    );
    expect(await rows('omniMessageLink')).toEqual(before.links);
    expect(await fixture.read('message')).toEqual(before.messages);
    expect((await replay()).created).toBe(false);
    await apply(null, '2', 'unlink');
    expect((await fixture.read('messageParticipant'))[0].personId).toBeNull();
    expect((await replay()).created).toBe(false);
    await apply(context.personId, '3', 'relink');
    expect((await replay()).created).toBe(false);
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });
  it('replays original command result after later binding changes without undoing them', async () => {
    const first = await apply(otherPersonId);
    await apply(null, '2', 'unlink');
    const before = await snapshot();
    expect(await apply(otherPersonId)).toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(before);
  });
  it('rejects a retained result whose policy epoch differs from its operation audit', async () => {
    await apply(otherPersonId);
    await fixture.owner.query(
      `UPDATE core."omniPolicyMutationReceipt" SET "resultPublic"=jsonb_set("resultPublic",'{policyEpoch}','"1"'::jsonb) WHERE "idempotencyKey"='set-person'`,
    );
    const before = await snapshot();
    await expect(apply(otherPersonId)).rejects.toThrow(
      'BINDING_HISTORY_INTEGRITY',
    );
    expect(await snapshot()).toEqual(before);
  });
  it('allows only one of two concurrent different commands with the same expected revision', async () => {
    const results = await Promise.allSettled([
      apply(otherPersonId, '1', 'competing-link'),
      apply(null, '1', 'competing-unlink'),
    ]);
    expect(
      results.filter((entry) => entry.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((entry) => entry.status === 'rejected');
    expect(
      rejected?.status === 'rejected' && rejected.reason.message,
    ).toContain('REVISION_CONFLICT');
    expect((await rows('omniExternalIdentity'))[0].revision).toBe('2');
    expect(await rows('omniPolicyMutationReceipt')).toHaveLength(1);
    expect((await replay()).created).toBe(false);
  });
  it('invalidates only old explicit Person edge and removes its manual projection', async () => {
    const edge = await target();
    await apply(otherPersonId);
    expect(
      (await rows('omniConversationTarget')).find(
        (x) => x.id === edge.targetId,
      ),
    ).toMatchObject({ active: false, revision: '2', projectionId: null });
    expect(await fixture.read('messageThreadTarget')).toHaveLength(0);
    expect(
      (await audit()).filter(
        (x) =>
          x.resourceKind === 'omniMessageThreadTarget' && x.action === 'delete',
      ),
    ).toHaveLength(1);
    expect((await replay()).created).toBe(false);
  });
  it('serializes twenty identical commands into one transition', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => apply(otherPersonId)),
    );
    expect(results.filter((x) => !x.replayed)).toHaveLength(1);
    expect(new Set(results.map((x) => x.operationId)).size).toBe(1);
    expect((await rows('omniExternalIdentity'))[0].revision).toBe('2');
  });
  it('rejects stale revision and conflicting actor key', async () => {
    await apply(otherPersonId);
    const before = await snapshot();
    await expect(apply(null)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await expect(apply(null, '1', 'new-key')).rejects.toThrow(
      'REVISION_CONFLICT',
    );
    expect(await snapshot()).toEqual(before);
  });
  it.each([false, true])(
    'checks current authorization for initial/replay: %s',
    async (replayed) => {
      if (replayed) await apply(otherPersonId);
      const before = await snapshot();
      await expect(
        apply(otherPersonId, '1', 'set-person', async () => {
          throw new Error('REVOKED');
        }),
      ).rejects.toThrow('REVOKED');
      expect(await snapshot()).toEqual(before);
    },
  );
  it('rejects deleted or missing destination Person', async () => {
    const before = await snapshot();
    await expect(apply(randomUUID())).rejects.toThrow('PERSON_NOT_LIVE');
    expect(await snapshot()).toEqual(before);
    await fixture.owner.query(
      `UPDATE "${fixture.schemaName}".person SET "deletedAt"=now() WHERE id=$1`,
      [otherPersonId],
    );
    await expect(apply(otherPersonId)).rejects.toThrow('PERSON_NOT_LIVE');
  });
  it('rejects an unaudited identity change during message replay', async () => {
    await fixture.owner.query(
      'UPDATE core."omniExternalIdentity" SET "personId"=$1,revision=2',
      [otherPersonId],
    );
    await fixture.owner.query(
      `UPDATE "${fixture.schemaName}"."messageParticipant" SET "personId"=$1`,
      [otherPersonId],
    );
    await expect(replay()).rejects.toThrow('BINDING_HISTORY_INTEGRITY');
  });
  it('rejects missing transition evidence after a valid rebind', async () => {
    await apply(otherPersonId);
    await fixture.owner.query(
      `DELETE FROM crm_audit."crmAuditEntry" WHERE "resourceKind"='omniExternalIdentity' AND action='update'`,
    );
    await expect(replay()).rejects.toThrow('BINDING_HISTORY_INTEGRITY');
  });
  it.each(['participant', 'projection', 'audit', 'receipt'])(
    'rolls back all changes if %s fails',
    async (stage) => {
      await target();
      const before = await snapshot();
      const table =
        stage === 'participant'
          ? `"${fixture.schemaName}"."messageParticipant"`
          : stage === 'projection'
            ? `"${fixture.schemaName}"."messageThreadTarget"`
            : stage === 'audit'
              ? 'crm_audit."crmAuditEntry"'
              : 'core."omniPolicyMutationReceipt"';
      const event =
        stage === 'participant'
          ? 'UPDATE'
          : stage === 'projection'
            ? 'DELETE'
            : 'INSERT';
      await fixture.owner.query(
        `CREATE FUNCTION crm_audit.fail_identity_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${stage === 'audit' ? "IF NEW.outcome <> 'success' THEN RETURN NEW; END IF;" : ''} RAISE EXCEPTION 'INJECTED_IDENTITY_FAILURE'; END $$`,
      );
      await fixture.owner.query(
        `CREATE TRIGGER fail_identity_test BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_identity_test()`,
      );
      try {
        await expect(apply(otherPersonId)).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
      } finally {
        await fixture.owner.query(
          `DROP TRIGGER fail_identity_test ON ${table}`,
        );
        await fixture.owner.query(
          'DROP FUNCTION crm_audit.fail_identity_test()',
        );
      }
    },
  );
  it('does not accept another workspace principal', async () => {
    await expect(
      fixture.service.setOmniIdentityPerson(
        { ...principal(), workspaceId: randomUUID() },
        command(otherPersonId),
        authorize,
      ),
    ).rejects.toThrow('METADATA_SCOPE');
  });
  it('links an unbound author without changing another unbound author in the same thread', async () => {
    await apply(null);
    const secondId = await fixture.coreInsert('omniExternalIdentity', {
      workspaceId: fixture.workspaceId,
      bindingId: context.bindingId,
      providerPeerId: 'other-peer',
      verificationSource: 'fixture-confirmed',
      personId: null,
      revision: '1',
    });
    const second = { ...context, externalIdentityId: secondId };
    const event = await fixture.capture(second, {
      providerMessageId: 'second-author-message',
      payload: {
        text: 'other author',
        sourceAuthorId: 'other-peer',
        sourceDisplayName: 'Other',
      },
    });
    await fixture.service.applyOmniHistoryReceipt(
      second.principal,
      event.proof,
      async () => {},
    );
    await apply(otherPersonId, '2', 'link-unbound');
    const participants = await fixture.read('messageParticipant');
    expect(
      participants.find(
        (p: { handle: string; personId: string | null }) =>
          p.handle === 'other-peer',
      )?.personId,
    ).toBeNull();
    expect(
      participants.find(
        (p: { handle: string; personId: string | null }) =>
          p.handle === 'history-author',
      )?.personId,
    ).toBe(otherPersonId);
    expect((await replay()).created).toBe(false);
  });
  it('replays after real COMMIT acknowledgement loss without a false failed audit', async () => {
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
    await expect(apply(otherPersonId)).rejects.toThrow(/unknown/i);
    const before = await snapshot();
    expect((await apply(otherPersonId)).replayed).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(
      (await audit()).filter((row) => row.outcome !== 'success'),
    ).toHaveLength(0);
  });
  it('rejects forged transition audit even when the native current relation matches', async () => {
    await apply(otherPersonId);
    await fixture.owner.query(
      `UPDATE crm_audit."crmAuditEntry" SET "redactedDiff"=jsonb_set("redactedDiff",'{values,personId,before}','null'::jsonb) WHERE "resourceKind"='omniExternalIdentity' AND action='update'`,
    );
    await expect(replay()).rejects.toThrow('BINDING_HISTORY_INTEGRITY');
  });
  it('applies edits and tombstones after rebind/unlink while retaining original author', async () => {
    const adapter: OmniIncomingRevisionAdapter = {
      adapterId: 'fixture-history',
      adapterVersion: '1',
      revisionKey: ({ envelope }) => envelope.eventId,
      compare: () => 'newer',
    };
    const initialLinks = await rows('omniMessageLink');
    await apply(otherPersonId);
    const edit = await fixture.capture(
      context,
      {
        kind: 'message.edited',
        payload: {
          text: 'edited after rebind',
          sourceAuthorId: 'history-author',
          sourceDisplayName: 'History author',
        },
      },
      'live',
    );
    const authorizer = async () => {};
    await fixture.service.applyOmniIncomingTextReceipt(
      context.principal,
      edit.proof,
      authorizer,
      adapter,
    );
    expect((await fixture.read('message'))[0].text).toBe('edited after rebind');
    await apply(null, '2', 'unlink');
    const deletion = await fixture.capture(
      context,
      {
        kind: 'message.deleted',
        payload: {
          text: null,
          sourceAuthorId: 'history-author',
          sourceDisplayName: 'History author',
        },
      },
      'live',
    );
    await fixture.service.applyOmniIncomingTextReceipt(
      context.principal,
      deletion.proof,
      authorizer,
      adapter,
    );
    expect((await fixture.read('message'))[0].text).toBeNull();
    expect((await fixture.read('messageParticipant'))[0].personId).toBeNull();
    expect((await rows('omniMessageLink'))[0].immutableAuthorSnapshot).toEqual(
      initialLinks[0].immutableAuthorSnapshot,
    );
    expect((await replay()).created).toBe(false);
  });
});
