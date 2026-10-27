import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { isNonEmptyString } from '@sniptt/guards';
import {
  ConnectedAccountProvider,
  MessageChannelContactAutoCreationPolicy,
  MessageChannelPendingGroupEmailsAction,
  MessageChannelSyncStage,
  MessageChannelSyncStatus,
  MessageChannelType,
  type MessageChannelVisibility,
} from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { type EntityManager, In, Repository } from 'typeorm';

import { MESSAGE_CHANNEL_DELETED_EVENT } from 'src/engine/metadata-modules/message-channel/constants/message-channel-deleted.constant';
import { isConnectionHiddenFromRequestUser } from 'src/engine/core-modules/application/connection-provider/connections/utils/is-connection-hidden-from-request-user.util';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { type MessageChannelDTO } from 'src/engine/metadata-modules/message-channel/dtos/message-channel.dto';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import {
  MessageChannelException,
  MessageChannelExceptionCode,
} from 'src/engine/metadata-modules/message-channel/message-channel.exception';
import { type MessageChannelDeletedEvent } from 'src/engine/metadata-modules/message-channel/types/message-channel-deleted.type';
import { WorkspaceEventEmitter } from 'src/engine/workspace-event-emitter/workspace-event-emitter';
import {
  findOmniOwnedMessageChannelIds,
  findOmniOwnedConnectedAccountIds,
} from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';

import {
  OmniMetadataAccountNotFoundError,
  withOmniMetadataMutation,
  lockOmniMetadataAccounts,
  lockOmniMetadataChannel,
} from 'src/modules/omnichannel/services/omni-metadata-transaction';

type ApplicationScope = {
  applicationId: string;
  workspaceId: string;
  // the person who triggered the run, since owning the app does not grant access to another member's private connection;
  // null for cron, webhooks and install hooks
  requestUserWorkspaceId: string | null;
};

type CreateArgs = ApplicationScope & {
  connectedAccountId: string;
  handle: string;
  displayName?: string;
  visibility: MessageChannelVisibility;
};

type UpdateArgs = ApplicationScope & {
  id: string;
  displayName?: string | null;
  visibility?: MessageChannelVisibility;
  isSyncEnabled?: boolean;
};

// TypeORM's update() cannot take the relations Partial<MessageChannelEntity> carries
type UpdatableChannelFields = Partial<
  Pick<MessageChannelEntity, 'displayName' | 'visibility' | 'isSyncEnabled'>
>;

export type OwnedMessageChannel = {
  messageChannel: MessageChannelEntity;
  connectedAccount: ConnectedAccountEntity;
};

// null rather than blank so the UI falls back to the handle
const normalizeDisplayName = (displayName?: string | null): string | null => {
  const trimmedDisplayName = displayName?.trim();

  return isNonEmptyString(trimmedDisplayName) ? trimmedDisplayName : null;
};

@Injectable()
export class ApplicationMessageChannelsService {
  constructor(
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
    @InjectRepository(ConnectedAccountEntity)
    private readonly connectedAccountRepository: Repository<ConnectedAccountEntity>,
    private readonly workspaceEventEmitter: WorkspaceEventEmitter,
  ) {}

  async list({
    applicationId,
    workspaceId,
    requestUserWorkspaceId,
    connectedAccountId,
  }: ApplicationScope & {
    connectedAccountId?: string;
  }): Promise<MessageChannelDTO[]> {
    const ownedAccountIds = await this.findReachableConnectedAccountIds({
      applicationId,
      workspaceId,
      requestUserWorkspaceId,
    });

    if (ownedAccountIds.length === 0) {
      return [];
    }

    if (
      isDefined(connectedAccountId) &&
      !ownedAccountIds.includes(connectedAccountId)
    ) {
      throw this.ownershipViolation(connectedAccountId);
    }

    return this.messageChannelRepository.find({
      where: {
        connectedAccountId: isDefined(connectedAccountId)
          ? connectedAccountId
          : In(ownedAccountIds),
        workspaceId,
        type: MessageChannelType.APP,
      },
    });
  }

  async create({
    applicationId,
    workspaceId,
    requestUserWorkspaceId,
    connectedAccountId,
    handle,
    displayName,
    visibility,
  }: CreateArgs): Promise<MessageChannelDTO> {
    return withOmniMetadataMutation(
      this.messageChannelRepository.manager,
      workspaceId,
      async (manager) => {
        try {
          await lockOmniMetadataAccounts(manager, workspaceId, [
            connectedAccountId,
          ]);
        } catch (error) {
          if (error instanceof OmniMetadataAccountNotFoundError)
            throw this.ownershipViolation(connectedAccountId);
          throw error;
        }
        const repository = manager.getRepository(
          this.messageChannelRepository.target,
        );
        await this.assertOwnsConnectedAccount(
          {
            applicationId,
            workspaceId,
            requestUserWorkspaceId,
            connectedAccountId,
          },
          manager,
        );

        const owned = await findOmniOwnedConnectedAccountIds(
          {
            executeRawQuery: (sql, parameters) =>
              manager.query(sql, parameters),
          },
          workspaceId,
          [connectedAccountId],
        );
        if (owned.size)
          throw new Error('OMNI_OWNED_ACCOUNT_REQUIRES_DOMAIN_LIFECYCLE');

        const existingChannel = await repository.findOne({
          where: { connectedAccountId, handle, workspaceId },
        });

        if (isDefined(existingChannel)) {
          throw new MessageChannelException(
            `A message channel already exists for handle ${handle} on connection ${connectedAccountId}`,
            MessageChannelExceptionCode.INVALID_MESSAGE_CHANNEL_INPUT,
          );
        }

        const entity = repository.create({
          workspaceId,
          connectedAccountId,
          handle,
          displayName: normalizeDisplayName(displayName),
          type: MessageChannelType.APP,
          visibility,
          isSyncEnabled: true,
          // inert since app channels skip the polling crons; mirrors EMAIL_GROUP so the UI reads healthy
          syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
          syncStatus: MessageChannelSyncStatus.ACTIVE,
          isContactAutoCreationEnabled: false,
          contactAutoCreationPolicy:
            MessageChannelContactAutoCreationPolicy.SENT,
          excludeGroupEmails: false,
          excludeNonProfessionalEmails: false,
          pendingGroupEmailsAction: MessageChannelPendingGroupEmailsAction.NONE,
        });

        return repository.save(entity);
      },
    );
  }

  async update({
    applicationId,
    workspaceId,
    requestUserWorkspaceId,
    id,
    displayName,
    visibility,
    isSyncEnabled,
  }: UpdateArgs): Promise<MessageChannelDTO> {
    const data: UpdatableChannelFields = {};

    if (displayName !== undefined) {
      data.displayName = normalizeDisplayName(displayName);
    }

    if (isDefined(visibility)) {
      data.visibility = visibility;
    }

    if (isDefined(isSyncEnabled)) {
      data.isSyncEnabled = isSyncEnabled;
    }

    const scope = { applicationId, workspaceId, requestUserWorkspaceId, id };
    if (Object.keys(data).length === 0) {
      return (await this.findOwnedOrThrow(scope)).messageChannel;
    }
    return withOmniMetadataMutation(
      this.messageChannelRepository.manager,
      workspaceId,
      async (manager) => {
        await this.lockChannelForMutation(manager, workspaceId, id);
        const { messageChannel } = await this.findOwnedOrThrow(scope, manager);
        await this.assertOrdinaryChannel(
          workspaceId,
          messageChannel.id,
          manager,
        );
        const repository = manager.getRepository(
          this.messageChannelRepository.target,
        );
        await repository.update({ id, workspaceId }, data);
        return repository.findOneOrFail({ where: { id, workspaceId } });
      },
    );
  }

  async delete({
    applicationId,
    workspaceId,
    requestUserWorkspaceId,
    id,
  }: ApplicationScope & { id: string }): Promise<MessageChannelDTO> {
    const messageChannel = await withOmniMetadataMutation(
      this.messageChannelRepository.manager,
      workspaceId,
      async (manager) => {
        await this.lockChannelForMutation(manager, workspaceId, id);
        const { messageChannel: channel } = await this.findOwnedOrThrow(
          { applicationId, workspaceId, requestUserWorkspaceId, id },
          manager,
        );
        await this.assertOrdinaryChannel(workspaceId, channel.id, manager);
        await manager
          .getRepository(this.messageChannelRepository.target)
          .delete({ id, workspaceId });
        return channel;
      },
    );

    this.workspaceEventEmitter.emitCustomBatchEvent<MessageChannelDeletedEvent>(
      MESSAGE_CHANNEL_DELETED_EVENT,
      [{ messageChannelId: id }],
      workspaceId,
    );

    return messageChannel;
  }

  private async lockChannelForMutation(
    manager: EntityManager,
    workspaceId: string,
    id: string,
  ): Promise<void> {
    try {
      await lockOmniMetadataChannel(manager, workspaceId, id);
    } catch (error) {
      if (error instanceof OmniMetadataAccountNotFoundError)
        throw this.channelNotFound(id);
      throw error;
    }
  }

  private channelNotFound(id: string): MessageChannelException {
    return new MessageChannelException(
      `Message channel ${id} not found`,
      MessageChannelExceptionCode.MESSAGE_CHANNEL_NOT_FOUND,
    );
  }

  private async assertOrdinaryChannel(
    workspaceId: string,
    messageChannelId: string,
    manager: EntityManager = this.messageChannelRepository.manager,
  ): Promise<void> {
    const ownedIds = await findOmniOwnedMessageChannelIds(
      {
        executeRawQuery: (sql, parameters) => manager.query(sql, parameters),
      },
      workspaceId,
      [messageChannelId],
    );

    if (ownedIds.size > 0) {
      throw new Error('OMNI_OWNED_CHANNEL_REQUIRES_DOMAIN_LIFECYCLE');
    }
  }

  // only the connected account carries applicationId, so resolving through it is what isolates apps
  async findOwnedOrThrow(
    {
      applicationId,
      workspaceId,
      requestUserWorkspaceId,
      id,
    }: ApplicationScope & { id: string },
    manager?: EntityManager,
  ): Promise<OwnedMessageChannel> {
    const repository =
      manager?.getRepository(this.messageChannelRepository.target) ??
      this.messageChannelRepository;
    const messageChannel = await repository.findOne({
      where: { id, workspaceId, type: MessageChannelType.APP },
    });

    const connectedAccount = isDefined(messageChannel)
      ? await this.findReachableConnectedAccount(
          {
            applicationId,
            workspaceId,
            requestUserWorkspaceId,
            connectedAccountId: messageChannel.connectedAccountId,
          },
          manager,
        )
      : null;

    // missing and unreachable answer identically so callers cannot probe for channels
    if (!isDefined(messageChannel) || !isDefined(connectedAccount)) {
      throw this.channelNotFound(id);
    }

    return { messageChannel, connectedAccount };
  }

  // ownership alone would let any app user flip another member's private channel to SHARE_EVERYTHING
  private async assertOwnsConnectedAccount(
    args: ApplicationScope & { connectedAccountId: string },
    manager?: EntityManager,
  ): Promise<void> {
    if (!isDefined(await this.findReachableConnectedAccount(args, manager))) {
      throw this.ownershipViolation(args.connectedAccountId);
    }
  }

  // public so MessageChannelResolver shares the single reachability rule
  async findReachableConnectedAccount(
    {
      applicationId,
      workspaceId,
      requestUserWorkspaceId,
      connectedAccountId,
    }: ApplicationScope & {
      connectedAccountId: string;
    },
    manager?: EntityManager,
  ): Promise<ConnectedAccountEntity | null> {
    const repository =
      manager?.getRepository(this.connectedAccountRepository.target) ??
      this.connectedAccountRepository;
    const connectedAccount = await repository.findOne({
      where: {
        id: connectedAccountId,
        applicationId,
        workspaceId,
        provider: ConnectedAccountProvider.APP,
      },
    });

    if (
      !isDefined(connectedAccount) ||
      isConnectionHiddenFromRequestUser({
        account: connectedAccount,
        requestUserWorkspaceId,
      })
    ) {
      return null;
    }

    return connectedAccount;
  }

  private async findReachableConnectedAccountIds({
    applicationId,
    workspaceId,
    requestUserWorkspaceId,
  }: ApplicationScope): Promise<string[]> {
    const connectedAccounts = await this.connectedAccountRepository.find({
      where: {
        applicationId,
        workspaceId,
        provider: ConnectedAccountProvider.APP,
      },
      select: { id: true, scope: true, userWorkspaceId: true },
    });

    return connectedAccounts
      .filter(
        (connectedAccount) =>
          !isConnectionHiddenFromRequestUser({
            account: connectedAccount,
            requestUserWorkspaceId,
          }),
      )
      .map((connectedAccount) => connectedAccount.id);
  }

  // indistinguishable from not found so one app cannot probe another's connection ids
  private ownershipViolation(connectedAccountId: string) {
    return new MessageChannelException(
      `Connection ${connectedAccountId} not found`,
      MessageChannelExceptionCode.MESSAGE_CHANNEL_OWNERSHIP_VIOLATION,
    );
  }
}
