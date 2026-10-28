import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import {
  ConnectedAccountProvider,
  MessageFolderPendingSyncAction,
} from 'twenty-shared/types';
import { DataSource, In, type EntityManager } from 'typeorm';

import {
  DiscoveredMessageFolder,
  MessageFolder,
} from 'src/modules/messaging/message-folder-manager/interfaces/message-folder-driver.interface';

import { type MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { MessageFolderEntity } from 'src/engine/metadata-modules/message-folder/entities/message-folder.entity';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { GmailGetAllFoldersService } from 'src/modules/messaging/message-folder-manager/drivers/gmail/services/gmail-get-all-folders.service';
import { ImapGetAllFoldersService } from 'src/modules/messaging/message-folder-manager/drivers/imap/services/imap-get-all-folders.service';
import { MicrosoftGetAllFoldersService } from 'src/modules/messaging/message-folder-manager/drivers/microsoft/services/microsoft-get-all-folders.service';
import { computeFolderIdsToDelete } from 'src/modules/messaging/message-folder-manager/utils/compute-folder-ids-to-delete.util';
import { computeFoldersToCreate } from 'src/modules/messaging/message-folder-manager/utils/compute-folders-to-create.util';
import { computeFoldersToUpdate } from 'src/modules/messaging/message-folder-manager/utils/compute-folders-to-update.util';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { type QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { withOrdinaryMetadataChannels } from 'src/modules/omnichannel/services/with-ordinary-metadata-channels';
import { findOmniOwnedMessageFolderIds } from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';
import { METADATA_ACTION_TIMESTAMP_SQL } from 'src/modules/omnichannel/services/lock-ordinary-metadata-action-channel';

type FolderDiscoveryScope = {
  workspaceId: string;
  messageChannelId: string;
  connectedAccountId: string;
};
type FolderDiscoverySnapshot = {
  account: ConnectedAccountEntity;
  channel: MessageChannelEntity & { version: string };
  folders: (MessageFolderEntity & { version: string })[];
};

const discoveryVersion = (snapshot: FolderDiscoverySnapshot) =>
  JSON.stringify({
    account: [
      snapshot.account.id,
      snapshot.account.provider,
      snapshot.account.userWorkspaceId,
      snapshot.account.applicationId,
      snapshot.account.connectionProviderId,
      snapshot.account.handle,
      snapshot.account.externalAccountId,
      snapshot.account.connectionParameters,
      snapshot.account.archivedAt,
    ],
    channel: [
      snapshot.channel.version,
      snapshot.channel.messageFolderImportPolicy,
    ],
    folders: snapshot.folders,
  });

@Injectable()
export class SyncMessageFoldersService {
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    @InjectWorkspaceScopedRepository(MessageFolderEntity)
    private readonly messageFolderRepository: WorkspaceScopedRepository<MessageFolderEntity>,
    private readonly gmailGetAllFoldersService: GmailGetAllFoldersService,
    private readonly microsoftGetAllFoldersService: MicrosoftGetAllFoldersService,
    private readonly imapGetAllFoldersService: ImapGetAllFoldersService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async syncMessageFolders({
    messageChannel,
    workspaceId,
  }: {
    messageChannel: Pick<
      MessageChannelEntity,
      'id' | 'messageFolderImportPolicy'
    > & {
      connectedAccount: Pick<
        ConnectedAccountEntity,
        | 'provider'
        | 'accessToken'
        | 'refreshToken'
        | 'id'
        | 'handle'
        | 'connectionParameters'
        | 'workspaceId'
      >;
      messageFolders: MessageFolder[];
    };
    workspaceId: string;
  }): Promise<MessageFolder[] | null> {
    const scope = {
      workspaceId,
      messageChannelId: messageChannel.id,
      connectedAccountId: messageChannel.connectedAccount.id,
    };
    if (messageChannel.connectedAccount.workspaceId !== workspaceId)
      throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
    const snapshot = await this.withCurrentFolders(
      scope,
      async (_manager, current) => current,
    );
    if (!snapshot) return null;
    // Drivers may refresh credentials; compare identity and folder state, not tokens.
    const version = discoveryVersion(snapshot);
    const discoveredFolders = await this.discoverAllFolders(
      snapshot.account,
      snapshot.channel,
      snapshot.folders,
    );
    return this.workspaceOrmManager.executeInWorkspaceContext(
      () =>
        this.withCurrentFolders(scope, async (manager, current) => {
          if (discoveryVersion(current) !== version) return null;
          return this.syncFolderChanges(
            discoveredFolders,
            current.folders,
            scope.messageChannelId,
            workspaceId,
            manager,
          );
        }),
      buildSystemAuthContext(workspaceId),
      { lite: true },
    );
  }

  private withCurrentFolders<TResult>(
    scope: FolderDiscoveryScope,
    work: (
      manager: EntityManager,
      snapshot: FolderDiscoverySnapshot,
    ) => Promise<TResult>,
  ): Promise<TResult | null> {
    return withOrdinaryMetadataChannels(
      this.dataSource.manager,
      scope.workspaceId,
      [scope.messageChannelId],
      'message',
      async (manager, channels) => {
        if (!channels.length) return null;
        const [account] = await manager.query(
          'SELECT * FROM core."connectedAccount" WHERE "workspaceId"=$1 AND id=$2',
          [scope.workspaceId, scope.connectedAccountId],
        );
        const [channel] = await manager.query(
          `SELECT *,${METADATA_ACTION_TIMESTAMP_SQL} AS version FROM core."messageChannel" WHERE "workspaceId"=$1 AND id=$2`,
          [scope.workspaceId, scope.messageChannelId],
        );
        const folders = await manager.query(
          `SELECT *,${METADATA_ACTION_TIMESTAMP_SQL} AS version FROM core."messageFolder" WHERE "workspaceId"=$1 AND "messageChannelId"=$2 ORDER BY id FOR UPDATE`,
          [scope.workspaceId, scope.messageChannelId],
        );
        const owned = await findOmniOwnedMessageFolderIds(
          { executeRawQuery: (sql, params) => manager.query(sql, params) },
          scope.workspaceId,
          folders.map((folder: { id: string }) => folder.id),
        );
        if (owned.size) return null;
        return work(manager, { account, channel, folders });
      },
      'read',
      scope.connectedAccountId,
    );
  }

  async discoverAllFolders(
    connectedAccount: Pick<
      ConnectedAccountEntity,
      | 'accessToken'
      | 'refreshToken'
      | 'id'
      | 'handle'
      | 'provider'
      | 'connectionParameters'
      | 'workspaceId'
    >,
    messageChannel: Pick<MessageChannelEntity, 'messageFolderImportPolicy'>,
    existingFolders: MessageFolder[],
  ): Promise<DiscoveredMessageFolder[]> {
    switch (connectedAccount.provider) {
      case ConnectedAccountProvider.GOOGLE:
        return this.gmailGetAllFoldersService.getAllMessageFolders(
          connectedAccount,
          messageChannel,
        );
      case ConnectedAccountProvider.MICROSOFT:
        return this.microsoftGetAllFoldersService.getAllMessageFolders(
          connectedAccount,
          messageChannel,
        );
      case ConnectedAccountProvider.IMAP_SMTP_CALDAV:
        return this.imapGetAllFoldersService.getAllMessageFolders(
          connectedAccount,
          messageChannel,
          existingFolders,
        );
      default:
        throw new Error(
          `Provider ${connectedAccount.provider} is not supported`,
        );
    }
  }

  private async syncFolderChanges(
    discoveredFolders: DiscoveredMessageFolder[],
    existingFolders: MessageFolder[],
    messageChannelId: string,
    workspaceId: string,
    manager: EntityManager,
  ): Promise<MessageFolder[]> {
    const foldersToCreate = computeFoldersToCreate({
      discoveredFolders,
      existingFolders,
      messageChannelId,
    });

    const foldersToUpdate = computeFoldersToUpdate({
      discoveredFolders,
      existingFolders,
    });

    const folderIdsToDelete = computeFolderIdsToDelete({
      discoveredFolders,
      existingFolders,
    });

    const repository = this.messageFolderRepository.withManager(manager);
    if (folderIdsToDelete.length > 0) {
      await repository.update(
        workspaceId,
        { id: In(folderIdsToDelete), messageChannelId },
        {
          pendingSyncAction: MessageFolderPendingSyncAction.FOLDER_DELETION,
        },
      );
    }

    if (foldersToUpdate.size > 0) {
      for (const [id, data] of foldersToUpdate.entries()) {
        await repository.update(
          workspaceId,
          { id, messageChannelId },
          data as Record<string, unknown>,
        );
      }
    }

    if (foldersToCreate.length > 0) {
      for (const folderToCreate of foldersToCreate) {
        await repository.insert(
          workspaceId,
          folderToCreate as QueryDeepPartialEntity<MessageFolderEntity>,
        );
      }
    }

    return repository.find(workspaceId, {
      where: { messageChannelId },
      order: { id: 'ASC' },
    });
  }
}
