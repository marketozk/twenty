import { randomUUID } from 'node:crypto';
import {
  type OmniIdentityCreatePersonAuthorizer,
  type OmniIdentityCreatePersonCommand,
} from 'src/modules/omnichannel/services/set-omni-identity-person';
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
const principal = () => ({
  workspaceId: fixture.workspaceId,
  actor: { kind: 'system' as const, id: 'person-creator' },
});
const command = (
  key = 'create-person',
  revision = '1',
): OmniIdentityCreatePersonCommand => ({
  bindingId: context.bindingId,
  externalIdentityId: context.externalIdentityId,
  expectedRevision: revision,
  idempotencyKey: key,
  person: { name: { firstName: 'SensitiveFirst', lastName: 'SensitiveLast' } },
});
const authorize: OmniIdentityCreatePersonAuthorizer = async (_scope, facts) => {
  if (
    facts.action !== 'identity.createPerson' ||
    facts.workspaceId !== fixture.workspaceId ||
    facts.currentIdentity.id !== context.externalIdentityId
  )
    throw new Error('DENIED');
};
const create = (input = command(), auth = authorize) =>
  fixture.service.createPersonForOmniIdentity(principal(), input, auth);
const rows = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const audit = (): Promise<Record<string, unknown>[]> =>
  fixture.owner.query('SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id');
const snapshot = async () => ({
  people: await fixture.read('person'),
  identities: await rows('omniExternalIdentity'),
  state: await rows('omniWorkspacePolicyState'),
  receipts: await rows('omniPolicyMutationReceipt'),
  links: await rows('omniMessageLink'),
  participants: await fixture.read('messageParticipant'),
  targets: await rows('omniConversationTarget'),
});
const unlink = (revision: string) =>
  fixture.service.setOmniIdentityPerson(
    principal(),
    {
      bindingId: context.bindingId,
      externalIdentityId: context.externalIdentityId,
      personId: null,
      expectedRevision: revision,
      idempotencyKey: 'unlink-created',
    },
    async () => {},
  );
beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    `GRANT INSERT,UPDATE ON core."omniPolicyMutationReceipt",core."omniExternalIdentity",core."omniWorkspacePolicyState",core."omniConversationTarget" TO "${fixture.roleName}"`,
  );
});
beforeEach(async () => {
  context = await fixture.reset();
  await fixture.owner.query(
    'UPDATE core."omniExternalIdentity" SET "personId"=NULL WHERE id=$1',
    [context.externalIdentityId],
  );
  captured = await fixture.capture(context);
  await fixture.service.applyOmniHistoryReceipt(
    context.principal,
    captured.proof,
    async () => {},
  );
  fixture.eventEmitter.mockClear();
  fixture.recordStock.acquireRecordStock.mockClear();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());
describe('explicit create Person for identity', () => {
  it('creates one native Person, binds prior participants and preserves birth author', async () => {
    const before = await snapshot();
    const result = await create();
    expect(result).toMatchObject({ revision: '2', replayed: false });
    expect(result.personId).not.toBeNull();
    expect(
      (await fixture.read('person')).filter(
        (row: { id: string }) => row.id === result.personId,
      ),
    ).toEqual([
      expect.objectContaining({
        nameFirstName: 'SensitiveFirst',
        nameLastName: 'SensitiveLast',
      }),
    ]);
    expect((await fixture.read('messageParticipant'))[0].personId).toBe(
      result.personId,
    );
    expect(await rows('omniMessageLink')).toEqual(before.links);
    expect(await rows('omniConversationTarget')).toHaveLength(0);
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
    expect(fixture.recordStock.acquireRecordStock).toHaveBeenCalledTimes(1);
    expect(
      (await audit()).filter(
        (row) =>
          row.operationId === result.operationId &&
          row.resourceKind === 'omniPerson',
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(await audit())).not.toContain('SensitiveFirst');
    expect(JSON.stringify(await audit())).not.toContain('SensitiveLast');
    expect(
      (
        await fixture.service.applyOmniHistoryReceipt(
          context.principal,
          captured.proof,
          async () => {},
        )
      ).created,
    ).toBe(false);
  });
  it('creates before the first message and later persists its bound native author', async () => {
    context = await fixture.reset();
    await fixture.owner.query(
      'UPDATE core."omniExternalIdentity" SET "personId"=NULL WHERE id=$1',
      [context.externalIdentityId],
    );
    const result = await create();
    captured = await fixture.capture(context);
    await fixture.service.applyOmniHistoryReceipt(
      context.principal,
      captured.proof,
      async () => {},
    );
    expect((await fixture.read('messageParticipant'))[0].personId).toBe(
      result.personId,
    );
  });
  it('does not overwrite later native Person edits on creation replay', async () => {
    const first = await create();
    await fixture.owner.query(
      `UPDATE "${fixture.schemaName}".person SET "nameFirstName"='Later edit' WHERE id=$1`,
      [first.personId],
    );
    const before = await snapshot();
    expect(await create()).toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(before);
  });
  it('keeps committed creation successful if an ordinary after-commit stock callback fails', async () => {
    fixture.recordStock.acquireRecordStock.mockRejectedValueOnce(
      new Error('STOCK_CALLBACK_FAILURE'),
    );
    const result = await create();
    expect(result.replayed).toBe(false);
    expect(
      (await audit()).filter((row) => row.outcome !== 'success'),
    ).toHaveLength(0);
    expect((await create()).replayed).toBe(true);
  });
  it('replays the original creation after unlink without a second Person or rebinding', async () => {
    const first = await create();
    await unlink('2');
    const before = await snapshot();
    expect(await create()).toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(before);
  });
  it('serializes twenty retries into exactly one new Person and one identity transition', async () => {
    const before = await fixture.read('person');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => create()),
    );
    expect(results.filter((x) => !x.replayed)).toHaveLength(1);
    expect(new Set(results.map((x) => x.personId)).size).toBe(1);
    expect(await fixture.read('person')).toHaveLength(before.length + 1);
  });
  it('admits only one of competing different keys with the same expected revision', async () => {
    const before = await fixture.read('person');
    const results = await Promise.allSettled([
      create(command('one')),
      create(command('two')),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await fixture.read('person')).toHaveLength(before.length + 1);
  });
  it('refuses creating a replacement for an already bound identity', async () => {
    await create();
    const before = await snapshot();
    await expect(create(command('replace', '2'))).rejects.toThrow(
      'ALREADY_BOUND',
    );
    expect(await snapshot()).toEqual(before);
  });
  it('rejects conflicting payload and action reuse of an actor key', async () => {
    await create();
    const before = await snapshot();
    const changed = command();
    const modified = {
      ...changed,
      person: { name: { firstName: 'Other', lastName: 'Name' } },
    };
    await expect(create(modified)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await expect(
      fixture.service.setOmniIdentityPerson(
        principal(),
        {
          bindingId: context.bindingId,
          externalIdentityId: context.externalIdentityId,
          personId: null,
          expectedRevision: '1',
          idempotencyKey: 'create-person',
        },
        async () => {},
      ),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(await snapshot()).toEqual(before);
  });
  it.each([false, true])(
    'checks current creation permission, replay: %s',
    async (replay) => {
      if (replay) await create();
      const before = await snapshot();
      await expect(
        create(command(), async () => {
          throw new Error('REVOKED');
        }),
      ).rejects.toThrow('REVOKED');
      expect(await snapshot()).toEqual(before);
    },
  );
  it.each(['person', 'participant', 'identity', 'policy', 'audit', 'receipt'])(
    'rolls back all writes on %s failure',
    async (stage) => {
      const before = await snapshot();
      const table =
        stage === 'person'
          ? `"${fixture.schemaName}".person`
          : stage === 'participant'
            ? `"${fixture.schemaName}"."messageParticipant"`
            : stage === 'identity'
              ? 'core."omniExternalIdentity"'
              : stage === 'policy'
                ? 'core."omniWorkspacePolicyState"'
                : stage === 'audit'
                  ? 'crm_audit."crmAuditEntry"'
                  : 'core."omniPolicyMutationReceipt"';
      const event = ['participant', 'identity', 'policy'].includes(stage)
        ? 'UPDATE'
        : 'INSERT';
      await fixture.owner.query(
        `CREATE FUNCTION crm_audit.fail_create_person_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${stage === 'audit' ? "IF NEW.outcome <> 'success' THEN RETURN NEW; END IF;" : ''} RAISE EXCEPTION 'CREATE_PERSON_INJECTED'; END $$`,
      );
      await fixture.owner.query(
        `CREATE TRIGGER fail_create_person_test BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_create_person_test()`,
      );
      try {
        await expect(create()).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
        expect(fixture.recordStock.acquireRecordStock).not.toHaveBeenCalled();
      } finally {
        await fixture.owner.query(
          `DROP TRIGGER fail_create_person_test ON ${table}`,
        );
        await fixture.owner.query(
          'DROP FUNCTION crm_audit.fail_create_person_test()',
        );
      }
    },
  );
  it('recovers lost real COMMIT acknowledgement through creation replay', async () => {
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
    await expect(create()).rejects.toThrow(/unknown/i);
    const before = await snapshot();
    expect((await create()).replayed).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect((await audit()).filter((x) => x.outcome !== 'success')).toHaveLength(
      0,
    );
  });
  it('refuses creation replay without its native Person audit', async () => {
    const first = await create();
    await fixture.owner.query(
      `DELETE FROM crm_audit."crmAuditEntry" WHERE "operationId"=$1 AND "resourceKind"='omniPerson'`,
      [first.operationId],
    );
    const before = await snapshot();
    await expect(create()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it('snapshots nested names before asynchronous authorization', async () => {
    const input = command();
    let opened!: () => void, release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = create(input, async () => {
      opened();
      await barrier;
    });
    await acquired;
    (input.person.name as { firstName: string }).firstName = 'CallerMutation';
    release();
    const result = await pending;
    expect(
      (await fixture.read('person')).find(
        (row: { id: string }) => row.id === result.personId,
      ).nameFirstName,
    ).toBe('SensitiveFirst');
  });
  it('rejects caller-controlled native fields, empty name and foreign workspace', async () => {
    const before = await snapshot();
    await expect(
      create({
        ...command(),
        person: { ...command().person, id: randomUUID() },
      } as OmniIdentityCreatePersonCommand),
    ).rejects.toThrow();
    await expect(
      create({
        ...command(),
        person: { name: { firstName: '', lastName: '' } },
      }),
    ).rejects.toThrow();
    await expect(
      fixture.service.createPersonForOmniIdentity(
        { ...principal(), workspaceId: randomUUID() },
        command(),
        authorize,
      ),
    ).rejects.toThrow('METADATA_SCOPE');
    expect(await snapshot()).toEqual(before);
  });
  it('rolls back a Person name corrupted during audit flush', async () => {
    const before = await snapshot();
    await fixture.owner.query(
      `CREATE FUNCTION crm_audit.corrupt_created_person() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."resourceKind"='omniPerson' AND NEW.outcome='success' THEN UPDATE "${fixture.schemaName}".person SET "nameFirstName"='Corrupted' WHERE id=NEW."resourceId"::uuid; END IF; RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      'CREATE TRIGGER corrupt_created_person AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.corrupt_created_person()',
    );
    try {
      await expect(create()).rejects.toThrow('CREATED_PERSON_INTEGRITY');
      expect(await snapshot()).toEqual(before);
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER corrupt_created_person ON crm_audit."crmAuditEntry"',
      );
      await fixture.owner.query(
        'DROP FUNCTION crm_audit.corrupt_created_person()',
      );
    }
  });
});
