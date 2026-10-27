import { randomUUID } from 'node:crypto';

import {
  findOmniOwnedConnectedAccountIds,
  findOmniOwnedMessageChannelIds,
  findOmniOwnedMessageFolderIds,
} from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';
import { createOmniNativeCleanupFixture } from 'test/fork-migration/omni-native-cleanup.fixture';

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
const query = {
  executeRawQuery: (sql: string, parameters?: unknown[]) =>
    fixture.coreReader.query(sql, parameters),
};
const channels = (ids: string[]) =>
  findOmniOwnedMessageChannelIds(query, fixture.workspaceId, ids);
const accounts = (ids: string[]) =>
  findOmniOwnedConnectedAccountIds(query, fixture.workspaceId, ids);
const folders = (ids: string[]) =>
  findOmniOwnedMessageFolderIds(query, fixture.workspaceId, ids);
const ordinary = async (workspaceId = fixture.workspaceId) => {
  const accountId = await fixture.coreInsert('connectedAccount', {});
  const channelId = await fixture.coreInsert('messageChannel', {
    workspaceId,
    type: 'EMAIL',
    connectedAccountId: accountId,
  });
  const folderId = await fixture.coreInsert('messageFolder', {
    workspaceId,
    messageChannelId: channelId,
  });
  return { accountId, channelId, folderId };
};

beforeAll(async () => {
  await fixture.initialize();
  // Only the actual core columns read by these helpers are represented; native schemas are generated.
  await fixture.owner.query(
    'CREATE TABLE core."messageFolder" (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL, "messageChannelId" uuid NOT NULL REFERENCES core."messageChannel"(id) ON DELETE CASCADE)',
  );
  await fixture.owner.query(
    `GRANT SELECT ON core."messageFolder" TO "${fixture.roleName}"`,
  );
});
beforeEach(() => fixture.reset());
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('persisted metadata ownership over real core and native records', () => {
  it.each(['binding', 'link', 'conversation'] as const)(
    'recognizes %s ownership through channel, separate parent account and folder',
    async (marker) => {
      const seed = await fixture.seed(marker);
      const unowned = await ordinary();
      const indirectAccountId = await fixture.coreInsert(
        'connectedAccount',
        {},
      );
      await fixture.owner.query(
        'UPDATE core."messageChannel" SET "connectedAccountId"=$1 WHERE id=$2',
        [indirectAccountId, seed.channelId],
      );
      await fixture.coreInsert('messageFolder', {
        id: seed.folderId,
        workspaceId: fixture.workspaceId,
        messageChannelId: seed.channelId,
      });
      expect(
        await channels([
          seed.channelId,
          seed.protectedChannelId,
          unowned.channelId,
        ]),
      ).toEqual(new Set([seed.channelId, seed.protectedChannelId]));
      expect(await accounts([indirectAccountId, unowned.accountId])).toEqual(
        new Set([indirectAccountId]),
      );
      expect(await folders([seed.folderId, unowned.folderId])).toEqual(
        new Set([seed.folderId]),
      );
    },
  );

  it('recognizes a disabled binding with no messages or folders and its direct account even without an account child channel', async () => {
    const seed = await fixture.seed('binding');
    const [binding] = await fixture.owner.query(
      'SELECT "connectedAccountId" FROM core."omniAccountBinding" WHERE id=$1',
      [seed.bindingId],
    );
    await fixture.owner.query(`DELETE FROM "${fixture.schemaName}"."message"`);
    await fixture.owner.query(
      'UPDATE core."messageChannel" SET "connectedAccountId"=NULL',
    );
    const folderId = await fixture.coreInsert('messageFolder', {
      workspaceId: fixture.workspaceId,
      messageChannelId: seed.protectedChannelId,
    });
    expect(await channels([seed.channelId, seed.protectedChannelId])).toEqual(
      new Set([seed.protectedChannelId]),
    );
    expect(await accounts([binding.connectedAccountId])).toEqual(
      new Set([binding.connectedAccountId]),
    );
    expect(await folders([folderId])).toEqual(new Set([folderId]));
  });

  it.each(['binding', 'link', 'conversation'] as const)(
    'does not lose %s ownership when native message, associations and folder junction are soft deleted',
    async (marker) => {
      const seed = await fixture.seed(marker);
      await fixture.coreInsert('messageFolder', {
        id: seed.folderId,
        workspaceId: fixture.workspaceId,
        messageChannelId: seed.channelId,
      });
      for (const table of [
        'message',
        'messageChannelMessageAssociation',
        'messageChannelMessageAssociationMessageFolder',
      ]) {
        await fixture.owner.query(
          `UPDATE "${fixture.schemaName}"."${table}" SET "deletedAt"=clock_timestamp()`,
        );
      }
      expect(await channels([seed.channelId])).toEqual(
        new Set([seed.channelId]),
      );
      expect(await folders([seed.folderId])).toEqual(new Set([seed.folderId]));
    },
  );

  it('protects a folder through its junction even when its metadata parent is an unowned channel', async () => {
    const seed = await fixture.seed('conversation');
    const unowned = await ordinary();
    await fixture.coreInsert('messageFolder', {
      id: seed.folderId,
      workspaceId: fixture.workspaceId,
      messageChannelId: unowned.channelId,
    });
    expect(await channels([unowned.channelId])).toEqual(new Set());
    expect(await folders([seed.folderId, unowned.folderId])).toEqual(
      new Set([seed.folderId]),
    );
  });

  it('keeps an ordinary sibling folder eligible within an indirectly protected channel', async () => {
    const seed = await fixture.seed('conversation');
    await fixture.coreInsert('messageFolder', {
      id: seed.folderId,
      workspaceId: fixture.workspaceId,
      messageChannelId: seed.channelId,
    });
    const siblingId = await fixture.coreInsert('messageFolder', {
      workspaceId: fixture.workspaceId,
      messageChannelId: seed.channelId,
    });
    expect(await channels([seed.channelId])).toEqual(new Set([seed.channelId]));
    expect(await folders([seed.folderId, siblingId])).toEqual(
      new Set([seed.folderId]),
    );
  });

  it('does not classify foreign-workspace channels or folders from local native references', async () => {
    const seed = await fixture.seed('conversation');
    const foreignWorkspaceId = randomUUID();
    await fixture.owner.query('INSERT INTO core.workspace(id) VALUES ($1)', [
      foreignWorkspaceId,
    ]);
    const foreign = await ordinary(foreignWorkspaceId);
    await fixture.owner.query(
      `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociation" SET "messageChannelId"=$1 WHERE id=$2`,
      [foreign.channelId, seed.omni.associationId],
    );
    await fixture.owner.query(
      `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociationMessageFolder" SET "messageFolderId"=$1 WHERE id=$2`,
      [foreign.folderId, seed.omni.junctionId],
    );
    expect(await channels([foreign.channelId])).toEqual(new Set());
    expect(await folders([foreign.folderId])).toEqual(new Set());
    expect(await accounts([foreign.accountId])).toEqual(new Set());
  });

  it('uses full candidate pages and retains ownership on the second batch', async () => {
    const seed = await fixture.seed('conversation');
    const candidates: string[] = Array.from({ length: 200 }, () =>
      randomUUID(),
    );
    await fixture.owner.query(
      'INSERT INTO core."messageChannel" (id,"workspaceId",type) SELECT id,$1,\'EMAIL\' FROM unnest($2::uuid[]) candidate(id)',
      [fixture.workspaceId, candidates],
    );
    candidates.push(seed.channelId);
    const executeRawQuery = jest.fn(query.executeRawQuery);
    expect(
      await findOmniOwnedMessageChannelIds(
        { executeRawQuery },
        fixture.workspaceId,
        candidates,
      ),
    ).toEqual(new Set([seed.channelId]));
    expect(executeRawQuery).toHaveBeenCalledTimes(2);
    expect(
      executeRawQuery.mock.calls.map(
        ([, parameters]) => (parameters?.[1] as string[]).length,
      ),
    ).toEqual([200, 1]);
  });

  it('normalizes uppercase UUIDs and deduplicates candidates before SQL', async () => {
    const seed = await fixture.seed('binding');
    const executeRawQuery = jest.fn(query.executeRawQuery);
    expect(
      await findOmniOwnedMessageChannelIds(
        { executeRawQuery },
        fixture.workspaceId.toUpperCase(),
        [seed.protectedChannelId.toUpperCase(), seed.protectedChannelId],
      ),
    ).toEqual(new Set([seed.protectedChannelId]));
    expect(executeRawQuery).toHaveBeenCalledTimes(1);
    expect(executeRawQuery.mock.calls[0][1]).toEqual([
      fixture.workspaceId,
      [seed.protectedChannelId],
    ]);
  });

  it('snapshots both candidates and query callback before awaiting the first batch', async () => {
    const seed = await fixture.seed('binding');
    const candidates: string[] = [
      ...Array.from({ length: 200 }, () => randomUUID()),
      seed.protectedChannelId,
    ];
    const port = {
      executeRawQuery: async (sql: string, parameters?: unknown[]) => {
        candidates.splice(0);
        port.executeRawQuery = async () => {
          throw new Error('mutated query callback');
        };
        return query.executeRawQuery(sql, parameters);
      },
    };
    expect(
      await findOmniOwnedMessageChannelIds(
        port,
        fixture.workspaceId,
        candidates,
      ),
    ).toEqual(new Set([seed.protectedChannelId]));
  });

  it.each([
    findOmniOwnedMessageChannelIds,
    findOmniOwnedConnectedAccountIds,
    findOmniOwnedMessageFolderIds,
  ])('validates the full input before issuing any query', async (findOwned) => {
    const executeRawQuery = jest.fn(query.executeRawQuery);
    await expect(
      findOwned({ executeRawQuery }, fixture.workspaceId, [
        ...Array.from({ length: 200 }, () => randomUUID()),
        'invalid-uuid',
      ]),
    ).rejects.toThrow('INVALID_METADATA_OWNERSHIP_SCOPE');
    expect(executeRawQuery).not.toHaveBeenCalled();
    expect(
      await findOwned({ executeRawQuery }, fixture.workspaceId, []),
    ).toEqual(new Set());
    expect(executeRawQuery).not.toHaveBeenCalled();
  });

  it.each(['missing-id', 'foreign-id', 'duplicate-id', 'not-array'] as const)(
    'fails closed on malformed %s query results',
    async (kind) => {
      const id = randomUUID();
      const result: unknown =
        kind === 'missing-id'
          ? [{}]
          : kind === 'foreign-id'
            ? [{ id: randomUUID() }]
            : kind === 'duplicate-id'
              ? [{ id }, { id }]
              : {};
      // Deliberately simulate a broken query transport; no metadata mutation is performed.
      const executeRawQuery = async () => result as Record<string, unknown>[];
      await expect(
        findOmniOwnedMessageChannelIds(
          { executeRawQuery },
          fixture.workspaceId,
          [id],
        ),
      ).rejects.toThrow('INVALID_METADATA_OWNERSHIP_RESULT');
    },
  );

  it('propagates a real database permission error instead of returning an unowned result', async () => {
    const seed = await fixture.seed('conversation');
    await fixture.owner.query(
      `REVOKE SELECT ON core."omniMessageLink" FROM "${fixture.roleName}"`,
    );
    try {
      await expect(channels([seed.channelId])).rejects.toThrow();
    } finally {
      await fixture.owner.query(
        `GRANT SELECT ON core."omniMessageLink" TO "${fixture.roleName}"`,
      );
    }
  });
});
