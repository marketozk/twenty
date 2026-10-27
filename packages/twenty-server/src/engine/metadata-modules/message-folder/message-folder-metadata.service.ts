import { withOrdinaryMetadataFolders } from 'src/modules/omnichannel/services/with-ordinary-metadata-folders';
import { findOmniOwnedMessageFolderIds } from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { In, Repository } from 'typeorm';

import {
  ConnectedAccountProvider,
  MessageFolderPendingSyncAction,
} from 'twenty-shared/types';

import { ConnectedAccountMetadataService } from 'src/engine/metadata-modules/connected-account/connected-account-metadata.service';
import { MessageFolderDTO } from 'src/engine/metadata-modules/message-folder/dtos/message-folder.dto';
import { MessageFolderEntity } from 'src/engine/metadata-modules/message-folder/entities/message-folder.entity';
import {
  MessageFolderException,
  MessageFolderExceptionCode,
} from 'src/engine/metadata-modules/message-folder/message-folder.exception';
import { MessageChannelMetadataService } from 'src/engine/metadata-modules/message-channel/message-channel-metadata.service';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { type QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

@Injectable()
export class MessageFolderMetadataService {
  constructor(
    // The manager is only reachable from the raw repository, and every
    // statement inside the transaction carries workspaceId itself.
    // eslint-disable-next-line twenty/prefer-workspace-scoped-repository
    @InjectRepository(MessageFolderEntity)
    private readonly unscopedRepository: Repository<MessageFolderEntity>,
    @InjectWorkspaceScopedRepository(MessageFolderEntity)
    private readonly repository: WorkspaceScopedRepository<MessageFolderEntity>,
    private readonly messageChannelMetadataService: MessageChannelMetadataService,
    private readonly connectedAccountMetadataService: ConnectedAccountMetadataService,
  ) {}

  async findAll(workspaceId: string): Promise<MessageFolderDTO[]> {
    return this.repository.find(workspaceId);
  }

  async findByUserWorkspaceId({
    userWorkspaceId,
    workspaceId,
  }: {
    userWorkspaceId: string;
    workspaceId: string;
  }): Promise<MessageFolderDTO[]> {
    const userAccountIds =
      await this.connectedAccountMetadataService.getUserConnectedAccountIds({
        userWorkspaceId,
        workspaceId,
      });

    const userChannels =
      await this.messageChannelMetadataService.findByConnectedAccountIds({
        connectedAccountIds: userAccountIds,
        workspaceId,
      });

    const userChannelIds = userChannels.map((channel) => channel.id);

    return this.findByMessageChannelIds({
      messageChannelIds: userChannelIds,
      workspaceId,
    });
  }

  async findByMessageChannelIdForUser({
    messageChannelId,
    userWorkspaceId,
    workspaceId,
  }: {
    messageChannelId: string;
    userWorkspaceId: string;
    workspaceId: string;
  }): Promise<MessageFolderDTO[]> {
    await this.messageChannelMetadataService.verifyUsableByCaller({
      id: messageChannelId,
      userWorkspaceId,
      workspaceId,
    });

    return this.findByMessageChannelId({ messageChannelId, workspaceId });
  }

  async findByMessageChannelId({
    messageChannelId,
    workspaceId,
  }: {
    messageChannelId: string;
    workspaceId: string;
  }): Promise<MessageFolderDTO[]> {
    return this.repository.find(workspaceId, {
      where: { messageChannelId },
    });
  }

  async findByMessageChannelIds({
    messageChannelIds,
    workspaceId,
  }: {
    messageChannelIds: string[];
    workspaceId: string;
  }): Promise<MessageFolderDTO[]> {
    if (messageChannelIds.length === 0) {
      return [];
    }

    return this.repository.find(workspaceId, {
      where: { messageChannelId: In(messageChannelIds) },
    });
  }

  async findById({
    id,
    workspaceId,
  }: {
    id: string;
    workspaceId: string;
  }): Promise<MessageFolderDTO | null> {
    return this.repository.findOne(workspaceId, { where: { id } });
  }

  async verifyOwnership({
    id,
    userWorkspaceId,
    workspaceId,
  }: {
    id: string;
    userWorkspaceId: string;
    workspaceId: string;
  }): Promise<MessageFolderEntity> {
    const messageFolder = await this.repository.findOne(workspaceId, {
      where: { id },
    });

    if (!messageFolder) {
      throw new MessageFolderException(
        `Message folder ${id} not found`,
        MessageFolderExceptionCode.MESSAGE_FOLDER_NOT_FOUND,
      );
    }

    const userAccountIds =
      await this.connectedAccountMetadataService.getUserConnectedAccountIds({
        userWorkspaceId,
        workspaceId,
      });

    const messageChannel = await this.messageChannelMetadataService.findById({
      id: messageFolder.messageChannelId,
      workspaceId,
    });

    if (
      !messageChannel ||
      !userAccountIds.includes(messageChannel.connectedAccountId)
    ) {
      throw new MessageFolderException(
        `Message folder ${id} does not belong to user workspace ${userWorkspaceId}`,
        MessageFolderExceptionCode.MESSAGE_FOLDER_OWNERSHIP_VIOLATION,
      );
    }

    return messageFolder;
  }

  async create(
    data: Partial<MessageFolderEntity> & {
      workspaceId: string;
      messageChannelId: string;
      pendingSyncAction: MessageFolderPendingSyncAction;
    },
  ): Promise<MessageFolderDTO> {
    const createData = { ...data };
    this.assertMutationScope(createData.workspaceId, createData.id, createData);
    return withOrdinaryMetadataFolders(
      this.unscopedRepository.manager,
      createData.workspaceId,
      [],
      async (manager) => {
        const folder = await this.repository
          .withManager(manager)
          .insertAndReturnOne(
            createData.workspaceId,
            createData as QueryDeepPartialEntity<MessageFolderEntity>,
          );
        const owned = await findOmniOwnedMessageFolderIds(
          {
            executeRawQuery: (sql, parameters) =>
              manager.query(sql, parameters),
          },
          createData.workspaceId,
          [folder.id],
        );
        if (owned.size)
          throw new Error('OMNI_OWNED_FOLDER_REQUIRES_DOMAIN_LIFECYCLE');
        return folder;
      },
      createData.messageChannelId,
    );
  }

  async update({
    id,
    workspaceId,
    data,
    userWorkspaceId,
  }: {
    id: string;
    workspaceId: string;
    data: Partial<MessageFolderEntity>;
    userWorkspaceId?: string;
  }): Promise<MessageFolderDTO> {
    const values = { ...data };
    this.assertMutationScope(workspaceId, id, values);
    return withOrdinaryMetadataFolders(
      this.unscopedRepository.manager,
      workspaceId,
      [id],
      async (manager, channels) => {
        this.assertCurrentUser(channels, userWorkspaceId);
        const repository = this.repository.withManager(manager);
        await repository.update(
          workspaceId,
          { id },
          values as Record<string, unknown>,
        );
        return repository.findOneOrFail(workspaceId, { where: { id } });
      },
      values.messageChannelId,
    );
  }

  async setSyncStatus({
    ids,
    workspaceId,
    data,
    userWorkspaceId,
  }: {
    ids: string[];
    workspaceId: string;
    data: Partial<MessageFolderEntity>;
    userWorkspaceId?: string;
  }): Promise<MessageFolderDTO[]> {
    const requestedIds = [...new Set(ids)];
    const isSynced = data.isSynced;
    if (!requestedIds.length) return [];
    return withOrdinaryMetadataFolders(
      this.unscopedRepository.manager,
      workspaceId,
      requestedIds,
      async (manager, channels) => {
        this.assertCurrentUser(channels, userWorkspaceId);
        const repository = this.repository.withManager(manager);
        if (!isSynced) {
          await repository.update(
            workspaceId,
            { id: In(requestedIds) },
            { isSynced: false },
          );
          await repository.update(
            workspaceId,
            {
              id: In(requestedIds),
              pendingSyncAction: MessageFolderPendingSyncAction.FOLDER_IMPORT,
            },
            { pendingSyncAction: MessageFolderPendingSyncAction.NONE },
          );
        } else {
          const backfill: { id: string }[] = await manager.query(
            'SELECT folder.id FROM core."messageFolder" folder JOIN core."messageChannel" channel ON channel.id=folder."messageChannelId" AND channel."workspaceId"=folder."workspaceId" JOIN core."connectedAccount" account ON account.id=channel."connectedAccountId" AND account."workspaceId"=channel."workspaceId" WHERE folder."workspaceId"=$1 AND folder.id=ANY($2::uuid[]) AND folder."isSynced"=false AND account.provider=$3',
            [workspaceId, requestedIds, ConnectedAccountProvider.GOOGLE],
          );
          await repository.update(
            workspaceId,
            { id: In(requestedIds) },
            { isSynced: true },
          );
          if (backfill.length)
            await repository.update(
              workspaceId,
              { id: In(backfill.map(({ id }) => id)) },
              {
                pendingSyncAction: MessageFolderPendingSyncAction.FOLDER_IMPORT,
              },
            );
        }
        return repository.find(workspaceId, {
          where: { id: In(requestedIds) },
        });
      },
    );
  }

  async delete({
    id,
    workspaceId,
  }: {
    id: string;
    workspaceId: string;
  }): Promise<MessageFolderDTO> {
    return withOrdinaryMetadataFolders(
      this.unscopedRepository.manager,
      workspaceId,
      [id],
      async (manager) => {
        const repository = this.repository.withManager(manager);
        const folder = await repository.findOneOrFail(workspaceId, {
          where: { id },
        });
        await repository.delete(workspaceId, { id });
        return folder;
      },
    );
  }

  private assertMutationScope(
    workspaceId: string,
    id: string | undefined,
    data: Partial<MessageFolderEntity>,
  ) {
    if (
      data.workspace !== undefined ||
      data.messageChannel !== undefined ||
      (data.id !== undefined && data.id !== id) ||
      (data.workspaceId !== undefined && data.workspaceId !== workspaceId)
    )
      throw new Error('OMNI_METADATA_SCOPE_CHANGE_REQUIRES_DOMAIN_LIFECYCLE');
  }

  private assertCurrentUser(
    channels: { userWorkspaceId: string }[],
    userWorkspaceId?: string,
  ) {
    if (
      userWorkspaceId !== undefined &&
      channels.some((channel) => channel.userWorkspaceId !== userWorkspaceId)
    )
      throw new MessageFolderException(
        'Message folder no longer belongs to this caller',
        MessageFolderExceptionCode.MESSAGE_FOLDER_OWNERSHIP_VIOLATION,
      );
  }
}
