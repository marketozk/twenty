import { randomUUID } from 'node:crypto';

import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { TrashCleanupService } from 'src/engine/trash-cleanup/services/trash-cleanup.service';
import { createOmniNativeCleanupFixture } from 'test/fork-migration/omni-native-cleanup.fixture';

jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock(
  'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service',
  () => ({ WorkspaceManyOrAllFlatEntityMapsCacheService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/message-channel/entities/message-channel.entity',
  () => ({ MessageChannelEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/connected-account/entities/connected-account.entity',
  () => ({ ConnectedAccountEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.entity',
  () => ({ UserWorkspaceEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);

const fixture = createOmniNativeCleanupFixture();
const permissions = { shouldBypassPermissionChecks: true as const };
const denied = 'OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND';
let seed: Awaited<ReturnType<typeof fixture.seed>>;
const repository = (name: string, skip = true) =>
  fixture.dataSource.getRepository(name, permissions, {
    shouldSkipEventEmission: skip,
  });
const objectId = (name: string) =>
  fixture.withContext(
    async () => getWorkspaceContext().objectIdByNameSingular[name],
  );
const insert = async (name: string, fields: Record<string, unknown> = {}) => {
  const id = randomUUID();
  await fixture.withContext(() => repository(name).insert({ id, ...fields }));
  return id;
};
const parent = async (
  name: 'person' | 'company' | 'opportunity' | 'messageCampaign',
) => {
  if (name === 'person') return seed.personId;
  const id = await insert(name);
  await fixture.seedNative(async (scope) => {
    if (name === 'messageCampaign') {
      await scope
        .getRepository('message', permissions)
        .update(seed.omni.messageId, { messageCampaignId: id });
      await scope
        .getRepository('messageParticipant', permissions)
        .update(seed.omni.participantId, { messageCampaignId: id });
    } else {
      await scope.getRepository('messageThreadTarget', permissions).insert({
        id: randomUUID(),
        messageThreadId: seed.omni.threadId,
        [name === 'company' ? 'targetCompanyId' : 'targetOpportunityId']: id,
      });
    }
  });
  return id;
};
const snapshot = () =>
  Promise.all(
    [
      'person',
      'company',
      'opportunity',
      'messageCampaign',
      'message',
      'messageParticipant',
      'messageThreadTarget',
    ].map((name) =>
      fixture.owner.query(
        `SELECT * FROM "${fixture.schemaName}"."${name}" ORDER BY id`,
      ),
    ),
  );
const trash = (names: string[]) =>
  new TrashCleanupService(
    {
      getOrRecomputeManyOrAllFlatEntityMaps: async () => ({
        flatObjectMetadataMaps: {
          byUniversalIdentifier: Object.fromEntries(
            await Promise.all(
              names.map(async (name) => [
                name,
                { nameSingular: name, id: await objectId(name) },
              ]),
            ),
          ),
        },
      }),
    } as unknown as ConstructorParameters<typeof TrashCleanupService>[0],
    fixture.manager,
  );
const runTrash = (names: string[]) =>
  trash(names).cleanupWorkspaceTrash({
    workspaceId: fixture.workspaceId,
    trashRetentionDays: 30,
  });
const markOld = (name: string, ids: string[]) =>
  fixture.owner.query(
    `UPDATE "${fixture.schemaName}"."${name}" SET "deletedAt"='2020-01-01' WHERE id=ANY($1::uuid[])`,
    [ids],
  );
const conversation = () =>
  fixture.coreInsert('omniConversation', {
    workspaceId: fixture.workspaceId,
    bindingId: seed.bindingId,
    providerChatId: randomUUID(),
    messageThreadId: seed.omni.threadId,
    policyId: seed.policyId,
    policyVersion: '0',
  });

beforeAll(() => fixture.initialize());
beforeEach(async () => {
  await fixture.reset();
  seed = await fixture.seed();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('CRM parent hard deletion and trash retention', () => {
  it.each(['person', 'company', 'opportunity', 'messageCampaign'] as const)(
    'blocks %s FK changes through generic delete with bypass and skipped events',
    async (name) => {
      const id = await parent(name);
      const before = await snapshot();
      fixture.eventEmitter.mockClear();
      await expect(
        fixture.withContext(() => repository(name).delete(id)),
      ).rejects.toThrow(denied);
      expect(await snapshot()).toEqual(before);
      expect(fixture.eventEmitter).not.toHaveBeenCalled();
    },
  );

  it('does not grant parent delete through the typed native write capability', async () => {
    await expect(
      fixture.seedNative((scope) =>
        scope.getRepository('person', permissions).delete(seed.personId),
      ),
    ).rejects.toThrow(denied);
  });

  it('preserves soft delete, restore and ordinary updates of a linked person', async () => {
    await fixture.withContext(async () => {
      await repository('person').softDelete(seed.personId);
      await repository('person').restore(seed.personId);
      await repository('person').update(seed.personId, {
        name: { firstName: 'Changed', lastName: 'Name' },
      });
    });
    expect(
      (await fixture.read('messageParticipant')).find(
        (row: { id: string }) => row.id === seed.omni.participantId,
      ).personId,
    ).toBe(seed.personId);
    expect((await fixture.read('person'))[0].deletedAt).toBeNull();
  });

  it.each(['binding', 'link', 'conversation'] as const)(
    'retains person history with %s-only ownership including disabled bindings',
    async (marker) => {
      await fixture.reset();
      seed = await fixture.seed(marker);
      await expect(
        fixture.withContext(() =>
          repository('person', false).delete(seed.personId),
        ),
      ).rejects.toThrow(denied);
    },
  );

  it('rolls back a mixed delete and a preceding CRM update', async () => {
    const ordinary = await insert('person', { name: { firstName: 'Before' } });
    const before = await snapshot();
    await expect(
      fixture.run(async (scope) => {
        await scope
          .getRepository('person', permissions)
          .update(ordinary, { name: { firstName: 'After' } });
        await scope
          .getRepository('person', permissions)
          .delete([ordinary, seed.personId]);
      }),
    ).rejects.toThrow(denied);
    expect(await snapshot()).toEqual(before);
  });

  it('blocks the direct delete kernel used by merge', async () => {
    await expect(
      fixture.withContext(() =>
        repository('person').runMutation({
          kind: 'delete',
          selectQueryBuilder: repository('person')
            .createQueryBuilder()
            .where({ id: seed.personId }),
          rowLevelPermissionsApplied: true,
          columnsToReturn: ['id'],
        }),
      ),
    ).rejects.toThrow(denied);
  });

  it('keeps ordinary email FK SET NULL/CASCADE behavior', async () => {
    const ordinary = await insert('person');
    await fixture.withContext(async () => {
      await repository('messageParticipant').update(seed.email.participantId, {
        personId: ordinary,
      });
      await repository('messageThreadTarget').update(seed.email.targetId, {
        targetPersonId: ordinary,
      });
      const result = await repository('person', false).delete(ordinary);
      expect(result.affected).toBe(1);
    });
    expect(
      (await fixture.read('messageParticipant')).find(
        (row: { id: string }) => row.id === seed.email.participantId,
      ).personId,
    ).toBeNull();
    expect(
      (await fixture.read('messageThreadTarget')).some(
        (row: { id: string }) => row.id === seed.email.targetId,
      ),
    ).toBe(false);
    expect(
      (await fixture.read('messageParticipant')).find(
        (row: { id: string }) => row.id === seed.omni.participantId,
      ).personId,
    ).toBe(seed.personId);
    expect(fixture.eventEmitter).toHaveBeenCalled();
  });

  it('blocks retained identity without any native participant', async () => {
    const id = await insert('person');
    await fixture.coreInsert('omniExternalIdentity', {
      workspaceId: fixture.workspaceId,
      bindingId: seed.bindingId,
      providerPeerId: randomUUID(),
      personId: id,
      verificationSource: 'fixture',
    });
    await expect(
      fixture.withContext(() => repository('person').delete(id)),
    ).rejects.toThrow(denied);
  });

  it.each(['person', 'company', 'opportunity', 'blocklist'])(
    'blocks retained inactive core target for %s without projection',
    async (name) => {
      const id = name === 'blocklist' ? seed.blocklistId : await insert(name);
      await fixture.coreInsert('omniConversationTarget', {
        workspaceId: fixture.workspaceId,
        conversationId: await conversation(),
        objectMetadataId: await objectId(name),
        recordId: id,
        active: false,
        projectionId: null,
      });
      await expect(
        fixture.withContext(() => repository(name).delete(id)),
      ).rejects.toThrow(denied);
    },
  );

  it('matches core target by exact object metadata identity', async () => {
    const id = await insert('company');
    await fixture.coreInsert('omniConversationTarget', {
      workspaceId: fixture.workspaceId,
      conversationId: await conversation(),
      objectMetadataId: await objectId('person'),
      recordId: id,
      active: false,
    });
    expect(
      (await fixture.withContext(() => repository('company').delete(id)))
        .affected,
    ).toBe(1);
  });

  it('fails closed when retained core ownership cannot be read', async () => {
    const id = await insert('person');
    await fixture.owner.query(
      `REVOKE SELECT ON core."omniConversationTarget" FROM "${fixture.roleName}"`,
    );
    try {
      await expect(
        fixture.withContext(() => repository('person').delete(id)),
      ).rejects.toThrow();
    } finally {
      await fixture.owner.query(
        `GRANT SELECT ON core."omniConversationTarget" TO "${fixture.roleName}"`,
      );
    }
    expect(
      (await fixture.read('person')).some(
        (row: { id: string }) => row.id === id,
      ),
    ).toBe(true);
  });

  it('does not block the intended WorkspaceMember SET NULL lifecycle', async () => {
    const id = await insert('workspaceMember', {
      userId: randomUUID(),
      name: { firstName: 'Manager' },
    });
    await fixture.seedNative((scope) =>
      scope
        .getRepository('messageParticipant', permissions)
        .update(seed.omni.participantId, { workspaceMemberId: id }),
    );
    expect(
      (
        await fixture.withContext(() =>
          repository('workspaceMember').delete(id),
        )
      ).affected,
    ).toBe(1);
    expect(
      (await fixture.read('messageParticipant')).find(
        (row: { id: string }) => row.id === seed.omni.participantId,
      ).workspaceMemberId,
    ).toBeNull();
  });

  it('advances over a full protected trash page and deletes the following ordinary record', async () => {
    const conversationId = await conversation();
    const records = Array.from({ length: 1000 }, () => ({ id: randomUUID() }));
    await fixture.withContext(() => repository('person').insert(records));
    await fixture.owner.query(
      `UPDATE "${fixture.schemaName}"."person" SET "deletedAt"='2019-01-01T00:00:00.000123Z' WHERE id=ANY($1::uuid[])`,
      [records.map((row) => row.id)],
    );
    await fixture.owner.query(
      `INSERT INTO core."omniConversationTarget" (id, "workspaceId", "conversationId", "objectMetadataId", "recordId") SELECT uuid_generate_v4(), $1, $2, $3, unnest($4::uuid[])`,
      [
        fixture.workspaceId,
        conversationId,
        await objectId('person'),
        records.map((row) => row.id),
      ],
    );
    const ordinary = await insert('person');
    await markOld('person', [ordinary]);
    expect(await runTrash(['person'])).toBe(1);
    expect((await fixture.read('person')).length).toBe(1001);
  });

  it('skips protected native rows and continues ordinary native trash', async () => {
    await markOld('messageParticipant', [
      seed.omni.participantId,
      seed.email.participantId,
    ]);
    expect(await runTrash(['messageParticipant'])).toBe(1);
    expect(
      (await fixture.read('messageParticipant')).map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual([seed.omni.participantId]);
  });

  it('does not repeatedly select equal-date protected rows', async () => {
    const ordinary = await insert('person');
    await markOld('person', [seed.personId, ordinary]);
    const service = trash(['person']);
    Object.defineProperty(service, 'batchSize', { value: 1 });
    expect(
      await service.cleanupWorkspaceTrash({
        workspaceId: fixture.workspaceId,
        trashRetentionDays: 30,
      }),
    ).toBe(1);
    expect(await runTrash(['person'])).toBe(0);
  });

  it('preserves a record restored after trash selection but before parent row lock', async () => {
    const id = await insert('person');
    await markOld('person', [id]);
    const client = await fixture.pool.connect();
    const query = client.query.bind(client);
    let restored = false;
    jest.spyOn(client, 'query').mockImplementation((async (
      sql: string | { text: string; values?: unknown[] },
      values?: unknown[],
    ) => {
      const text = typeof sql === 'string' ? sql : sql.text;
      if (
        !restored &&
        text.includes('SELECT * FROM') &&
        text.includes('."person"') &&
        text.includes('FOR UPDATE')
      ) {
        restored = true;
        await fixture.owner.query(
          `UPDATE "${fixture.schemaName}"."person" SET "deletedAt"=NULL WHERE id=$1`,
          [id],
        );
      }
      return query(sql, values);
    }) as typeof client.query);
    jest
      .spyOn(fixture.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    expect(await runTrash(['person'])).toBe(0);
    expect(restored).toBe(true);
    expect(
      (await fixture.read('person')).find(
        (row: { id: string }) => row.id === id,
      ).deletedAt,
    ).toBeNull();
  });
});
