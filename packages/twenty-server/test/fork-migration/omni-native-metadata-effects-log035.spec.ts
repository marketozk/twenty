import { randomUUID } from 'node:crypto';

import { MessageFolderPendingSyncAction } from 'twenty-shared/types';
import { In } from 'typeorm';

import { MessageChannelSyncStatusService } from 'src/modules/messaging/common/services/message-channel-sync-status.service';
import { MessagingProcessFolderActionsService } from 'src/modules/messaging/message-import-manager/services/messaging-process-folder-actions.service';

jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock(
  'src/engine/core-modules/cache-storage/services/cache-storage.service',
  () => ({ CacheStorageService: class {} }),
);
jest.mock('src/engine/core-modules/metrics/metrics.service', () => ({
  MetricsService: class {},
}));
jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.entity',
  () => ({ UserWorkspaceEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/connected-account/entities/connected-account.entity',
  () => ({ ConnectedAccountEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/message-channel/entities/message-channel.entity',
  () => ({ MessageChannelEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/message-folder/entities/message-folder.entity',
  () => ({ MessageFolderEntity: class {} }),
);
jest.mock(
  'src/modules/connected-account/services/accounts-to-reconnect.service',
  () => ({ AccountsToReconnectService: class {} }),
);
jest.mock(
  'src/engine/subscriptions/workspace-event-broadcaster/workspace-event-broadcaster.service',
  () => ({ WorkspaceEventBroadcaster: class {} }),
);
jest.mock(
  'src/modules/messaging/message-import-manager/services/messaging-delete-folder-messages.service',
  () => ({ MessagingDeleteFolderMessagesService: class {} }),
);
jest.mock(
  'src/modules/messaging/message-import-manager/services/messaging-import-folder-messages.service',
  () => ({ MessagingImportFolderMessagesService: class {} }),
);

const resetFixture = () => {
  const workspaceId = randomUUID();
  const ordinaryId = randomUUID();
  const ownedId = randomUUID();
  const effects: string[] = [];
  const query = jest.fn(
    async (
      _sql: string,
      _parameters?: unknown[],
    ): Promise<Record<string, unknown>[]> => {
      effects.push('ownership');
      return [{ id: ownedId }];
    },
  );
  const manager = {
    getWorkspaceId: jest.fn(() => workspaceId),
    executeInWorkspaceContext: jest.fn(
      async <TData>(work: () => Promise<TData>) => work(),
    ),
  };
  const cache = {
    mdel: jest.fn(async () => {
      effects.push('cache');
    }),
  };
  const channels = {
    manager: { query },
    update: jest.fn(async () => {
      effects.push('channel');
    }),
  };
  const folders = {
    update: jest.fn(async () => {
      effects.push('folders');
    }),
  };
  type Dependencies = ConstructorParameters<
    typeof MessageChannelSyncStatusService
  >;
  const service = new MessageChannelSyncStatusService(
    cache as unknown as Dependencies[0],
    manager as unknown as Dependencies[1],
    channels as unknown as Dependencies[2],
    folders as unknown as Dependencies[3],
    {} as Dependencies[4],
    {} as Dependencies[5],
    {} as Dependencies[6],
    {} as Dependencies[7],
    {} as Dependencies[8],
  );
  const mark = jest
    .spyOn(service, 'markAsMessagesListFetchPending')
    .mockImplementation(async () => {
      effects.push('pending');
    });
  return {
    workspaceId,
    ordinaryId,
    ownedId,
    effects,
    query,
    manager,
    cache,
    channels,
    folders,
    service,
    mark,
  };
};

const folderFixture = () => {
  const workspaceId = randomUUID();
  const channelId = randomUUID();
  const ordinaryId = randomUUID();
  const ownedId = randomUUID();
  const effects: string[] = [];
  const query = jest.fn(
    async (
      _sql: string,
      _parameters?: unknown[],
    ): Promise<Record<string, unknown>[]> => {
      effects.push('ownership');
      return [{ id: ownedId }];
    },
  );
  const manager = {
    getWorkspaceId: jest.fn(() => workspaceId),
    executeInWorkspaceContext: jest.fn(
      async <TData>(work: () => Promise<TData>) => work(),
    ),
  };
  const metadata = {
    update: jest.fn(async () => {
      effects.push('clear-pending');
    }),
    delete: jest.fn(async () => {
      effects.push('delete-metadata');
    }),
  };
  const cleaner = {
    deleteFolderMessages: jest.fn(async () => {
      effects.push('clean');
      return 1;
    }),
  };
  const importer = {
    getFolderMessageIdsToImport: jest.fn(async () => {
      effects.push('import');
      return ['ordinary-external'];
    }),
  };
  type Dependencies = ConstructorParameters<
    typeof MessagingProcessFolderActionsService
  >;
  const service = new MessagingProcessFolderActionsService(
    manager as unknown as Dependencies[0],
    metadata as unknown as Dependencies[1],
    cleaner as unknown as Dependencies[2],
    importer as unknown as Dependencies[3],
    { query } as unknown as Dependencies[4],
  );
  const ordinary = {
    id: ordinaryId,
    workspaceId,
    messageChannelId: channelId,
    name: 'Ordinary',
    pendingSyncAction: MessageFolderPendingSyncAction.FOLDER_DELETION,
  };
  const owned = { ...ordinary, id: ownedId, name: 'Protected' };
  const channel = {
    id: channelId,
    workspaceId,
    connectedAccount: { provider: 'google' },
    messageFolders: [ordinary, owned],
  };
  const run = (folders = [owned, ordinary]) =>
    service.processFolderActions(
      channel as unknown as Parameters<typeof service.processFolderActions>[0],
      folders as unknown as Parameters<typeof service.processFolderActions>[1],
      workspaceId,
    );
  return {
    workspaceId,
    channelId,
    ordinaryId,
    ownedId,
    effects,
    query,
    manager,
    metadata,
    cleaner,
    importer,
    service,
    ordinary,
    owned,
    channel,
    run,
  };
};

describe('reset ownership fence before cache and metadata effects', () => {
  it('filters mixed channel IDs before the first cache effect and preserves ordinary ordering', async () => {
    const fixture = resetFixture();
    await fixture.service.resetAndMarkAsMessagesListFetchPending(
      [fixture.ownedId, fixture.ordinaryId],
      fixture.workspaceId,
    );
    expect(fixture.effects).toEqual([
      'ownership',
      'cache',
      'channel',
      'folders',
      'pending',
    ]);
    expect(fixture.cache.mdel).toHaveBeenCalledWith([
      `messages-to-import:${fixture.workspaceId}:${fixture.ordinaryId}`,
      `messages-to-import-total:${fixture.workspaceId}:${fixture.ordinaryId}`,
      `messages-imported:${fixture.workspaceId}:${fixture.ordinaryId}`,
    ]);
    expect(fixture.channels.update).toHaveBeenCalledWith(
      { id: In([fixture.ordinaryId]), workspaceId: fixture.workspaceId },
      expect.any(Object),
    );
    expect(fixture.folders.update).toHaveBeenCalledWith(
      fixture.workspaceId,
      { messageChannelId: In([fixture.ordinaryId]) },
      expect.any(Object),
    );
    expect(fixture.mark).toHaveBeenCalledWith(
      [fixture.ordinaryId],
      fixture.workspaceId,
    );
  });

  it('leaves every effect untouched for a wholly protected batch', async () => {
    const fixture = resetFixture();
    await fixture.service.resetAndMarkAsMessagesListFetchPending(
      [fixture.ownedId],
      fixture.workspaceId,
    );
    expect(fixture.effects).toEqual(['ownership']);
  });

  it('leaves an empty batch untouched without querying', async () => {
    const fixture = resetFixture();
    await fixture.service.resetAndMarkAsMessagesListFetchPending(
      [],
      fixture.workspaceId,
    );
    expect(fixture.effects).toEqual([]);
  });

  it('rejects a different active workspace before querying or clearing cache', async () => {
    const fixture = resetFixture();
    fixture.manager.getWorkspaceId.mockReturnValue(randomUUID());
    await expect(
      fixture.service.resetAndMarkAsMessagesListFetchPending(
        [fixture.ordinaryId],
        fixture.workspaceId,
      ),
    ).rejects.toThrow('WORKSPACE_MISMATCH');
    expect(fixture.effects).toEqual([]);
  });

  it.each(['failure', 'malformed'] as const)(
    'performs no effects on ownership %s',
    async (variant) => {
      const fixture = resetFixture();
      if (variant === 'failure')
        fixture.query.mockRejectedValue(new Error('ownership unavailable'));
      else fixture.query.mockResolvedValue([{ id: randomUUID() }]);
      await expect(
        fixture.service.resetAndMarkAsMessagesListFetchPending(
          [fixture.ordinaryId],
          fixture.workspaceId,
        ),
      ).rejects.toThrow();
      expect(fixture.cache.mdel).not.toHaveBeenCalled();
      expect(fixture.channels.update).not.toHaveBeenCalled();
      expect(fixture.folders.update).not.toHaveBeenCalled();
      expect(fixture.mark).not.toHaveBeenCalled();
    },
  );

  it('uses the input snapshot when the caller mutates IDs during ownership lookup', async () => {
    const fixture = resetFixture();
    const ids = [fixture.ordinaryId, fixture.ownedId];
    fixture.query.mockImplementation(async () => {
      await Promise.resolve();
      ids.splice(0, ids.length, randomUUID());
      return [{ id: fixture.ownedId }];
    });
    await fixture.service.resetAndMarkAsMessagesListFetchPending(
      ids,
      fixture.workspaceId,
    );
    expect(fixture.mark).toHaveBeenCalledWith(
      [fixture.ordinaryId],
      fixture.workspaceId,
    );
  });
});

describe('folder action ownership fence before import, cleanup and metadata deletion', () => {
  it('keeps protected folders out of cleanup, pending-action reset and metadata deletion', async () => {
    const fixture = folderFixture();
    expect(await fixture.run()).toEqual({ messageExternalIdsToImport: [] });
    expect(fixture.effects).toEqual([
      'ownership',
      'clean',
      'clear-pending',
      'delete-metadata',
    ]);
    expect(fixture.cleaner.deleteFolderMessages).toHaveBeenCalledTimes(1);
    expect(fixture.cleaner.deleteFolderMessages).toHaveBeenCalledWith(
      fixture.workspaceId,
      expect.objectContaining({ id: fixture.channelId }),
      expect.objectContaining({ id: fixture.ordinaryId }),
    );
    expect(fixture.metadata.update).toHaveBeenCalledWith(
      fixture.workspaceId,
      { id: In([fixture.ordinaryId]) },
      { pendingSyncAction: MessageFolderPendingSyncAction.NONE },
    );
    expect(fixture.metadata.delete).toHaveBeenCalledWith(fixture.workspaceId, {
      id: In([fixture.ordinaryId]),
    });
  });

  it('imports only ordinary folders and returns their external IDs', async () => {
    const fixture = folderFixture();
    fixture.ordinary.pendingSyncAction =
      MessageFolderPendingSyncAction.FOLDER_IMPORT;
    fixture.owned.pendingSyncAction =
      MessageFolderPendingSyncAction.FOLDER_IMPORT;
    expect(await fixture.run()).toEqual({
      messageExternalIdsToImport: ['ordinary-external'],
    });
    expect(fixture.importer.getFolderMessageIdsToImport).toHaveBeenCalledTimes(
      1,
    );
    expect(fixture.effects).toEqual(['ownership', 'import', 'clear-pending']);
    expect(fixture.metadata.delete).not.toHaveBeenCalled();
  });

  it('does nothing to an entirely protected folder list', async () => {
    const fixture = folderFixture();
    expect(await fixture.run([fixture.owned])).toEqual({
      messageExternalIdsToImport: [],
    });
    expect(fixture.effects).toEqual(['ownership']);
  });

  it('does not query when no actions are pending', async () => {
    const fixture = folderFixture();
    fixture.ordinary.pendingSyncAction = MessageFolderPendingSyncAction.NONE;
    expect(await fixture.run([fixture.ordinary])).toEqual({
      messageExternalIdsToImport: [],
    });
    expect(fixture.effects).toEqual([]);
  });

  it.each(['context', 'channel', 'folder', 'parentChannel'] as const)(
    'rejects mismatched %s scope before effects',
    async (variant) => {
      const fixture = folderFixture();
      if (variant === 'context')
        fixture.manager.getWorkspaceId.mockReturnValue(randomUUID());
      if (variant === 'channel') fixture.channel.workspaceId = randomUUID();
      if (variant === 'folder') fixture.ordinary.workspaceId = randomUUID();
      if (variant === 'parentChannel')
        fixture.ordinary.messageChannelId = randomUUID();
      await expect(fixture.run()).rejects.toThrow('WORKSPACE_MISMATCH');
      expect(fixture.effects).toEqual([]);
    },
  );

  it.each(['failure', 'malformed'] as const)(
    'performs no actions on ownership %s',
    async (variant) => {
      const fixture = folderFixture();
      if (variant === 'failure')
        fixture.query.mockRejectedValue(new Error('ownership unavailable'));
      else fixture.query.mockResolvedValue([{ id: randomUUID() }]);
      await expect(fixture.run()).rejects.toThrow();
      expect(fixture.cleaner.deleteFolderMessages).not.toHaveBeenCalled();
      expect(
        fixture.importer.getFolderMessageIdsToImport,
      ).not.toHaveBeenCalled();
      expect(fixture.metadata.update).not.toHaveBeenCalled();
      expect(fixture.metadata.delete).not.toHaveBeenCalled();
    },
  );

  it('keeps the snapshotted folder IDs, actions and channel while lookup yields', async () => {
    const fixture = folderFixture();
    const folders = [fixture.owned, fixture.ordinary];
    fixture.query.mockImplementation(async () => {
      await Promise.resolve();
      fixture.ordinary.id = randomUUID();
      fixture.ordinary.pendingSyncAction =
        MessageFolderPendingSyncAction.FOLDER_IMPORT;
      fixture.channel.id = randomUUID();
      folders.splice(0, folders.length);
      return [{ id: fixture.ownedId }];
    });
    await fixture.run(folders);
    expect(fixture.cleaner.deleteFolderMessages).toHaveBeenCalledWith(
      fixture.workspaceId,
      expect.objectContaining({ id: fixture.channelId }),
      expect.objectContaining({
        id: fixture.ordinaryId,
        pendingSyncAction: MessageFolderPendingSyncAction.FOLDER_DELETION,
      }),
    );
    expect(fixture.importer.getFolderMessageIdsToImport).not.toHaveBeenCalled();
    expect(fixture.metadata.delete).toHaveBeenCalledWith(fixture.workspaceId, {
      id: In([fixture.ordinaryId]),
    });
  });

  it('preserves ordinary failure handling without clearing or deleting failed folders', async () => {
    const fixture = folderFixture();
    fixture.cleaner.deleteFolderMessages.mockRejectedValue(
      new Error('ordinary cleanup failed'),
    );
    expect(await fixture.run()).toEqual({ messageExternalIdsToImport: [] });
    expect(fixture.metadata.update).not.toHaveBeenCalled();
    expect(fixture.metadata.delete).not.toHaveBeenCalled();
  });

  it.each(['ordinary cleanup failed', null])(
    'retains pending folders when ordinary cleanup rejects with %p',
    async (error) => {
      const fixture = folderFixture();
      fixture.cleaner.deleteFolderMessages.mockRejectedValue(error);

      await expect(fixture.run()).resolves.toEqual({
        messageExternalIdsToImport: [],
      });
      expect(fixture.ordinary.pendingSyncAction).toBe(
        MessageFolderPendingSyncAction.FOLDER_DELETION,
      );
      expect(fixture.metadata.update).not.toHaveBeenCalled();
      expect(fixture.metadata.delete).not.toHaveBeenCalled();
    },
  );
});
