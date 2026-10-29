import { computeGmailExcludeSearchFilter } from 'src/modules/messaging/message-import-manager/drivers/gmail/utils/compute-gmail-exclude-search-filter.util';
import { randomUUID } from 'node:crypto';
import { type PoolClient } from 'pg';
import { createOmniNativeCleanupFixture } from 'test/fork-migration/omni-native-cleanup.fixture';
import {
  captureOrdinaryFolderAction,
  finishOrdinaryFolderAction,
  type OrdinaryFolderAction,
} from 'src/modules/omnichannel/services/ordinary-folder-action';
import { MessagingProcessFolderActionsService } from 'src/modules/messaging/message-import-manager/services/messaging-process-folder-actions.service';
import { MessagingImportFolderMessagesService } from 'src/modules/messaging/message-import-manager/services/messaging-import-folder-messages.service';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
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

jest.mock(
  'src/modules/messaging/message-import-manager/drivers/gmail/services/gmail-get-message-list.service',
  () => ({ GmailGetMessageListService: class {} }),
);
const fixture = createOmniNativeCleanupFixture();
let accountId: string, channelId: string, folderId: string;
let seed: Awaited<ReturnType<typeof fixture.seed>>;
let worker: MessagingProcessFolderActionsService;
let gmail: { getMessageListWithoutCursor: jest.Mock };
const channel = async () => ({
  ...(
    await fixture.coreReader.query(
      'SELECT * FROM core."messageChannel" WHERE id=$1',
      [channelId],
    )
  )[0],
  connectedAccount: { id: accountId, provider: 'google' },
  messageFolders: [await folder()],
});
const folder = async () =>
  (
    await fixture.coreReader.query(
      'SELECT * FROM core."messageFolder" WHERE id=$1',
      [folderId],
    )
  )[0];
const capture = async () => {
  const result = await captureOrdinaryFolderAction(fixture.coreReader.manager, {
    workspaceId: fixture.workspaceId,
    messageChannelId: channelId,
    connectedAccountId: accountId,
    messageFolderId: folderId,
    action: (await folder()).pendingSyncAction,
  });
  expect(result).not.toBeNull();
  return result!;
};
const clean = async (expected: OrdinaryFolderAction) =>
  fixture.folders.deleteFolderMessages(
    fixture.workspaceId,
    await channel(),
    await folder(),
    expected,
  );
const run = async () =>
  worker.processFolderActions(
    await channel(),
    [await folder()],
    fixture.workspaceId,
  );
const exists = async () =>
  (await fixture.read('message')).some(
    (row: { id: string }) => row.id === seed.email.messageId,
  );
const change = async (field: string, value: unknown) => {
  if (
    ![
      'messageChannelId',
      'pendingSyncAction',
      'isSynced',
      'externalId',
      'updatedAt',
    ].includes(field)
  )
    throw Error('invalid fixture field');
  await fixture.owner.query(
    `UPDATE core."messageFolder" SET "${field}"=$2 WHERE id=$1`,
    [folderId, value],
  );
};
beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    'ALTER TABLE core."connectedAccount" ADD "workspaceId" uuid,ADD provider text,ADD "applicationId" uuid,ADD "connectionProviderId" uuid,ADD "userWorkspaceId" uuid',
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageChannel" ADD "pendingGroupEmailsAction" text,ADD "excludeGroupEmails" boolean,ADD "syncCursor" text,ADD "updatedAt" timestamptz NOT NULL DEFAULT now()',
  );
  await fixture.owner.query(
    'ALTER TABLE core."messageFolder" ADD "pendingSyncAction" text,ADD "isSynced" boolean,ADD "externalId" text,ADD name text,ADD "parentFolderId" text,ADD "syncCursor" text,ADD "updatedAt" timestamptz NOT NULL DEFAULT now()',
  );
  await fixture.owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON core."connectedAccount",core."messageChannel",core."messageFolder" TO "${fixture.roleName}"`,
  );
});
beforeEach(async () => {
  await fixture.reset();
  seed = await fixture.seed('binding');
  accountId = await fixture.coreInsert('connectedAccount', {
    workspaceId: fixture.workspaceId,
    provider: 'google',
    userWorkspaceId: randomUUID(),
  });
  channelId = await fixture.coreInsert('messageChannel', {
    workspaceId: fixture.workspaceId,
    connectedAccountId: accountId,
    type: 'EMAIL',
    pendingGroupEmailsAction: 'NONE',
    excludeGroupEmails: false,
    syncCursor: 'channel-before',
    updatedAt: '2026-10-28T00:00:00.123456Z',
  });
  folderId = await fixture.coreInsert('messageFolder', {
    workspaceId: fixture.workspaceId,
    messageChannelId: channelId,
    syncCursor: 'folder-before',
    isSynced: true,
    pendingSyncAction: 'FOLDER_DELETION',
    externalId: 'current-label',
    name: 'Current folder',
    updatedAt: '2026-10-28T00:00:00.123456Z',
  });
  await fixture.owner.query(
    `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociation" SET "messageChannelId"=$2 WHERE id=$1`,
    [seed.email.associationId, channelId],
  );
  await fixture.owner.query(
    `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociationMessageFolder" SET "messageFolderId"=$2 WHERE id=$1`,
    [seed.email.junctionId, folderId],
  );
  gmail = {
    getMessageListWithoutCursor: jest
      .fn()
      .mockResolvedValue([{ messageExternalIds: ['imported-id'] }]),
  };
  worker = new MessagingProcessFolderActionsService(
    fixture.manager,
    fixture.folders,
    new MessagingImportFolderMessagesService(gmail as never),
    fixture.coreReader,
  );
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());
it('actual worker deletes ordinary message graph, junction and folder metadata', async () => {
  expect(await run()).toEqual({ messageExternalIdsToImport: [] });
  expect(await exists()).toBe(false);
  expect(await folder()).toBeUndefined();
  expect(
    (await fixture.read('message')).some(
      (row: { id: string }) => row.id === seed.omni.messageId,
    ),
  ).toBe(true);
});
it('actual importer uses the captured current label and returns committed IDs', async () => {
  await change('pendingSyncAction', 'FOLDER_IMPORT');
  const oldFolder = { ...(await folder()), externalId: 'stale-label' };
  expect(
    await worker.processFolderActions(
      { ...(await channel()), messageFolders: [oldFolder] },
      [oldFolder],
      fixture.workspaceId,
    ),
  ).toEqual({ messageExternalIdsToImport: ['imported-id'] });
  const args = gmail.getMessageListWithoutCursor.mock.calls[0];
  expect(args[2].requireSelectedFolders).toBe(true);
  expect(
    computeGmailExcludeSearchFilter(
      args[1],
      args[2].messageFolderImportPolicy,
      args[2].requireSelectedFolders,
    ),
  ).toContain('label:current-folder');
  expect(gmail.getMessageListWithoutCursor.mock.calls[0][1]).toEqual([
    expect.objectContaining({ externalId: 'current-label', isSynced: true }),
  ]);
  expect((await folder()).pendingSyncAction).toBe('NONE');
  expect(await exists()).toBe(true);
});
it.each([
  'messageChannelId',
  'pendingSyncAction',
  'isSynced',
  'externalId',
  'updatedAt',
])('stale folder %s prevents page deletion and finalization', async (field) => {
  const expected = await capture();
  let value: unknown =
    field === 'pendingSyncAction'
      ? 'FOLDER_IMPORT'
      : field === 'isSynced'
        ? false
        : field === 'externalId'
          ? 'new-label'
          : '2026-10-28T00:00:00.123457Z';
  if (field === 'messageChannelId') value = seed.channelId;
  await change(field, value);
  expect(await clean(expected)).toBeNull();
  expect(
    await finishOrdinaryFolderAction(fixture.coreReader.manager, expected),
  ).toBe(false);
  expect(await exists()).toBe(true);
  expect(await folder()).toBeDefined();
});
it.each(['connectedAccountId', 'updatedAt'])(
  'stale channel %s blocks page and finalizer',
  async (field) => {
    const expected = await capture();
    await fixture.owner.query(
      `UPDATE core."messageChannel" SET "${field}"=$2 WHERE id=$1`,
      [
        channelId,
        field === 'connectedAccountId'
          ? randomUUID()
          : '2026-10-28T00:00:00.123457Z',
      ],
    );
    expect(await clean(expected)).toBeNull();
    expect(
      await finishOrdinaryFolderAction(fixture.coreReader.manager, expected),
    ).toBe(false);
    expect(await exists()).toBe(true);
  },
);
it.each(['native', 'retained', 'folder-junction'])(
  'protected %s never invokes import or cleanup',
  async (kind) => {
    await change('pendingSyncAction', 'FOLDER_IMPORT');
    if (kind === 'native')
      await fixture.owner.query(
        'UPDATE core."connectedAccount" SET provider=$2 WHERE id=$1',
        [accountId, 'app'],
      );
    if (kind === 'retained')
      await fixture.owner.query(
        'UPDATE core."omniAccountBinding" SET "connectedAccountId"=$1 WHERE id=$2',
        [accountId, seed.bindingId],
      );
    if (kind === 'folder-junction')
      await fixture.owner.query(
        `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociationMessageFolder" SET "messageFolderId"=$2 WHERE id=$1`,
        [seed.omni.junctionId, folderId],
      );
    const cleanup = jest.spyOn(fixture.folders, 'deleteFolderMessages');
    expect(await run()).toEqual({ messageExternalIdsToImport: [] });
    expect(cleanup).not.toHaveBeenCalled();
    expect(gmail.getMessageListWithoutCursor).not.toHaveBeenCalled();
    expect((await folder()).pendingSyncAction).toBe('FOLDER_IMPORT');
  },
);
it('does not query when no folder action is pending', async () => {
  await change('pendingSyncAction', 'NONE');
  const c = await channel(),
    f = await folder(),
    query = jest.spyOn(fixture.coreReader, 'query');
  expect(
    await worker.processFolderActions(c, [f], fixture.workspaceId),
  ).toEqual({ messageExternalIdsToImport: [] });
  expect(query).not.toHaveBeenCalled();
});
it.each(['context', 'channel', 'folder', 'parentChannel'])(
  'rejects mismatched %s scope before effects',
  async (variant) => {
    const c = await channel(),
      f = await folder();
    if (variant === 'context')
      jest
        .spyOn(fixture.manager, 'getWorkspaceId')
        .mockReturnValue(randomUUID());
    if (variant === 'channel') c.workspaceId = randomUUID();
    if (variant === 'folder') f.workspaceId = randomUUID();
    if (variant === 'parentChannel') f.messageChannelId = randomUUID();
    await expect(
      worker.processFolderActions(c, [f], fixture.workspaceId),
    ).rejects.toThrow('WORKSPACE_MISMATCH');
    expect(await exists()).toBe(true);
    expect(gmail.getMessageListWithoutCursor).not.toHaveBeenCalled();
  },
);
it('provider result for a changed folder token is never returned or finalized', async () => {
  await change('pendingSyncAction', 'FOLDER_IMPORT');
  gmail.getMessageListWithoutCursor.mockImplementation(async () => {
    await change('externalId', 'changed-during-fetch');
    return [{ messageExternalIds: ['stale-id'] }];
  });
  expect(await run()).toEqual({ messageExternalIdsToImport: [] });
  expect((await folder()).pendingSyncAction).toBe('FOLDER_IMPORT');
});
it('disabled import folder is not fetched', async () => {
  await change('pendingSyncAction', 'FOLDER_IMPORT');
  await change('isSynced', false);
  expect(await run()).toEqual({ messageExternalIdsToImport: [] });
  expect(gmail.getMessageListWithoutCursor).not.toHaveBeenCalled();
  expect((await folder()).pendingSyncAction).toBe('FOLDER_IMPORT');
});
it.each([new Error('ordinary provider failure'), null])(
  'ordinary provider rejection retains pending action (%p)',
  async (error) => {
    await change('pendingSyncAction', 'FOLDER_IMPORT');
    gmail.getMessageListWithoutCursor.mockRejectedValue(error);
    expect(await run()).toEqual({ messageExternalIdsToImport: [] });
    expect((await folder()).pendingSyncAction).toBe('FOLDER_IMPORT');
  },
);
it('ownership read failure does not allow cleanup or metadata mutation', async () => {
  await fixture.owner.query(
    `REVOKE SELECT ON core."omniAccountBinding" FROM "${fixture.roleName}"`,
  );
  try {
    expect(await run()).toEqual({ messageExternalIdsToImport: [] });
    expect(await exists()).toBe(true);
    expect((await folder()).pendingSyncAction).toBe('FOLDER_DELETION');
  } finally {
    await fixture.owner.query(
      `GRANT SELECT ON core."omniAccountBinding" TO "${fixture.roleName}"`,
    );
  }
});
it('finalizer preserves metadata while another channel junction remains', async () => {
  await fixture.owner.query(
    `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociation" SET "messageChannelId"=$2 WHERE id=$1`,
    [seed.email.associationId, seed.channelId],
  );
  expect(await run()).toEqual({ messageExternalIdsToImport: [] });
  expect(await exists()).toBe(true);
  expect((await folder()).pendingSyncAction).toBe('FOLDER_DELETION');
});
it('native commit unknown exits worker before metadata finalization', async () => {
  const client = await fixture.pool.connect(),
    query = client.query.bind(client);
  jest.spyOn(client, 'query').mockImplementation((async (
    text: string,
    values?: unknown[],
  ) => {
    const result = await query(text, values);
    if (text === 'COMMIT') throw new Error('folder page ACK lost');
    return result;
  }) as PoolClient['query']);
  jest
    .spyOn(fixture.pool, 'connect')
    .mockImplementationOnce(async () => client);
  await expect(run()).rejects.toBeInstanceOf(
    NativeTransactionOutcomeUnknownError,
  );
  expect(await exists()).toBe(false);
  expect((await folder()).pendingSyncAction).toBe('FOLDER_DELETION');
});
it('junction SQL failure rolls back cleaner and orphan graph in the same page', async () => {
  const expected = await capture();
  // A real child DELETE trigger also observes cascades; intercepting an explicit
  // child DELETE statement would miss the closed owner's parent cascade.
  await fixture.owner.query(
    `CREATE FUNCTION "${fixture.schemaName}".refuse_folder_junction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture folder junction refusal'; END $$`,
  );
  await fixture.owner.query(
    `CREATE TRIGGER refuse_folder_junction BEFORE DELETE ON "${fixture.schemaName}"."messageChannelMessageAssociationMessageFolder" FOR EACH ROW EXECUTE FUNCTION "${fixture.schemaName}".refuse_folder_junction()`,
  );
  try {
    const failure = await clean(expected).then(
      () => {
        throw new Error('Expected folder junction failure');
      },
      (error: unknown) => error,
    );
    let cause: unknown = failure;
    const messages: string[] = [];
    for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
      messages.push(cause.message);
      cause = cause.cause;
    }
    expect(messages.join(' | ')).toContain('fixture folder junction refusal');
    expect(await exists()).toBe(true);
    expect(
      (await fixture.read('messageChannelMessageAssociation')).some(
        (row: { id: string }) => row.id === seed.email.associationId,
      ),
    ).toBe(true);
    expect(
      (
        await fixture.read('messageChannelMessageAssociationMessageFolder')
      ).some((row: { id: string }) => row.id === seed.email.junctionId),
    ).toBe(true);
    expect((await folder()).pendingSyncAction).toBe('FOLDER_DELETION');
    expect(
      await fixture.owner.query('SELECT id FROM crm_audit."crmAuditEntry"'),
    ).toEqual([]);
  } finally {
    await fixture.owner.query(
      `DROP TRIGGER refuse_folder_junction ON "${fixture.schemaName}"."messageChannelMessageAssociationMessageFolder"`,
    );
    await fixture.owner.query(
      `DROP FUNCTION "${fixture.schemaName}".refuse_folder_junction()`,
    );
  }
});

it('unknown import finalizer commit never returns fetched IDs', async () => {
  await change('pendingSyncAction', 'FOLDER_IMPORT');
  const original = fixture.coreReader.createQueryRunner.bind(
    fixture.coreReader,
  );
  jest.spyOn(fixture.coreReader, 'createQueryRunner').mockImplementation(() => {
    const runner = original(),
      query = runner.query.bind(runner),
      commit = runner.commitTransaction.bind(runner);
    let finalizing = false;
    runner.query = async (...args: Parameters<typeof runner.query>) => {
      if (args[0].startsWith('UPDATE core."messageFolder"')) finalizing = true;
      return query(...args);
    };
    runner.commitTransaction = async () => {
      await commit();
      if (finalizing) throw new Error('folder finalizer ACK lost');
    };
    return runner;
  });
  await expect(run()).rejects.toThrow('OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN');
  expect((await folder()).pendingSyncAction).toBe('NONE');
  expect(gmail.getMessageListWithoutCursor).toHaveBeenCalledTimes(1);
});
it('folder action ABA differing by one microsecond rejects old work', async () => {
  const expected = await capture();
  await change('pendingSyncAction', 'FOLDER_IMPORT');
  await change('pendingSyncAction', 'FOLDER_DELETION');
  await change('updatedAt', '2026-10-28T00:00:00.123457Z');
  expect(await clean(expected)).toBeNull();
  expect(
    await finishOrdinaryFolderAction(fixture.coreReader.manager, expected),
  ).toBe(false);
  expect(await exists()).toBe(true);
});
it('ordinary and protected folders in one request only process the ordinary folder', async () => {
  const protectedId = await fixture.coreInsert('messageFolder', {
    workspaceId: fixture.workspaceId,
    messageChannelId: channelId,
    pendingSyncAction: 'FOLDER_IMPORT',
    isSynced: true,
    externalId: 'protected',
    updatedAt: '2026-10-28T00:00:00.123456Z',
  });
  await fixture.owner.query(
    `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociationMessageFolder" SET "messageFolderId"=$2 WHERE id=$1`,
    [seed.omni.junctionId, protectedId],
  );
  await change('pendingSyncAction', 'FOLDER_IMPORT');
  const protectedFolder = (
    await fixture.coreReader.query(
      'SELECT * FROM core."messageFolder" WHERE id=$1',
      [protectedId],
    )
  )[0];
  expect(
    await worker.processFolderActions(
      await channel(),
      [protectedFolder, await folder()],
      fixture.workspaceId,
    ),
  ).toEqual({ messageExternalIdsToImport: ['imported-id'] });
  expect(gmail.getMessageListWithoutCursor).toHaveBeenCalledTimes(1);
  expect(
    (
      await fixture.coreReader.query(
        'SELECT "pendingSyncAction" FROM core."messageFolder" WHERE id=$1',
        [protectedId],
      )
    )[0].pendingSyncAction,
  ).toBe('FOLDER_IMPORT');
});
it('snapshots caller objects before ownership lookup yields', async () => {
  const c = await channel(),
    f = await folder(),
    input = [f],
    original = fixture.coreReader.createQueryRunner.bind(fixture.coreReader);
  jest
    .spyOn(fixture.coreReader, 'createQueryRunner')
    .mockImplementationOnce(() => {
      const runner = original(),
        query = runner.query.bind(runner);
      let changed = false;
      runner.query = async (...args: Parameters<typeof runner.query>) => {
        if (!changed) {
          changed = true;
          c.id = randomUUID();
          f.id = randomUUID();
          f.pendingSyncAction = 'FOLDER_IMPORT';
          input.length = 0;
        }
        return query(...args);
      };
      return runner;
    });
  expect(
    await worker.processFolderActions(c, input, fixture.workspaceId),
  ).toEqual({ messageExternalIdsToImport: [] });
  expect(await folder()).toBeUndefined();
  expect(gmail.getMessageListWithoutCursor).not.toHaveBeenCalled();
});
it('stops the next native page after concurrent folder action change', async () => {
  const inserted: { id: string }[] = await fixture.owner.query(
    `INSERT INTO "${fixture.schemaName}"."message"(id,"messageThreadId") SELECT gen_random_uuid(),$1 FROM generate_series(1,200) RETURNING id`,
    [seed.email.threadId],
  );
  const associations: { id: string }[] = await fixture.owner.query(
    `INSERT INTO "${fixture.schemaName}"."messageChannelMessageAssociation"(id,"messageId","messageChannelId","messageExternalId") SELECT gen_random_uuid(),id,$2,'folder-page-'||id FROM unnest($1::uuid[]) item(id) RETURNING id`,
    [inserted.map((row) => row.id), channelId],
  );
  await fixture.owner.query(
    `INSERT INTO "${fixture.schemaName}"."messageChannelMessageAssociationMessageFolder"(id,"messageChannelMessageAssociationId","messageFolderId") SELECT gen_random_uuid(),id,$2 FROM unnest($1::uuid[]) item(id)`,
    [associations.map((row) => row.id), folderId],
  );
  const expected = await capture(),
    original = fixture.manager.runInWorkspaceTransaction.bind(fixture.manager);
  let pages = 0;
  jest
    .spyOn(fixture.manager, 'runInWorkspaceTransaction')
    .mockImplementation(async (...args) => {
      const result = await original(...args);
      if (++pages === 1) await change('pendingSyncAction', 'FOLDER_IMPORT');
      return result;
    });
  expect(await clean(expected)).toBeNull();
  expect(pages).toBe(2);
  expect(
    (
      await fixture.read('messageChannelMessageAssociationMessageFolder')
    ).filter(
      (row: { messageFolderId: string }) => row.messageFolderId === folderId,
    ),
  ).toHaveLength(1);
  expect((await folder()).pendingSyncAction).toBe('FOLDER_IMPORT');
});

it('actual Gmail filter includes the full current nested label path', async () => {
  await change('pendingSyncAction', 'FOLDER_IMPORT');
  await fixture.coreInsert('messageFolder', {
    workspaceId: fixture.workspaceId,
    messageChannelId: channelId,
    pendingSyncAction: 'NONE',
    isSynced: false,
    externalId: 'parent-label',
    name: 'Current Parent',
  });
  await fixture.owner.query(
    'UPDATE core."messageFolder" SET "parentFolderId"=$2 WHERE id=$1',
    [folderId, 'parent-label'],
  );
  const oldFolder = {
      ...(await folder()),
      externalId: 'stale',
      name: 'Old Child',
    },
    c = { ...(await channel()), messageFolders: [oldFolder] };
  await worker.processFolderActions(c, [oldFolder], fixture.workspaceId);
  const args = gmail.getMessageListWithoutCursor.mock.calls[0];
  expect(args[1]).toHaveLength(2);
  expect(
    computeGmailExcludeSearchFilter(
      args[1],
      args[2].messageFolderImportPolicy,
      args[2].requireSelectedFolders,
    ),
  ).toContain('label:current-parent-current-folder');
});
it('parent-label rename during provider request invalidates import result', async () => {
  await change('pendingSyncAction', 'FOLDER_IMPORT');
  const parentId = await fixture.coreInsert('messageFolder', {
    workspaceId: fixture.workspaceId,
    messageChannelId: channelId,
    pendingSyncAction: 'NONE',
    isSynced: false,
    externalId: 'parent-label',
    name: 'Before',
  });
  await fixture.owner.query(
    'UPDATE core."messageFolder" SET "parentFolderId"=$2 WHERE id=$1',
    [folderId, 'parent-label'],
  );
  gmail.getMessageListWithoutCursor.mockImplementation(async () => {
    await fixture.owner.query(
      'UPDATE core."messageFolder" SET name=$2,"updatedAt"=clock_timestamp() WHERE id=$1',
      [parentId, 'After'],
    );
    return [{ messageExternalIds: ['stale-parent-result'] }];
  });
  expect(await run()).toEqual({ messageExternalIdsToImport: [] });
  expect((await folder()).pendingSyncAction).toBe('FOLDER_IMPORT');
});
it.each(['missing-name', 'missing-parent'])(
  'strict Gmail selection refuses %s instead of querying whole mailbox',
  async (kind) => {
    await change('pendingSyncAction', 'FOLDER_IMPORT');
    await fixture.owner.query(
      'UPDATE core."messageFolder" SET name=$2,"parentFolderId"=$3 WHERE id=$1',
      [
        folderId,
        kind === 'missing-name' ? null : 'Child',
        kind === 'missing-parent' ? 'unknown-parent' : null,
      ],
    );
    gmail.getMessageListWithoutCursor.mockImplementation(
      async (_account, folders, options) => {
        computeGmailExcludeSearchFilter(
          folders,
          options.messageFolderImportPolicy,
          options.requireSelectedFolders,
        );
        return [{ messageExternalIds: ['must-not-escape'] }];
      },
    );
    expect(await run()).toEqual({ messageExternalIdsToImport: [] });
    expect((await folder()).pendingSyncAction).toBe('FOLDER_IMPORT');
  },
);

it.each([null, '', '   '])(
  'strict nested Gmail import rejects parent name %p',
  async (name) => {
    await change('pendingSyncAction', 'FOLDER_IMPORT');
    await fixture.coreInsert('messageFolder', {
      workspaceId: fixture.workspaceId,
      messageChannelId: channelId,
      pendingSyncAction: 'NONE',
      isSynced: false,
      externalId: 'parent-label',
      name,
    });
    await fixture.owner.query(
      'UPDATE core."messageFolder" SET name=$2,"parentFolderId"=$3 WHERE id=$1',
      [folderId, 'Active', 'parent-label'],
    );
    gmail.getMessageListWithoutCursor.mockImplementation(
      async (_account, folders, options) => {
        computeGmailExcludeSearchFilter(
          folders,
          options.messageFolderImportPolicy,
          options.requireSelectedFolders,
        );
        return [{ messageExternalIds: ['wrong-top-level-label'] }];
      },
    );
    expect(await run()).toEqual({ messageExternalIdsToImport: [] });
    expect((await folder()).pendingSyncAction).toBe('FOLDER_IMPORT');
  },
);
