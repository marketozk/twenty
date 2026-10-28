import { computeObjectTargetTable } from 'src/engine/utils/compute-object-target-table.util';
import { randomUUID } from 'node:crypto';
import { STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS } from 'twenty-shared/metadata';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type OmniConversationTargetAuthorizer } from 'src/modules/omnichannel/services/set-omni-conversation-target';
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

const fixture = createOmniHistoryApplyFixture({
  includeTargets: true,
  includeCrmTargets: true,
});
let context: Awaited<ReturnType<typeof fixture.reset>>;
let metadata: Record<string, string>;
let records: Record<string, string>;
const principal = () => ({
  workspaceId: fixture.workspaceId,
  actor: { kind: 'system' as const, id: 'target-operator' },
});
const authorize: OmniConversationTargetAuthorizer = async (_scope, facts) => {
  if (
    facts.workspaceId !== fixture.workspaceId ||
    facts.conversation.id !== context.conversationId
  )
    throw new Error('DENIED');
};
const apply = (
  kind = 'person',
  active = true,
  revision = '0',
  auth = authorize,
) =>
  fixture.service.setOmniConversationTarget(
    principal(),
    {
      bindingId: context.bindingId,
      conversationId: context.conversationId,
      objectMetadataId: metadata[kind],
      recordId: records[kind],
      expectedTargetRevision: revision,
      active,
    },
    auth,
  );
const rows = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const audit = (): Promise<Record<string, unknown>[]> =>
  fixture.owner.query('SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id');
const snapshot = async () => ({
  targets: await rows('omniConversationTarget'),
  state: await rows('omniWorkspacePolicyState'),
  projections: await fixture.read('messageThreadTarget'),
});
beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    `GRANT INSERT,UPDATE ON core."omniConversationTarget",core."omniWorkspacePolicyState",core."omniExternalIdentity",core."omniPolicyMutationReceipt" TO "${fixture.roleName}"`,
  );
});
beforeEach(async () => {
  context = await fixture.reset();
  const captured = await fixture.capture(context);
  await fixture.service.applyOmniHistoryReceipt(
    context.principal,
    captured.proof,
    fixture.authorizeFor(context),
  );
  metadata = await fixture.withContext(async () => {
    const maps = getWorkspaceContext().flatObjectMetadataMaps;
    return Object.fromEntries(
      ['person', 'company', 'opportunity', 'task'].map((name) => [
        name,
        maps.byUniversalIdentifier[
          STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS[
            name as 'person' | 'company' | 'opportunity' | 'task'
          ]
        ]!.id,
      ]),
    );
  });
  records = { person: context.personId };
  for (const kind of ['company', 'opportunity', 'task']) {
    records[kind] = randomUUID();
    await fixture.owner.query(
      `INSERT INTO "${fixture.schemaName}"."${kind}" (id) VALUES ($1)`,
      [records[kind]],
    );
  }
  fixture.eventEmitter.mockClear();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());
describe('explicit conversation target', () => {
  it.each(['person', 'company', 'opportunity'])(
    'links/unlinks/relinks %s with exact manual projection',
    async (kind) => {
      const first = await apply(kind);
      expect(first).toMatchObject({
        active: true,
        revision: '1',
        replayed: false,
      });
      expect(await fixture.read('messageThreadTarget')).toHaveLength(1);
      expect((await fixture.read('messageThreadTarget'))[0]).toMatchObject({
        id: first.projectionId,
        messageThreadId: context.threadId,
        [`target${kind[0].toUpperCase() + kind.slice(1)}Id`]: records[kind],
        isManuallyAssigned: true,
        isAutomaticallyAssigned: false,
      });
      const before = await snapshot();
      expect(await apply(kind)).toEqual({ ...first, replayed: true });
      expect(await snapshot()).toEqual(before);
      const second = await apply(kind, false, '1');
      expect(second).toMatchObject({
        active: false,
        revision: '2',
        projectionId: null,
      });
      expect(await fixture.read('messageThreadTarget')).toHaveLength(0);
      const third = await apply(kind, true, '2');
      expect(third).toMatchObject({ active: true, revision: '3' });
      expect(third.projectionId).not.toBe(first.projectionId);
      await expect(apply(kind)).rejects.toThrow('REVISION_CONFLICT');
      expect(fixture.eventEmitter).not.toHaveBeenCalled();
    },
  );
  it('stores Task only in canonical core without automatic CRM projections', async () => {
    const result = await apply('task');
    expect(result.projectionId).toBeNull();
    expect(await fixture.read('messageThreadTarget')).toHaveLength(0);
    expect((await apply('task')).replayed).toBe(true);
    await apply('task', false, '1');
  });
  it('links a registered custom object only in core using its actual prefixed table', async () => {
    await fixture.withContext(async () => {
      const maps = getWorkspaceContext().flatObjectMetadataMaps;
      const template =
        maps.byUniversalIdentifier[STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.task]!;
      const universalIdentifier = randomUUID(),
        id = randomUUID();
      const object = {
        ...template,
        id,
        universalIdentifier,
        applicationUniversalIdentifier: randomUUID(),
        nameSingular: 'customOmniContext',
        isCustom: true,
        isSystem: false,
        isActive: true,
      };
      maps.byUniversalIdentifier[universalIdentifier] = object;
      maps.universalIdentifierById[id] = universalIdentifier;
      const table = computeObjectTargetTable(object);
      metadata.custom = id;
      records.custom = randomUUID();
      await fixture.owner.query(
        `CREATE TABLE "${fixture.schemaName}"."${table}" (id uuid PRIMARY KEY,"deletedAt" timestamptz)`,
      );
      await fixture.owner.query(
        `GRANT SELECT,UPDATE ON "${fixture.schemaName}"."${table}" TO "${fixture.roleName}"`,
      );
      try {
        await fixture.owner.query(
          `INSERT INTO "${fixture.schemaName}"."${table}"(id) VALUES ($1)`,
          [records.custom],
        );
        const result = await apply('custom');
        expect(result.projectionId).toBeNull();
        expect(await fixture.read('messageThreadTarget')).toHaveLength(0);
        expect((await apply('custom')).replayed).toBe(true);
        await apply('custom', false, '1');
      } finally {
        delete maps.byUniversalIdentifier[universalIdentifier];
        delete maps.universalIdentifierById[id];
        await fixture.owner.query(
          `DROP TABLE "${fixture.schemaName}"."${table}"`,
        );
      }
    });
  });
  it('refuses unknown/system metadata and a different workspace principal', async () => {
    const before = await snapshot();
    metadata.invalid = randomUUID();
    records.invalid = randomUUID();
    await expect(apply('invalid')).rejects.toThrow('METADATA_SCOPE');
    metadata.system = await fixture.withContext(
      async () =>
        getWorkspaceContext().flatObjectMetadataMaps.byUniversalIdentifier[
          STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.message
        ]!.id,
    );
    records.system = randomUUID();
    await expect(apply('system')).rejects.toThrow('METADATA_SCOPE');
    await expect(
      fixture.service.setOmniConversationTarget(
        { ...principal(), workspaceId: randomUUID() },
        {
          bindingId: context.bindingId,
          conversationId: context.conversationId,
          objectMetadataId: metadata.person,
          recordId: records.person,
          active: true,
          expectedTargetRevision: '0',
        },
        authorize,
      ),
    ).rejects.toThrow('METADATA_SCOPE');
    expect(await snapshot()).toEqual(before);
  });
  it('renews the same desired state only with current revision and preserves its projection', async () => {
    const first = await apply();
    const second = await apply('person', true, '1');
    expect(second.revision).toBe('2');
    expect(second.projectionId).toBe(first.projectionId);
    expect(second.operationId).not.toBe(first.operationId);
    expect((await apply('person', true, '1')).replayed).toBe(true);
    await expect(apply()).rejects.toThrow('REVISION_CONFLICT');
  });
  it('serializes twenty repeated requests into one transition', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => apply()),
    );
    expect(results.filter((x) => !x.replayed)).toHaveLength(1);
    expect(new Set(results.map((x) => x.operationId)).size).toBe(1);
    expect(await rows('omniConversationTarget')).toHaveLength(1);
    expect(await fixture.read('messageThreadTarget')).toHaveLength(1);
  });
  it('allows only one conflicting desired state with the same expected revision', async () => {
    const results = await Promise.allSettled([
      apply('company', true),
      apply('company', false),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await rows('omniConversationTarget'))[0].revision).toBe('1');
  });
  it.each([false, true])(
    'checks current authorization including replay: %s',
    async (replay) => {
      if (replay) await apply();
      const before = await snapshot();
      await expect(
        apply('person', true, '0', async () => {
          throw new Error('REVOKED');
        }),
      ).rejects.toThrow('REVOKED');
      expect(await snapshot()).toEqual(before);
    },
  );
  it('rejects a Person not verified in this conversation', async () => {
    records.person = randomUUID();
    await fixture.owner.query(
      `INSERT INTO "${fixture.schemaName}".person (id) VALUES ($1)`,
      [records.person],
    );
    await expect(apply()).rejects.toThrow('PERSON_IDENTITY_REQUIRED');
    expect(await rows('omniConversationTarget')).toHaveLength(0);
  });
  it('rejects a deleted target and an unknown target identifier', async () => {
    await fixture.owner.query(
      `UPDATE "${fixture.schemaName}".company SET "deletedAt"=now() WHERE id=$1`,
      [records.company],
    );
    await expect(apply('company')).rejects.toThrow('RECORD_NOT_LIVE');
    records.company = randomUUID();
    await expect(apply('company')).rejects.toThrow('RESOURCE_SCOPE');
  });
  it('invalidates writer-created Person projection on identity rebind', async () => {
    const first = await apply();
    const other = randomUUID();
    await fixture.owner.query(
      `INSERT INTO "${fixture.schemaName}".person(id) VALUES ($1)`,
      [other],
    );
    await fixture.service.setOmniIdentityPerson(
      principal(),
      {
        bindingId: context.bindingId,
        externalIdentityId: context.externalIdentityId,
        personId: other,
        expectedRevision: '1',
        idempotencyKey: 'rebind-target',
      },
      async () => {},
    );
    expect((await rows('omniConversationTarget'))[0]).toMatchObject({
      id: first.id,
      active: false,
      revision: '2',
      projectionId: null,
    });
    expect(await fixture.read('messageThreadTarget')).toHaveLength(0);
    await expect(apply()).rejects.toThrow('REVISION_CONFLICT');
  });
  it('refuses a pre-existing native projection instead of adopting it', async () => {
    await fixture.owner.query(
      `INSERT INTO "${fixture.schemaName}"."messageThreadTarget" (id,"messageThreadId","targetPersonId","isManuallyAssigned","isAutomaticallyAssigned") VALUES ($1,$2,$3,true,false)`,
      [randomUUID(), context.threadId, context.personId],
    );
    const before = await snapshot();
    await expect(apply()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it.each(['missing', 'flags', 'record'])(
    'refuses corrupt projection on replay: %s',
    async (corruption) => {
      const first = await apply();
      if (corruption === 'missing')
        await fixture.owner.query(
          `DELETE FROM "${fixture.schemaName}"."messageThreadTarget" WHERE id=$1`,
          [first.projectionId],
        );
      else if (corruption === 'flags')
        await fixture.owner.query(
          `UPDATE "${fixture.schemaName}"."messageThreadTarget" SET "isAutomaticallyAssigned"=true WHERE id=$1`,
          [first.projectionId],
        );
      else
        await fixture.owner.query(
          `UPDATE "${fixture.schemaName}"."messageThreadTarget" SET "targetPersonId"=NULL WHERE id=$1`,
          [first.projectionId],
        );
      const before = await snapshot();
      await expect(apply()).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );
  it('refuses missing success audit for an otherwise matching replay', async () => {
    const first = await apply();
    await fixture.owner.query(
      `DELETE FROM crm_audit."crmAuditEntry" WHERE "operationId"=$1 AND "resourceKind"='omniConversationTarget'`,
      [first.operationId],
    );
    await expect(apply()).rejects.toThrow('TRANSITION_PROOF');
  });
  it('rejects unchanged-field corruption after a revision-only renewal', async () => {
    const first = await apply('task');
    await apply('task', true, '1');
    await fixture.owner.query(
      'UPDATE core."omniConversationTarget" SET active=false WHERE id=$1',
      [first.id],
    );
    const before = await snapshot();
    await expect(apply('task', false, '1')).rejects.toThrow('TRANSITION_PROOF');
    expect(await snapshot()).toEqual(before);
  });
  it.each(['create', 'delete'])(
    'rejects missing native projection %s audit',
    async (action) => {
      const first = await apply();
      if (action === 'delete') await apply('person', false, '1');
      await fixture.owner.query(
        `DELETE FROM crm_audit."crmAuditEntry" WHERE "resourceKind"='omniMessageThreadTarget' AND "resourceId"=$1 AND action=$2`,
        [first.projectionId, action],
      );
      const before = await snapshot();
      await expect(
        apply('person', action === 'create', action === 'create' ? '0' : '1'),
      ).rejects.toThrow('TRANSITION_PROOF');
      expect(await snapshot()).toEqual(before);
    },
  );
  it('rejects a forged immutable target key after renewal', async () => {
    const first = await apply('task');
    await apply('task', true, '1');
    const other = randomUUID();
    await fixture.owner.query(
      `INSERT INTO "${fixture.schemaName}".task(id) VALUES ($1)`,
      [other],
    );
    await fixture.owner.query(
      'UPDATE core."omniConversationTarget" SET "recordId"=$1 WHERE id=$2',
      [other, first.id],
    );
    records.task = other;
    await expect(apply('task', true, '1')).rejects.toThrow('TRANSITION_PROOF');
  });
  it.each(['projection', 'edge', 'policy', 'audit'])(
    'rolls back all writes when %s fails',
    async (stage) => {
      const before = await snapshot();
      const table =
        stage === 'projection'
          ? `"${fixture.schemaName}"."messageThreadTarget"`
          : stage === 'edge'
            ? 'core."omniConversationTarget"'
            : stage === 'policy'
              ? 'core."omniWorkspacePolicyState"'
              : 'crm_audit."crmAuditEntry"';
      await fixture.owner.query(
        `CREATE FUNCTION crm_audit.fail_target_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${stage === 'audit' ? "IF NEW.outcome <> 'success' THEN RETURN NEW; END IF;" : ''} RAISE EXCEPTION 'TARGET_INJECTED'; END $$`,
      );
      await fixture.owner.query(
        `CREATE TRIGGER fail_target_test BEFORE ${stage === 'policy' ? 'UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_target_test()`,
      );
      try {
        await expect(apply()).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
      } finally {
        await fixture.owner.query(`DROP TRIGGER fail_target_test ON ${table}`);
        await fixture.owner.query('DROP FUNCTION crm_audit.fail_target_test()');
      }
    },
  );
  it.each(['link', 'rebind'])(
    'serializes identity rebind against target link, first: %s',
    async (first) => {
      const other = randomUUID();
      await fixture.owner.query(
        `INSERT INTO "${fixture.schemaName}".person(id) VALUES ($1)`,
        [other],
      );
      let opened!: () => void, release!: () => void;
      const acquired = new Promise<void>((resolve) => {
        opened = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const hold = async () => {
        opened();
        await barrier;
      };
      const rebind = (auth: () => Promise<void>) =>
        fixture.service.setOmniIdentityPerson(
          principal(),
          {
            bindingId: context.bindingId,
            externalIdentityId: context.externalIdentityId,
            personId: other,
            expectedRevision: '1',
            idempotencyKey: 'target-race',
          },
          auth,
        );
      const firstOperation =
        first === 'link' ? apply('person', true, '0', hold) : rebind(hold);
      await acquired;
      const secondOperation =
        first === 'link' ? rebind(async () => {}) : apply();
      const resultsPromise = Promise.allSettled([
        firstOperation,
        secondOperation,
      ]);
      release();
      const results = await resultsPromise;
      expect(results[0].status).toBe('fulfilled');
      if (first === 'link') {
        expect(results[1].status).toBe('fulfilled');
        expect((await rows('omniConversationTarget'))[0]).toMatchObject({
          active: false,
          revision: '2',
          projectionId: null,
        });
      } else {
        expect(results[1].status).toBe('rejected');
        expect(await rows('omniConversationTarget')).toHaveLength(0);
      }
      expect(await fixture.read('messageThreadTarget')).toHaveLength(0);
    },
  );
  it('protects a writer-created inactive Company target from generic deletion', async () => {
    await apply('company');
    await apply('company', false, '1');
    await expect(
      fixture.withContext(() =>
        fixture.dataSource.transaction((scope) =>
          scope
            .getRepository('company', { shouldBypassPermissionChecks: true })
            .delete({ id: records.company }),
        ),
      ),
    ).rejects.toThrow('OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND');
    expect(
      await fixture.owner.query(
        `SELECT id FROM "${fixture.schemaName}".company WHERE id=$1`,
        [records.company],
      ),
    ).toHaveLength(1);
  });
  it('rolls back late canonical corruption caused during audit flush', async () => {
    const before = await snapshot();
    await fixture.owner.query(
      `CREATE FUNCTION crm_audit.corrupt_target_final() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."resourceKind"='omniConversationTarget' AND NEW.outcome='success' THEN UPDATE core."omniConversationTarget" SET active=false WHERE id=NEW."resourceId"::uuid; END IF; RETURN NEW; END $$`,
    );
    await fixture.owner.query(
      'CREATE TRIGGER corrupt_target_final AFTER INSERT ON crm_audit."crmAuditEntry" FOR EACH ROW EXECUTE FUNCTION crm_audit.corrupt_target_final()',
    );
    try {
      await expect(apply('task')).rejects.toThrow('FINAL_EDGE');
      expect(await snapshot()).toEqual(before);
    } finally {
      await fixture.owner.query(
        'DROP TRIGGER corrupt_target_final ON crm_audit."crmAuditEntry"',
      );
      await fixture.owner.query(
        'DROP FUNCTION crm_audit.corrupt_target_final()',
      );
    }
  });
  it('recovers real lost COMMIT acknowledgement by audited read-only replay', async () => {
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
    await expect(apply()).rejects.toThrow(/unknown/i);
    const before = await snapshot();
    expect((await apply()).replayed).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect((await audit()).filter((x) => x.outcome !== 'success')).toHaveLength(
      0,
    );
  });
});
