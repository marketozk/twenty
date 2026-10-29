import { randomUUID } from 'node:crypto';
import { deleteNativeMessageAssociationsAndRelatedOrphansWithAudit } from 'src/engine/core-modules/crm-audit/delete-native-message-associations-and-related-orphans-with-audit';
import { type OrdinaryFolderAction } from 'src/modules/omnichannel/services/ordinary-folder-action';
import {
  membershipCleanupOperation,
  systemMembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';

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
const channelCleanupOperation = (workspaceId = fixture.workspaceId) =>
  membershipCleanupOperation(
    workspaceId,
    systemMembershipCleanupIdentity(
      workspaceId,
      'MessagingMessageChannelDeletionCleanupJob',
    ),
  )!;
const actionVersion = '2026-10-28T00:00:00.123456Z';
// The lower owner admits ordinary account authority and retains independently
// owned records. Higher sync/folder gates deliberately reject this mixed graph.
const seedWithOrdinaryAccount = async (
  marker: CleanupMarker = 'binding',
  separateOrdinaryFolder = false,
) => {
  const seeded = await fixture.seed(marker);
  const ordinaryAccountId = await fixture.coreInsert('connectedAccount', {
    workspaceId: fixture.workspaceId,
    provider: 'google',
  });
  await fixture.owner.query(
    'UPDATE core."messageChannel" SET "connectedAccountId"=$2 WHERE id=$1',
    [seeded.channelId, ordinaryAccountId],
  );
  await fixture.coreInsert('messageFolder', {
    id: seeded.folderId,
    workspaceId: fixture.workspaceId,
    messageChannelId: seeded.channelId,
    pendingSyncAction: 'FOLDER_DELETION',
    isSynced: true,
    externalId: 'fixture-folder',
    name: 'Fixture folder',
    parentFolderId: null,
    updatedAt: actionVersion,
  });
  if (separateOrdinaryFolder) {
    // A shared real folder is itself protected through its omni junction.
    // Lower per-record tests need an ordinary child container as well as an
    // ordinary account; higher mixed-folder admission tests keep it shared.
    const ordinaryFolderId = await fixture.coreInsert('messageFolder', {
      workspaceId: fixture.workspaceId,
      messageChannelId: seeded.channelId,
      pendingSyncAction: 'FOLDER_DELETION',
      isSynced: true,
      externalId: 'ordinary-folder',
      name: 'Ordinary folder',
      parentFolderId: null,
      updatedAt: actionVersion,
    });
    await fixture.owner.query(
      `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociationMessageFolder" SET "messageFolderId"=$2 WHERE id=$1`,
      [seeded.email.junctionId, ordinaryFolderId],
    );
  }
  return { ...seeded, ordinaryAccountId };
};
type Seed = Awaited<ReturnType<typeof seedWithOrdinaryAccount>>;
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
  fixture.withContext(() =>
    fixture.dataSource.transaction(
      (scope) =>
        deleteNativeMessageAssociationsAndRelatedOrphansWithAudit({
          scope,
          operation: channelCleanupOperation(),
          messageChannelId: seed.channelId,
          messageExternalIds: externalIds,
        }),
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    ),
  );
const folder = (seed: Seed, workspaceId = fixture.workspaceId) => {
  // The metadata values match; this proof cannot grant authority over a mixed-owned account.
  const action: OrdinaryFolderAction = {
    workspaceId,
    messageChannelId: seed.channelId,
    connectedAccountId: seed.ordinaryAccountId,
    messageFolderId: seed.folderId,
    action: 'FOLDER_DELETION',
    isSynced: true,
    externalId: 'fixture-folder',
    name: 'Fixture folder',
    parentFolderId: null,
    updatedAt: actionVersion,
    channelUpdatedAt: actionVersion,
    hierarchy: [],
  };
  return fixture.folders.deleteFolderMessages(
    workspaceId,
    { id: seed.channelId } as Parameters<
      typeof fixture.folders.deleteFolderMessages
    >[1],
    { id: seed.folderId, name: 'Fixture folder' } as Parameters<
      typeof fixture.folders.deleteFolderMessages
    >[2],
    action,
  );
};
const blocklist = (seed: Seed, workspaceId = fixture.workspaceId) =>
  fixture.blocklist.handle({
    workspaceId,
    events: [{ recordId: seed.blocklistId }],
  } as Parameters<typeof fixture.blocklist.handle>[0]);

beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid, ADD provider text, ADD "applicationId" uuid, ADD "connectionProviderId" uuid, ADD "userWorkspaceId" uuid',
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageChannel" ADD "pendingGroupEmailsAction" text, ADD "excludeGroupEmails" boolean, ADD "updatedAt" timestamptz NOT NULL DEFAULT \'2026-10-28T00:00:00.123456Z\'',
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageFolder" ADD "pendingSyncAction" text, ADD "isSynced" boolean, ADD "externalId" text, ADD name text, ADD "parentFolderId" text, ADD "updatedAt" timestamptz NOT NULL DEFAULT now()',
  );
  await fixture.owner.query(
    `GRANT SELECT, UPDATE ON core."connectedAccount", core."messageChannel", core."messageFolder" TO "${fixture.roleName}"`,
  );
});
beforeEach(() => fixture.reset());
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('native cleanup preserves independently owned omni records', () => {
  it.each(['binding', 'link', 'conversation'] as const)(
    'lower targeted owner keeps %s-owned full graph and deletes ordinary email by native cascades',
    async (marker: CleanupMarker) => {
      const seed = await seedWithOrdinaryAccount(marker, true);
      const before = await protectedSnapshot(seed);
      await targeted(seed);
      await noEmail(seed);
      expect(await protectedSnapshot(seed)).toEqual(before);
      fixture.eventEmitter.mockClear();
      await targeted(seed);
      await fixture.cleaner.cleanOrphanMessagesAndThreads(
        fixture.workspaceId,
        channelCleanupOperation(),
      );
      expect(await protectedSnapshot(seed)).toEqual(before);
      expect(fixture.eventEmitter).not.toHaveBeenCalled();
    },
  );

  it.each(['binding', 'link', 'conversation'] as const)(
    'channel cleanup preserves %s-owned associations and their folder junctions',
    async (marker: CleanupMarker) => {
      const seed = await seedWithOrdinaryAccount(marker);
      const before = await protectedSnapshot(seed);
      await fixture.owner.query(
        'DELETE FROM core."messageChannel" WHERE id=$1',
        [seed.channelId],
      );
      await fixture.cleaner.deleteMessageChannelMessageAssociationsByChannelId({
        workspaceId: fixture.workspaceId,
        messageChannelId: seed.channelId,
        auditOperation: channelCleanupOperation(),
      });
      await fixture.cleaner.cleanOrphanMessagesAndThreads(
        fixture.workspaceId,
        channelCleanupOperation(),
      );
      await noEmail(seed);
      expect(await protectedSnapshot(seed)).toEqual(before);
    },
  );

  it.each(['binding', 'link', 'conversation'] as const)(
    'higher folder admission refuses mixed %s-owned account without changing either graph',
    async (marker: CleanupMarker) => {
      const seed = await seedWithOrdinaryAccount(marker);
      const before = await allSnapshot();
      expect(await folder(seed)).toBeNull();
      expect(await allSnapshot()).toEqual(before);
      expect(await folder(seed)).toBeNull();
      expect(await allSnapshot()).toEqual(before);
    },
  );

  it.each(['binding', 'link', 'conversation'] as const)(
    'direct blocklist job skips %s-owned graph while ordinary sender is removed',
    async (marker: CleanupMarker) => {
      const seed = await seedWithOrdinaryAccount(marker, true);
      const before = await protectedSnapshot(seed);
      await blocklist(seed);
      await noEmail(seed);
      expect(await protectedSnapshot(seed)).toEqual(before);
      const associationAudit = await fixture.owner.query(
        'SELECT "resourceId", "operationId", actor FROM crm_audit."crmAuditEntry" WHERE "resourceId"=ANY($1::text[])',
        [[seed.email.associationId, seed.email.junctionId]],
      );
      expect(associationAudit).toHaveLength(2);
      expect(
        new Set(
          associationAudit.map(
            (row: { operationId: string }) => row.operationId,
          ),
        ).size,
      ).toBe(1);
      for (const row of associationAudit)
        expect(row.actor).toEqual({
          kind: 'system',
          id: 'BlocklistItemDeleteMessagesJob',
        });
    },
  );

  it.each(['link', 'conversation'] as const)(
    'orphan sweep preserves %s-owned message after every channel association is missing',
    async (marker) => {
      const seed = await seedWithOrdinaryAccount(marker);
      await fixture.owner.query(
        `DELETE FROM "${fixture.schemaName}"."messageChannelMessageAssociation" WHERE "messageId" IN ($1,$2)`,
        [seed.omni.messageId, seed.email.messageId],
      );
      const before = await protectedSnapshot(seed);
      await fixture.cleaner.cleanOrphanMessagesAndThreads(
        fixture.workspaceId,
        channelCleanupOperation(),
      );
      await noEmail(seed);
      expect(await protectedSnapshot(seed)).toEqual(before);
    },
  );

  it('preserves an empty conversation-owned thread while removing an empty ordinary thread', async () => {
    const seed = await seedWithOrdinaryAccount('conversation');
    await fixture.owner.query(
      `DELETE FROM "${fixture.schemaName}"."message" WHERE id IN ($1,$2)`,
      [seed.omni.messageId, seed.email.messageId],
    );
    const before = await protectedSnapshot(seed);
    await fixture.cleaner.cleanOrphanMessagesAndThreads(
      fixture.workspaceId,
      channelCleanupOperation(),
    );
    expect(await protectedSnapshot(seed)).toEqual(before);
    expect(
      (await fixture.read('messageThread')).map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual([seed.omni.threadId]);
  });

  const seedPages = async (count: number) => {
    const seed = await seedWithOrdinaryAccount('conversation');
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
    await fixture.owner.query('DELETE FROM core."messageChannel" WHERE id=$1', [
      seed.channelId,
    ]);
    await fixture.cleaner.deleteMessageChannelMessageAssociationsByChannelId({
      workspaceId: fixture.workspaceId,
      messageChannelId: seed.channelId,
      auditOperation: channelCleanupOperation(),
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
    await fixture.cleaner.cleanOrphanMessagesAndThreads(
      fixture.workspaceId,
      channelCleanupOperation(),
    );
    await noEmail(seed);
  });

  it('higher folder admission refuses an owned first page before processing ordinary later rows', async () => {
    const seed = await seedPages(200);
    const before = await allSnapshot();
    expect(await folder(seed)).toBeNull();
    expect(await allSnapshot()).toEqual(before);
    expect(await fixture.read('messageChannelMessageAssociation')).toHaveLength(
      201,
    );
    expect(await folder(seed)).toBeNull();
    expect(await allSnapshot()).toEqual(before);
  });

  it('higher folder admission retains foreign-channel junctions in a mixed-owned account', async () => {
    const seed = await seedWithOrdinaryAccount('conversation');
    await fixture.owner.query(
      `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociation" SET "messageChannelId"=$1 WHERE id=$2`,
      [seed.protectedChannelId, seed.email.associationId],
    );
    const before = await allSnapshot();
    expect(await folder(seed)).toBeNull();
    expect(await allSnapshot()).toEqual(before);
  });

  it('higher folder admission retains soft-deleted ordinary and owned junctions on a mixed-owned account', async () => {
    const seed = await seedWithOrdinaryAccount('conversation');
    await fixture.owner.query(
      `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociation" SET "deletedAt"=clock_timestamp() WHERE id IN ($1,$2)`,
      [seed.omni.associationId, seed.email.associationId],
    );
    const before = await allSnapshot();
    expect(await folder(seed)).toBeNull();
    expect(await allSnapshot()).toEqual(before);
    expect(
      await fixture.read('messageChannelMessageAssociationMessageFolder'),
    ).toHaveLength(2);
  });

  it('rolls back earlier deletion when a later ownership SQL query fails', async () => {
    const seed = await seedWithOrdinaryAccount('conversation', true);
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
      const seed = await seedWithOrdinaryAccount();
      const before = await allSnapshot();
      const workspaceId = randomUUID();
      const work =
        entry === 'targeted'
          ? fixture.cleaner.deleteMessagesChannelMessageAssociationsAndRelatedOrphans(
              {
                workspaceId,
                messageChannelId: seed.channelId,
                messageExternalIds: ['omni', 'email'],
                expectedRun: {
                  workspaceId,
                  channelId: seed.channelId,
                  connectedAccountId: seed.ordinaryAccountId,
                  kind: 'message',
                  stage: 'MESSAGE_LIST_FETCH_ONGOING',
                  startedAt: actionVersion,
                },
                auditOperation: channelCleanupOperation(workspaceId),
              },
            )
          : entry === 'channel'
            ? fixture.cleaner.deleteMessageChannelMessageAssociationsByChannelId(
                {
                  workspaceId,
                  messageChannelId: seed.channelId,
                  auditOperation: channelCleanupOperation(workspaceId),
                },
              )
            : entry === 'orphan'
              ? fixture.cleaner.cleanOrphanMessagesAndThreads(
                  workspaceId,
                  channelCleanupOperation(workspaceId),
                )
              : entry === 'folder'
                ? folder(seed, workspaceId)
                : blocklist(seed, workspaceId);
      await expect(work).rejects.toThrow('WORKSPACE_MISMATCH');
      expect(await allSnapshot()).toEqual(before);
    },
  );
});
