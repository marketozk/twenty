import { randomUUID } from 'node:crypto';

import {
  createOmniNativeCleanupFixture,
  type CleanupMarker,
} from 'test/fork-migration/omni-native-cleanup.fixture';

jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
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
type Seed = Awaited<ReturnType<typeof fixture.seed>>;
const tables = [
  'message',
  'messageThread',
  'messageParticipant',
  'messageThreadTarget',
  'messageChannelMessageAssociation',
  'messageChannelMessageAssociationMessageFolder',
] as const;
const allSnapshot = async () =>
  Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => [table, await fixture.read(table)]),
    ),
  );
const protectedSnapshot = async (seed: Seed) => ({
  message: (await fixture.read('message')).filter(
    (row: { id: string }) => row.id === seed.omni.messageId,
  ),
  thread: (await fixture.read('messageThread')).filter(
    (row: { id: string }) => row.id === seed.omni.threadId,
  ),
  participant: (await fixture.read('messageParticipant')).filter(
    (row: { messageId: string }) => row.messageId === seed.omni.messageId,
  ),
  targets: (await fixture.read('messageThreadTarget')).filter(
    (row: { messageThreadId: string }) =>
      row.messageThreadId === seed.omni.threadId,
  ),
  associations: (await fixture.read('messageChannelMessageAssociation')).filter(
    (row: { messageId: string }) => row.messageId === seed.omni.messageId,
  ),
  junctions: (
    await fixture.read('messageChannelMessageAssociationMessageFolder')
  ).filter(
    (row: { messageChannelMessageAssociationId: string }) =>
      row.messageChannelMessageAssociationId === seed.omni.associationId,
  ),
});
const noEmail = async (seed: Seed) => {
  expect(
    (await fixture.read('message')).find(
      (row: { id: string }) => row.id === seed.email.messageId,
    ),
  ).toBeUndefined();
  expect(
    (await fixture.read('messageThread')).find(
      (row: { id: string }) => row.id === seed.email.threadId,
    ),
  ).toBeUndefined();
  expect(
    (await fixture.read('messageParticipant')).find(
      (row: { messageId: string }) => row.messageId === seed.email.messageId,
    ),
  ).toBeUndefined();
  expect(
    (await fixture.read('messageThreadTarget')).find(
      (row: { messageThreadId: string }) =>
        row.messageThreadId === seed.email.threadId,
    ),
  ).toBeUndefined();
  expect(
    (await fixture.read('messageChannelMessageAssociationMessageFolder')).find(
      (row: { id: string }) => row.id === seed.email.junctionId,
    ),
  ).toBeUndefined();
};
const targeted = (
  seed: Seed,
  externalIds = [seed.omni.externalId, seed.email.externalId],
) =>
  fixture.cleaner.deleteMessagesChannelMessageAssociationsAndRelatedOrphans({
    workspaceId: fixture.workspaceId,
    messageChannelId: seed.channelId,
    messageExternalIds: externalIds,
  });
const folder = (seed: Seed, workspaceId = fixture.workspaceId) =>
  fixture.folders.deleteFolderMessages(
    workspaceId,
    { id: seed.channelId } as Parameters<
      typeof fixture.folders.deleteFolderMessages
    >[1],
    { id: seed.folderId, name: 'Fixture folder' } as Parameters<
      typeof fixture.folders.deleteFolderMessages
    >[2],
  );
const blocklist = (seed: Seed, workspaceId = fixture.workspaceId) =>
  fixture.blocklist.handle({
    workspaceId,
    events: [{ recordId: seed.blocklistId }],
  } as Parameters<typeof fixture.blocklist.handle>[0]);

beforeAll(() => fixture.initialize());
beforeEach(() => fixture.reset());
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('native cleanup preserves independently owned omni records', () => {
  it.each(['binding', 'link', 'conversation'] as const)(
    'targeted cleanup keeps %s-owned full graph and deletes ordinary email by native cascades',
    async (marker: CleanupMarker) => {
      const seed = await fixture.seed(marker);
      const before = await protectedSnapshot(seed);
      await targeted(seed);
      await noEmail(seed);
      expect(await protectedSnapshot(seed)).toEqual(before);
      fixture.eventEmitter.mockClear();
      await targeted(seed);
      await fixture.cleaner.cleanOrphanMessagesAndThreads(fixture.workspaceId);
      expect(await protectedSnapshot(seed)).toEqual(before);
      expect(fixture.eventEmitter).not.toHaveBeenCalled();
    },
  );

  it.each(['binding', 'link', 'conversation'] as const)(
    'channel cleanup preserves %s-owned associations and their folder junctions',
    async (marker: CleanupMarker) => {
      const seed = await fixture.seed(marker);
      const before = await protectedSnapshot(seed);
      await fixture.cleaner.deleteMessageChannelMessageAssociationsByChannelId({
        workspaceId: fixture.workspaceId,
        messageChannelId: seed.channelId,
      });
      await fixture.cleaner.cleanOrphanMessagesAndThreads(fixture.workspaceId);
      await noEmail(seed);
      expect(await protectedSnapshot(seed)).toEqual(before);
    },
  );

  it.each(['binding', 'link', 'conversation'] as const)(
    'folder deletion skips %s-owned graph and counts only ordinary records',
    async (marker: CleanupMarker) => {
      const seed = await fixture.seed(marker);
      const before = await protectedSnapshot(seed);
      expect(await folder(seed)).toBe(1);
      await noEmail(seed);
      expect(await protectedSnapshot(seed)).toEqual(before);
      expect(await folder(seed)).toBe(0);
    },
  );

  it.each(['binding', 'link', 'conversation'] as const)(
    'direct blocklist job skips %s-owned graph while ordinary sender is removed',
    async (marker: CleanupMarker) => {
      const seed = await fixture.seed(marker);
      const before = await protectedSnapshot(seed);
      await blocklist(seed);
      await noEmail(seed);
      expect(await protectedSnapshot(seed)).toEqual(before);
    },
  );

  it.each(['link', 'conversation'] as const)(
    'orphan sweep preserves %s-owned message after every channel association is missing',
    async (marker) => {
      const seed = await fixture.seed(marker);
      await fixture.owner.query(
        `DELETE FROM "${fixture.schemaName}"."messageChannelMessageAssociation" WHERE "messageId" IN ($1,$2)`,
        [seed.omni.messageId, seed.email.messageId],
      );
      const before = await protectedSnapshot(seed);
      await fixture.cleaner.cleanOrphanMessagesAndThreads(fixture.workspaceId);
      await noEmail(seed);
      expect(await protectedSnapshot(seed)).toEqual(before);
    },
  );

  it('preserves an empty conversation-owned thread while removing an empty ordinary thread', async () => {
    const seed = await fixture.seed('conversation');
    await fixture.owner.query(
      `DELETE FROM "${fixture.schemaName}"."message" WHERE id IN ($1,$2)`,
      [seed.omni.messageId, seed.email.messageId],
    );
    const before = await protectedSnapshot(seed);
    await fixture.cleaner.cleanOrphanMessagesAndThreads(fixture.workspaceId);
    expect(await protectedSnapshot(seed)).toEqual(before);
    expect(
      (await fixture.read('messageThread')).map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual([seed.omni.threadId]);
  });

  const seedPages = async (count: number) => {
    const seed = await fixture.seed('conversation');
    await fixture.owner.query(
      `DELETE FROM "${fixture.schemaName}"."messageChannelMessageAssociation" WHERE "messageChannelId"=$1`,
      [seed.channelId],
    );
    const protectedMessageIds: string[] = [
      seed.omni.messageId,
      ...Array.from({ length: count - 1 }, () => randomUUID()),
    ];
    await fixture.seedNative(async (scope) => {
      // Construction only; cleanup below retains the ordinary transaction scope.
      // One live association per channel/message is a real standard unique index.
      await scope
        .getRepository('message', { shouldBypassPermissionChecks: true })
        .insert(
          protectedMessageIds.slice(1).map((id) => ({
            id,
            messageThreadId: seed.omni.threadId,
            headerMessageId: randomUUID(),
            subject: 'Protected page message',
            text: 'Protected page body',
            receivedAt: new Date('2026-10-27T00:00:00Z'),
            isDraft: false,
          })),
        );
      const associations = Array.from({ length: count }, (_, index) => ({
        id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
        messageId: protectedMessageIds[index],
        messageChannelId: seed.channelId,
        messageExternalId: `protected-${index}`,
        messageThreadExternalId: 'protected',
        direction: 'INCOMING',
      }));
      associations.push({
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        messageId: seed.email.messageId,
        messageChannelId: seed.channelId,
        messageExternalId: 'email',
        messageThreadExternalId: 'email',
        direction: 'INCOMING',
      });
      await scope
        .getRepository('messageChannelMessageAssociation', {
          shouldBypassPermissionChecks: true,
        })
        .insert(associations);
      await scope
        .getRepository('messageChannelMessageAssociationMessageFolder', {
          shouldBypassPermissionChecks: true,
        })
        .insert(
          associations.map((row) => ({
            id: row.id,
            messageChannelMessageAssociationId: row.id,
            messageFolderId: seed.folderId,
          })),
        );
    });
    return { ...seed, protectedMessageIds };
  };

  it('advances past 500 protected channel rows and deletes the ordinary next page', async () => {
    const seed = await seedPages(500);
    await fixture.cleaner.deleteMessageChannelMessageAssociationsByChannelId({
      workspaceId: fixture.workspaceId,
      messageChannelId: seed.channelId,
    });
    expect(await fixture.read('messageChannelMessageAssociation')).toHaveLength(
      500,
    );
    expect(
      await fixture.read('messageChannelMessageAssociationMessageFolder'),
    ).toHaveLength(500);
    expect(
      (await fixture.read('messageChannelMessageAssociation')).every(
        (row: { messageId: string }) =>
          seed.protectedMessageIds.includes(row.messageId),
      ),
    ).toBe(true);
    await fixture.cleaner.cleanOrphanMessagesAndThreads(fixture.workspaceId);
    await noEmail(seed);
  });

  it('advances past 200 protected folder rows and deletes the ordinary next page without starvation', async () => {
    const seed = await seedPages(200);
    expect(await folder(seed)).toBe(1);
    expect(await fixture.read('messageChannelMessageAssociation')).toHaveLength(
      200,
    );
    expect(
      await fixture.read('messageChannelMessageAssociationMessageFolder'),
    ).toHaveLength(200);
    await noEmail(seed);
    expect(await folder(seed)).toBe(0);
  });

  it('retains a junction belonging to a different channel in the same folder', async () => {
    const seed = await fixture.seed('conversation');
    await fixture.owner.query(
      `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociation" SET "messageChannelId"=$1 WHERE id=$2`,
      [seed.protectedChannelId, seed.email.associationId],
    );
    const before = await allSnapshot();
    expect(await folder(seed)).toBe(0);
    expect(await allSnapshot()).toEqual(before);
  });

  it('removes ordinary soft-deleted association junctions while retaining owned soft-deleted junctions', async () => {
    const seed = await fixture.seed('conversation');
    await fixture.owner.query(
      `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociation" SET "deletedAt"=clock_timestamp() WHERE id IN ($1,$2)`,
      [seed.omni.associationId, seed.email.associationId],
    );
    const before = await protectedSnapshot(seed);
    expect(await folder(seed)).toBe(0);
    expect(await protectedSnapshot(seed)).toEqual(before);
    expect(
      (await fixture.read('messageChannelMessageAssociationMessageFolder')).map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual([seed.omni.junctionId]);
    // Native cleaner ignores already deleted associations; this asserts junction cleanup only.
    expect(
      (await fixture.read('messageChannelMessageAssociation')).find(
        (row: { id: string }) => row.id === seed.email.associationId,
      ),
    ).toBeDefined();
  });

  it('rolls back earlier deletion when a later ownership SQL query fails', async () => {
    const seed = await fixture.seed('conversation');
    const before = await allSnapshot();
    await fixture.owner.query(
      `CREATE FUNCTION core.log034_revoke_ownership() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN REVOKE SELECT ON core."omniMessageLink" FROM "${fixture.roleName}"; RETURN OLD; END $$`,
    );
    await fixture.owner.query(
      `CREATE TRIGGER log034_revoke_ownership AFTER DELETE ON "${fixture.schemaName}"."messageChannelMessageAssociation" FOR EACH ROW EXECUTE FUNCTION core.log034_revoke_ownership()`,
    );
    try {
      await expect(targeted(seed)).rejects.toThrow();
      expect(await allSnapshot()).toEqual(before);
      expect(fixture.eventEmitter).not.toHaveBeenCalled();
    } finally {
      await fixture.owner.query(
        `DROP TRIGGER log034_revoke_ownership ON "${fixture.schemaName}"."messageChannelMessageAssociation"`,
      );
      await fixture.owner.query('DROP FUNCTION core.log034_revoke_ownership()');
      await fixture.owner.query(
        `GRANT SELECT ON core."omniMessageLink" TO "${fixture.roleName}"`,
      );
    }
  });

  it.each(['targeted', 'channel', 'orphan', 'folder', 'blocklist'] as const)(
    'rejects workspace mismatch at %s entry without any mutations',
    async (entry) => {
      const seed = await fixture.seed();
      const before = await allSnapshot();
      const workspaceId = randomUUID();
      const work =
        entry === 'targeted'
          ? fixture.cleaner.deleteMessagesChannelMessageAssociationsAndRelatedOrphans(
              {
                workspaceId,
                messageChannelId: seed.channelId,
                messageExternalIds: ['omni', 'email'],
              },
            )
          : entry === 'channel'
            ? fixture.cleaner.deleteMessageChannelMessageAssociationsByChannelId(
                { workspaceId, messageChannelId: seed.channelId },
              )
            : entry === 'orphan'
              ? fixture.cleaner.cleanOrphanMessagesAndThreads(workspaceId)
              : entry === 'folder'
                ? folder(seed, workspaceId)
                : blocklist(seed, workspaceId);
      await expect(work).rejects.toThrow('WORKSPACE_MISMATCH');
      expect(await allSnapshot()).toEqual(before);
    },
  );
});
