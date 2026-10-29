import { Injectable, Logger } from '@nestjs/common';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { isUUID } from 'class-validator';
import { consumeAccountScopeRepairExecution } from 'src/engine/core-modules/crm-audit/account-scope-repair-execution';
import { captureCurrentCrmAuditIdentity } from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import {
  captureAccountDeletionBoundary,
  type ConnectedAccountDeletionBoundary,
} from 'src/engine/core-modules/crm-audit/connected-account-deletion-boundary';
import {
  deleteConnectedAccountsWithAudit,
  type DeletedConnectedAccountGraph,
} from 'src/engine/core-modules/crm-audit/delete-connected-accounts-with-audit';
import {
  transferConnectedAccountsWithAudit,
  disconnectConnectedAccountWithAudit,
} from 'src/engine/core-modules/crm-audit/transfer-connected-accounts-with-audit';
import {
  captureMembershipCleanupIdentity,
  copyMembershipCleanupIdentity,
  membershipCleanupOperation,
  type MembershipCleanupAuthentication,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { InjectRepository } from '@nestjs/typeorm';

import { type EntityManager, In, IsNull, Repository } from 'typeorm';

import {
  ConnectedAccountProvider,
  EmailOperation,
  WebhookSubscriptionStatus,
} from 'twenty-shared/types';
import {
  assertUnreachable,
  canConnectedAccountPerformEmailOperation,
  getEmailProvidersForOperation,
  isDefined,
} from 'twenty-shared/utils';

import { ConnectionProviderLifecycleHookService } from 'src/engine/core-modules/application/connection-provider/connection-provider-lifecycle-hook.service';
import { AppOAuthRevokeService } from 'src/engine/core-modules/application/connection-provider/refresh/services/app-oauth-revoke.service';
import { CALENDAR_CHANNEL_DELETED_EVENT } from 'src/engine/metadata-modules/calendar-channel/constants/calendar-channel-deleted.constant';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { type CalendarChannelDeletedEvent } from 'src/engine/metadata-modules/calendar-channel/types/calendar-channel-deleted.type';
import { CONNECTED_ACCOUNT_DELETED_EVENT } from 'src/engine/metadata-modules/connected-account/constants/connected-account-deleted.constant';
import {
  ConnectedAccountException,
  ConnectedAccountExceptionCode,
} from 'src/engine/metadata-modules/connected-account/connected-account.exception';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { type ConnectedAccountDeletedEvent } from 'src/engine/metadata-modules/connected-account/types/connected-account-deleted.type';
import { type ConnectedAccountUsableByCaller } from 'src/engine/metadata-modules/connected-account/types/connected-account-usable-by-caller.type';
import { buildConnectedAccountUsableByCallerWhere } from 'src/engine/metadata-modules/connected-account/utils/build-connected-account-usable-by-caller-where.util';
import { getConnectedAccountAdministrationPermissionFlag } from 'src/engine/metadata-modules/connected-account/utils/get-connected-account-administration-permission-flag.util';
import { isConnectedAccountUsableByCaller } from 'src/engine/metadata-modules/connected-account/utils/is-connected-account-usable-by-caller.util';
import { MESSAGE_CHANNEL_DELETED_EVENT } from 'src/engine/metadata-modules/message-channel/constants/message-channel-deleted.constant';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { type MessageChannelDeletedEvent } from 'src/engine/metadata-modules/message-channel/types/message-channel-deleted.type';
import { PermissionsService } from 'src/engine/metadata-modules/permissions/permissions.service';
import { WorkspaceEventEmitter } from 'src/engine/workspace-event-emitter/workspace-event-emitter';
import { CalendarWebhookSubscriptionService } from 'src/modules/connected-account/webhook-subscription-manager/services/calendar-webhook-subscription.service';
import { MessagingWebhookSubscriptionService } from 'src/modules/connected-account/webhook-subscription-manager/services/messaging-webhook-subscription.service';
import {
  findOmniOwnedConnectedAccountIds,
  findOmniOwnedMessageFolderIds,
} from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';

import {
  withOmniMetadataMutation,
  lockOmniMetadataAccounts,
} from 'src/modules/omnichannel/services/omni-metadata-transaction';

const isNativeMessengerAccount = (account: ConnectedAccountEntity) =>
  account.provider === ConnectedAccountProvider.APP &&
  account.applicationId === null &&
  account.connectionProviderId === null;

@Injectable()
export class ConnectedAccountMetadataService {
  private readonly logger = new Logger(ConnectedAccountMetadataService.name);

  constructor(
    @InjectRepository(ConnectedAccountEntity)
    private readonly repository: Repository<ConnectedAccountEntity>,
    @InjectRepository(CalendarChannelEntity)
    private readonly calendarChannelRepository: Repository<CalendarChannelEntity>,
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
    private readonly appOAuthRevokeService: AppOAuthRevokeService,
    private readonly connectionProviderLifecycleHookService: ConnectionProviderLifecycleHookService,
    private readonly permissionsService: PermissionsService,
    private readonly workspaceEventEmitter: WorkspaceEventEmitter,
    private readonly calendarWebhookSubscriptionService: CalendarWebhookSubscriptionService,
    private readonly messagingWebhookSubscriptionService: MessagingWebhookSubscriptionService,
  ) {}

  async findMailboxesUsableByCaller({
    workspaceId,
    userWorkspaceId,
    operation,
  }: {
    workspaceId: string;
    userWorkspaceId?: string;
    operation: EmailOperation;
  }): Promise<ConnectedAccountUsableByCaller[]> {
    const connectedAccounts = await this.repository.find({
      where: {
        workspaceId,
        archivedAt: IsNull(),
        provider: In(getEmailProvidersForOperation(operation)),
      },
      order: { createdAt: 'ASC', id: 'ASC' },
      select: {
        id: true,
        handle: true,
        handleAliases: true,
        provider: true,
        name: true,
        scope: true,
        userWorkspaceId: true,
        connectionParameters: true,
      },
    });

    return connectedAccounts
      .filter((connectedAccount) =>
        canConnectedAccountPerformEmailOperation({
          connectedAccount,
          operation,
        }),
      )
      .filter((connectedAccount) =>
        isDefined(userWorkspaceId)
          ? isConnectedAccountUsableByCaller({
              connectedAccount,
              userWorkspaceId,
            })
          : connectedAccount.scope === 'WORKSPACE',
      );
  }

  async findUsableByCaller({
    userWorkspaceId,
    workspaceId,
  }: {
    userWorkspaceId: string;
    workspaceId: string;
  }): Promise<ConnectedAccountEntity[]> {
    const accounts = await this.repository.find({
      where: buildConnectedAccountUsableByCallerWhere({
        baseWhere: { workspaceId },
        userWorkspaceId,
      }),
      order: { createdAt: 'ASC', id: 'ASC' },
    });

    const ownedAccounts = accounts.filter(
      (account) => account.userWorkspaceId === userWorkspaceId,
    );

    const activeSharedAccountsOwnedByOthers = accounts.filter(
      (account) =>
        account.userWorkspaceId !== userWorkspaceId &&
        !isDefined(account.archivedAt),
    );

    return [...ownedAccounts, ...activeSharedAccountsOwnedByOthers];
  }

  async findApplicationConnectedAccountsUsableByCaller({
    applicationId,
    workspaceId,
    userWorkspaceId,
  }: {
    applicationId: string;
    workspaceId: string;
    userWorkspaceId: string;
  }): Promise<ConnectedAccountEntity[]> {
    return this.repository.find({
      where: buildConnectedAccountUsableByCallerWhere({
        baseWhere: {
          applicationId,
          workspaceId,
          provider: ConnectedAccountProvider.APP,
          archivedAt: IsNull(),
        },
        userWorkspaceId,
      }),
      order: { createdAt: 'ASC', id: 'ASC' },
      select: {
        id: true,
        handle: true,
        provider: true,
        lastCredentialsRefreshedAt: true,
        authFailedAt: true,
        authFailedReason: true,
        archivedAt: true,
        handleAliases: true,
        scopes: true,
        lastSignedInAt: true,
        userWorkspaceId: true,
        connectionProviderId: true,
        applicationId: true,
        workspaceId: true,
        name: true,
        scope: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async findById({
    id,
    workspaceId,
  }: {
    id: string;
    workspaceId: string;
  }): Promise<ConnectedAccountEntity | null> {
    return this.repository.findOne({ where: { id, workspaceId } });
  }

  async findByIdAndUserWorkspaceId({
    id,
    userWorkspaceId,
    workspaceId,
  }: {
    id: string;
    userWorkspaceId: string;
    workspaceId: string;
  }): Promise<ConnectedAccountEntity | null> {
    return this.repository.findOne({
      where: { id, userWorkspaceId, workspaceId },
    });
  }

  async verifyUsableByCaller({
    id,
    userWorkspaceId,
    workspaceId,
  }: {
    id: string;
    userWorkspaceId: string;
    workspaceId: string;
  }): Promise<ConnectedAccountEntity> {
    const connectedAccount = await this.findByIdOrThrow({ id, workspaceId });

    if (
      !isConnectedAccountUsableByCaller({ connectedAccount, userWorkspaceId })
    ) {
      throw new ConnectedAccountException(
        `Connected account ${id} is not usable by user workspace ${userWorkspaceId}`,
        ConnectedAccountExceptionCode.CONNECTED_ACCOUNT_OWNERSHIP_VIOLATION,
      );
    }

    return connectedAccount;
  }

  async isAdministrableByCaller({
    connectedAccount,
    userWorkspaceId,
    workspaceId,
    applicationId,
    agentId,
  }: {
    connectedAccount: Pick<
      ConnectedAccountEntity,
      'scope' | 'userWorkspaceId' | 'provider'
    >;
    userWorkspaceId: string;
    workspaceId: string;
    applicationId?: string;
    agentId?: string;
  }): Promise<boolean> {
    if (connectedAccount.userWorkspaceId === userWorkspaceId) {
      return true;
    }

    switch (connectedAccount.scope) {
      case 'WORKSPACE':
        return this.permissionsService.userHasWorkspaceSettingPermission({
          userWorkspaceId,
          workspaceId,
          applicationId,
          agentId,
          setting: getConnectedAccountAdministrationPermissionFlag(
            connectedAccount.provider,
          ),
        });
      case 'USER':
        return false;
      default:
        return assertUnreachable(connectedAccount.scope);
    }
  }

  async verifyAdministrableByCaller({
    id,
    userWorkspaceId,
    workspaceId,
    applicationId,
    agentId,
  }: {
    id: string;
    userWorkspaceId: string;
    workspaceId: string;
    applicationId?: string;
    agentId?: string;
  }): Promise<ConnectedAccountEntity> {
    const connectedAccount = await this.findByIdOrThrow({ id, workspaceId });

    const isAdministrableByCaller = await this.isAdministrableByCaller({
      connectedAccount,
      userWorkspaceId,
      workspaceId,
      applicationId,
      agentId,
    });

    if (!isAdministrableByCaller) {
      throw new ConnectedAccountException(
        `Connected account ${id} cannot be administered by user workspace ${userWorkspaceId}`,
        ConnectedAccountExceptionCode.CONNECTED_ACCOUNT_OWNERSHIP_VIOLATION,
      );
    }

    return connectedAccount;
  }

  private async findByIdOrThrow({
    id,
    workspaceId,
  }: {
    id: string;
    workspaceId: string;
  }): Promise<ConnectedAccountEntity> {
    const connectedAccount = await this.repository.findOne({
      where: { id, workspaceId },
    });

    if (!isDefined(connectedAccount)) {
      throw new ConnectedAccountException(
        `Connected account ${id} not found`,
        ConnectedAccountExceptionCode.CONNECTED_ACCOUNT_NOT_FOUND,
      );
    }

    return connectedAccount;
  }

  async getUserConnectedAccountIds({
    userWorkspaceId,
    workspaceId,
  }: {
    userWorkspaceId: string;
    workspaceId: string;
  }): Promise<string[]> {
    const accounts = await this.repository.find({
      where: { userWorkspaceId, workspaceId },
      select: ['id'],
    });

    return accounts.map((account) => account.id);
  }

  async getWorkspaceSharedConnectedAccountIds({
    workspaceId,
  }: {
    workspaceId: string;
  }): Promise<string[]> {
    const accounts = await this.repository.find({
      where: { workspaceId, scope: 'WORKSPACE', archivedAt: IsNull() },
      select: ['id'],
    });

    return accounts.map((account) => account.id);
  }

  async create(
    data: Partial<ConnectedAccountEntity> & {
      workspaceId: string;
      handle: string;
      provider: string;
      userWorkspaceId: string;
    },
  ): Promise<ConnectedAccountEntity> {
    const createData = { ...data };

    if (createData.id !== undefined) {
      throw new Error('OMNI_METADATA_CREATE_ID_FORBIDDEN');
    }

    const entity = this.repository.create(createData);

    return this.repository.save(entity);
  }

  async update({
    id,
    workspaceId,
    data,
  }: {
    id: string;
    workspaceId: string;
    data: Partial<ConnectedAccountEntity>;
  }): Promise<ConnectedAccountEntity> {
    const updateData = { ...data };

    if (
      updateData.workspace !== undefined ||
      updateData.application !== undefined ||
      updateData.connectionProvider !== undefined ||
      (updateData.id !== undefined && updateData.id !== id) ||
      (updateData.workspaceId !== undefined &&
        updateData.workspaceId !== workspaceId)
    ) {
      throw new Error('OMNI_METADATA_SCOPE_CHANGE_REQUIRES_DOMAIN_LIFECYCLE');
    }

    return withOmniMetadataMutation(
      this.repository.manager,
      workspaceId,
      async (manager) => {
        await lockOmniMetadataAccounts(manager, workspaceId, [id], 'write');
        await this.assertOrdinaryAccounts(workspaceId, [id], manager);
        const repository = manager.getRepository(this.repository.target);
        const current = await repository.findOneOrFail({
          where: { id, workspaceId },
        });
        for (const key of [
          'provider',
          'applicationId',
          'connectionProviderId',
        ] as const) {
          if (
            updateData[key] !== undefined &&
            updateData[key] !== current[key]
          ) {
            throw new Error('CONNECTED_ACCOUNT_IDENTITY_IMMUTABLE');
          }
        }
        await repository.update(
          { id, workspaceId },
          updateData as Record<string, unknown>,
        );
        return repository.findOneOrFail({ where: { id, workspaceId } });
      },
    );
  }

  async transferOwnership({
    fromUserWorkspaceId,
    toUserWorkspaceId,
    workspaceId,
    auditOperation,
  }: {
    fromUserWorkspaceId: string;
    toUserWorkspaceId: string;
    workspaceId: string;
    auditOperation?: CrmAuditOperation;
  }): Promise<void> {
    const capturedOperation = auditOperation
      ? {
          ...auditOperation,
          actor: { ...auditOperation.actor },
          ...(auditOperation.initiator
            ? { initiator: { ...auditOperation.initiator } }
            : {}),
        }
      : undefined;
    const connectedAccounts = await this.repository.find({
      where: { userWorkspaceId: fromUserWorkspaceId, workspaceId },
    });

    if (connectedAccounts.length === 0) {
      return;
    }

    const connectedAccountIds = connectedAccounts.map((account) => account.id);

    await this.assertOrdinaryAccounts(workspaceId, connectedAccountIds);

    const [messageChannels, calendarChannels] = await Promise.all([
      this.messageChannelRepository.find({
        where: { connectedAccountId: In(connectedAccountIds), workspaceId },
        select: { id: true, connectedAccountId: true },
      }),
      this.calendarChannelRepository.find({
        where: { connectedAccountId: In(connectedAccountIds), workspaceId },
        select: { id: true, connectedAccountId: true },
      }),
    ]);

    await this.stopWebhookSubscriptions({
      messageChannels,
      calendarChannels,
      workspaceId,
      nativeAccountIds: new Set(
        connectedAccounts.filter(isNativeMessengerAccount).map(({ id }) => id),
      ),
    }).catch((error) =>
      this.logger.warn(
        `WorkspaceId: ${workspaceId} Failed to stop webhook subscriptions while transferring connected accounts from ${fromUserWorkspaceId}`,
        error,
      ),
    );

    if (this.repository.manager.queryRunner?.isTransactionActive)
      throw new Error('OMNI_METADATA_REQUIRES_FRESH_TRANSACTION');
    await transferConnectedAccountsWithAudit({
      dataSource: this.repository.manager.connection,
      workspaceId,
      fromUserWorkspaceId,
      toUserWorkspaceId,
      accountIds: connectedAccountIds,
      operation: capturedOperation,
      mutate: async (runner) => {
        const entityManager = runner.manager;
        await this.assertOrdinaryAccounts(
          workspaceId,
          connectedAccountIds,
          entityManager,
        );
        const transfer = await entityManager.update(
          ConnectedAccountEntity,
          {
            id: In(connectedAccountIds),
            workspaceId,
            userWorkspaceId: fromUserWorkspaceId,
          },
          {
            userWorkspaceId: toUserWorkspaceId,
            accessToken: null,
            refreshToken: null,
            connectionParameters: null,
          },
        );

        if (transfer.affected !== connectedAccountIds.length) {
          throw new Error('CONNECTED_ACCOUNT_CUSTODIAN_CHANGED_RETRY');
        }
        await entityManager.update(
          ConnectedAccountEntity,
          { id: In(connectedAccountIds), workspaceId, archivedAt: IsNull() },
          { archivedAt: new Date() },
        );

        await entityManager.update(
          MessageChannelEntity,
          { connectedAccountId: In(connectedAccountIds), workspaceId },
          { isSyncEnabled: false },
        );

        await entityManager.update(
          CalendarChannelEntity,
          { connectedAccountId: In(connectedAccountIds), workspaceId },
          { isSyncEnabled: false },
        );

        await entityManager.update(
          MessageChannelEntity,
          {
            connectedAccountId: In(connectedAccountIds),
            workspaceId,
            webhookSubscriptionStatus: WebhookSubscriptionStatus.PENDING,
          },
          { webhookSubscriptionStatus: WebhookSubscriptionStatus.EXPIRED },
        );

        await entityManager.update(
          CalendarChannelEntity,
          {
            connectedAccountId: In(connectedAccountIds),
            workspaceId,
            webhookSubscriptionStatus: WebhookSubscriptionStatus.PENDING,
          },
          { webhookSubscriptionStatus: WebhookSubscriptionStatus.EXPIRED },
        );
      },
    });

    for (const connectedAccount of connectedAccounts) {
      if (!isNativeMessengerAccount(connectedAccount)) {
        await this.appOAuthRevokeService.revokeIfApp(connectedAccount);
      }
    }
  }

  async captureDisconnectionAuditOperation(
    authentication: MembershipCleanupAuthentication & { workspaceId: string },
  ): Promise<CrmAuditOperation> {
    const workspaceId = authentication.workspaceId;
    const identity = await captureMembershipCleanupIdentity(
      authentication,
      async (membershipId) => {
        const [member] = await this.repository.manager.query(
          'SELECT "userId" FROM core."userWorkspace" WHERE id=$1',
          [membershipId],
        );
        return member?.userId;
      },
    );
    return membershipCleanupOperation(workspaceId, identity)!;
  }

  async disconnect({
    id,
    workspaceId,
    caller,
    auditOperation,
  }: {
    id: string;
    workspaceId: string;
    caller: { userWorkspaceId: string; applicationId?: string };
    auditOperation?: CrmAuditOperation;
  }): Promise<ConnectedAccountEntity> {
    if (this.repository.manager.queryRunner?.isTransactionActive)
      throw new Error('OMNI_METADATA_REQUIRES_FRESH_TRANSACTION');
    const capturedCaller = {
      userWorkspaceId: caller.userWorkspaceId,
      applicationId: caller.applicationId,
    };
    const operation = auditOperation
      ? {
          ...auditOperation,
          actor: { ...auditOperation.actor },
          ...(auditOperation.initiator
            ? { initiator: { ...auditOperation.initiator } }
            : {}),
        }
      : undefined;
    if (operation && operation.workspaceId !== workspaceId)
      throw new Error('Connected account disconnect audit workspace mismatch');
    const connectedAccount = await this.verifyAdministrableByCaller({
      id,
      workspaceId,
      ...capturedCaller,
    });

    await this.assertOrdinaryAccounts(workspaceId, [connectedAccount.id]);

    if (isDefined(connectedAccount.connectionProviderId)) {
      await this.connectionProviderLifecycleHookService.runOnDisconnect({
        connectionProviderId: connectedAccount.connectionProviderId,
        workspaceId,
        connectedAccountId: id,
      });
    }

    if (!isNativeMessengerAccount(connectedAccount)) {
      await this.appOAuthRevokeService.revokeIfApp(connectedAccount);
    }

    const [messageChannels, calendarChannels] = await Promise.all([
      this.messageChannelRepository.find({
        where: { connectedAccountId: id, workspaceId },
        select: { id: true, connectedAccountId: true },
      }),
      this.calendarChannelRepository.find({
        where: { connectedAccountId: id, workspaceId },
        select: { id: true, connectedAccountId: true },
      }),
    ]);

    await this.stopWebhookSubscriptions({
      messageChannels,
      calendarChannels,
      workspaceId,
      nativeAccountIds: new Set(
        isNativeMessengerAccount(connectedAccount) ? [id] : [],
      ),
    }).catch((error) =>
      this.logger.warn(
        `WorkspaceId: ${workspaceId} Failed to stop webhook subscriptions while disconnecting connected account ${id}`,
        error,
      ),
    );

    return disconnectConnectedAccountWithAudit({
      dataSource: this.repository.manager.connection,
      workspaceId,
      userWorkspaceId: capturedCaller.userWorkspaceId,
      accountIds: [id],
      operation,
      mutate: async (runner) => {
        const entityManager = runner.manager;
        await this.assertOrdinaryAccounts(workspaceId, [id], entityManager);
        const fresh = await entityManager
          .getRepository(ConnectedAccountEntity)
          .findOneOrFail({ where: { id, workspaceId } });
        if (
          !(await this.isAdministrableByCaller({
            connectedAccount: fresh,
            workspaceId,
            ...capturedCaller,
          }))
        )
          throw new ConnectedAccountException(
            `Connected account ${id} cannot be administered by user workspace ${capturedCaller.userWorkspaceId}`,
            ConnectedAccountExceptionCode.CONNECTED_ACCOUNT_OWNERSHIP_VIOLATION,
          );
        await entityManager.update(
          ConnectedAccountEntity,
          { id, workspaceId },
          {
            accessToken: null,
            refreshToken: null,
            connectionParameters: null,
            authFailedAt: null,
            authFailedReason: null,
          },
        );

        await entityManager.update(
          ConnectedAccountEntity,
          { id, workspaceId, archivedAt: IsNull() },
          { archivedAt: new Date() },
        );

        await entityManager.update(
          MessageChannelEntity,
          { connectedAccountId: id, workspaceId },
          { isSyncEnabled: false },
        );

        await entityManager.update(
          CalendarChannelEntity,
          { connectedAccountId: id, workspaceId },
          { isSyncEnabled: false },
        );

        await entityManager.update(
          MessageChannelEntity,
          {
            connectedAccountId: id,
            workspaceId,
            webhookSubscriptionStatus: WebhookSubscriptionStatus.PENDING,
          },
          { webhookSubscriptionStatus: WebhookSubscriptionStatus.EXPIRED },
        );

        await entityManager.update(
          CalendarChannelEntity,
          {
            connectedAccountId: id,
            workspaceId,
            webhookSubscriptionStatus: WebhookSubscriptionStatus.PENDING,
          },
          { webhookSubscriptionStatus: WebhookSubscriptionStatus.EXPIRED },
        );
        return entityManager
          .getRepository(ConnectedAccountEntity)
          .findOneOrFail({ where: { id, workspaceId } });
      },
    });
  }

  async deleteManyByConnectionProviderIds({
    connectionProviderIds,
    workspaceId,
    applicationId,
  }: {
    connectionProviderIds: string[];
    workspaceId: string;
    applicationId: string;
  }): Promise<void> {
    const boundary = captureAccountDeletionBoundary({
      kind: 'manifest',
      applicationId,
      connectionProviderIds,
    });
    connectionProviderIds = [...connectionProviderIds];
    const auditOperation =
      await this.captureDeletionAuditOperation(workspaceId);
    const connectedAccounts = await this.repository.find({
      where: { connectionProviderId: In(connectionProviderIds), workspaceId },
      select: { id: true },
    });

    await this.deleteMany({
      ids: connectedAccounts.map(({ id }) => id),
      workspaceId,
      boundary,
      auditOperation,
    });
  }

  async delete({
    id,
    workspaceId,
    caller,
    emailGroup,
    auditOperation,
  }: {
    id: string;
    workspaceId: string;
    caller: { userWorkspaceId: string; applicationId?: string };
    emailGroup?: { channelId: string; expectedHandle: string };
    auditOperation?: CrmAuditOperation;
  }): Promise<ConnectedAccountEntity> {
    const boundary = this.captureAdministrativeDeletionBoundary(
      workspaceId,
      caller,
      emailGroup ? { ...emailGroup, accountId: id } : undefined,
    );
    const operation = auditOperation
      ? {
          ...auditOperation,
          actor: { ...auditOperation.actor },
          ...(auditOperation.initiator
            ? { initiator: { ...auditOperation.initiator } }
            : {}),
        }
      : await this.captureDeletionAuditOperation(workspaceId);
    const connectedAccount = await this.repository.findOneOrFail({
      where: { id, workspaceId },
    });

    const deleted = await this.deleteMany({
      ids: [id],
      workspaceId,
      boundary,
      auditOperation: operation,
    });
    if (!deleted.accounts.some((account) => account.id === id.toLowerCase()))
      throw new Error(
        'Connected account deletion did not delete the requested account',
      );

    return connectedAccount;
  }

  async deleteMany({
    ids,
    workspaceId,
    boundary,
    auditOperation,
    caller,
  }: {
    ids: string[];
    workspaceId: string;
    boundary?: ConnectedAccountDeletionBoundary;
    auditOperation?: CrmAuditOperation;
    caller?: { userWorkspaceId: string; applicationId?: string };
  }): Promise<DeletedConnectedAccountGraph> {
    if (this.repository.manager.queryRunner?.isTransactionActive)
      throw new Error('OMNI_METADATA_REQUIRES_FRESH_TRANSACTION');
    if (!isUUID(workspaceId) || ids.some((id) => !isUUID(id)))
      throw new Error('Invalid connected account deletion scope');
    ids = [...new Set(ids.map((id) => id.toLowerCase()))];
    workspaceId = workspaceId.toLowerCase();
    let capturedBoundary = boundary
      ? captureAccountDeletionBoundary(boundary)
      : caller
        ? this.captureAdministrativeDeletionBoundary(workspaceId, caller)
        : undefined;
    const repair =
      !capturedBoundary && consumeAccountScopeRepairExecution(workspaceId);
    if (!capturedBoundary && !repair)
      throw new Error('Connected account deletion boundary unavailable');
    const operation = auditOperation
      ? {
          ...auditOperation,
          actor: { ...auditOperation.actor },
          ...(auditOperation.initiator
            ? { initiator: { ...auditOperation.initiator } }
            : {}),
        }
      : await this.captureDeletionAuditOperation(workspaceId);
    if (operation.workspaceId !== workspaceId || !isUUID(operation.operationId))
      throw new Error(
        'Connected account deletion requires scoped audit operation',
      );
    copyMembershipCleanupIdentity(
      {
        workspaceId,
        actor: operation.actor,
        initiator: operation.initiator,
        correlationId: operation.operationId,
      },
      workspaceId,
    );
    const empty: DeletedConnectedAccountGraph = {
      accounts: [],
      messageChannelIds: [],
      calendarChannelIds: [],
      messageFolderIds: [],
    };
    if (ids.length === 0) {
      return empty;
    }

    const connectedAccounts = await this.repository.find({
      where: { id: In(ids), workspaceId },
    });

    if (
      (repair || capturedBoundary?.kind !== 'administration') &&
      connectedAccounts.length !== ids.length
    )
      throw new Error('Connected account deletion selection changed');
    if (connectedAccounts.length === 0) {
      return empty;
    }

    if (repair) {
      const providerIdsByAccount: Record<string, string> = {};
      for (const account of connectedAccounts) {
        if (!account.connectionProviderId)
          throw new Error('Account scope repair requires provider');
        providerIdsByAccount[account.id] = account.connectionProviderId;
      }
      capturedBoundary = captureAccountDeletionBoundary({
        kind: 'providerScopeRepair',
        providerIdsByAccount,
      });
    }
    if (!capturedBoundary)
      throw new Error('Connected account deletion boundary unavailable');
    if (
      capturedBoundary.kind === 'administration' ||
      capturedBoundary.kind === 'emailGroup'
    ) {
      const [member] = await this.repository.manager.query(
        'SELECT id FROM core."userWorkspace" WHERE id=$1 AND "workspaceId"=$2 AND "deletedAt" IS NULL',
        [capturedBoundary.userWorkspaceId, workspaceId],
      );
      if (!member)
        throw new Error('Connected account deletion prerequisites changed');
      for (const account of connectedAccounts)
        if (
          !(await capturedBoundary.authorize(
            Object.freeze({
              id: account.id,
              userWorkspaceId: account.userWorkspaceId,
              scope: account.scope,
              provider: account.provider,
            }),
          ))
        )
          throw new Error('Connected account deletion permission denied');
    } else {
      const providerIds =
        capturedBoundary.kind === 'manifest'
          ? [...capturedBoundary.connectionProviderIds]
          : [...new Set(Object.values(capturedBoundary.providerIdsByAccount))];
      const providers: {
        id: string;
        workspaceId: string;
        applicationId: string;
        scope: string;
      }[] = await this.repository.manager.query(
        'SELECT id,"workspaceId","applicationId",scope FROM core."connectionProvider" WHERE id=ANY($1::uuid[])',
        [providerIds],
      );
      for (const account of connectedAccounts) {
        const provider = providers.find(
          (item) => item.id === account.connectionProviderId,
        );
        if (
          !provider ||
          provider.workspaceId !== workspaceId ||
          (capturedBoundary.kind === 'manifest' &&
            provider.applicationId !== capturedBoundary.applicationId) ||
          (capturedBoundary.kind === 'providerScopeRepair' &&
            (provider.id !==
              capturedBoundary.providerIdsByAccount[account.id] ||
              provider.scope === account.scope))
        )
          throw new Error(
            'Connected account deletion provider selection changed',
          );
      }
    }

    const connectedAccountIds = connectedAccounts.map(({ id }) => id);

    await this.assertOrdinaryAccounts(workspaceId, connectedAccountIds);

    const [messageChannels, calendarChannels] = await Promise.all([
      this.messageChannelRepository.find({
        where: { connectedAccountId: In(connectedAccountIds) },
        select: {
          id: true,
          connectedAccountId: true,
          workspaceId: true,
          type: true,
        },
      }),
      this.calendarChannelRepository.find({
        where: { connectedAccountId: In(connectedAccountIds) },
        select: { id: true, connectedAccountId: true, workspaceId: true },
      }),
    ]);

    if (
      [...messageChannels, ...calendarChannels].some(
        (channel) => channel.workspaceId !== workspaceId,
      )
    )
      throw new Error('Connected account deletion graph workspace mismatch');
    if (capturedBoundary.kind === 'emailGroup') {
      const emailGroup = capturedBoundary;
      const channel = messageChannels.find(
        (item) => item.id === emailGroup.channelId,
      );
      if (
        connectedAccounts.length !== 1 ||
        connectedAccounts[0].id !== emailGroup.accountId ||
        connectedAccounts[0].handle !== emailGroup.expectedHandle ||
        channel?.connectedAccountId !== emailGroup.accountId ||
        channel.type !== 'EMAIL_GROUP'
      )
        throw new Error('Email group deletion target changed');
    }

    const folders: { id: string; workspaceId: string }[] =
      await this.repository.manager.query(
        'SELECT folder.id, folder."workspaceId" FROM core."messageFolder" folder JOIN core."messageChannel" channel ON channel.id=folder."messageChannelId" WHERE channel."connectedAccountId"=ANY($1::uuid[])',
        [connectedAccountIds],
      );
    if (folders.some((folder) => folder.workspaceId !== workspaceId))
      throw new Error('Connected account deletion graph workspace mismatch');
    if (
      (
        await findOmniOwnedMessageFolderIds(
          {
            executeRawQuery: (sql, parameters) =>
              this.repository.manager.query(sql, parameters),
          },
          workspaceId,
          folders.map(({ id }) => id),
        )
      ).size
    )
      throw new Error(
        'Connected account deletion excludes retained omni resources',
      );

    this.logger.log(
      `WorkspaceId: ${workspaceId} Deleting ${connectedAccounts.length} connected account(s) with ${messageChannels.length} message channel(s) and ${calendarChannels.length} calendar channel(s)`,
    );

    for (const { id, connectionProviderId } of connectedAccounts) {
      if (isDefined(connectionProviderId)) {
        await this.connectionProviderLifecycleHookService.runOnDisconnect({
          connectionProviderId,
          workspaceId,
          connectedAccountId: id,
        });
      }
    }

    await this.stopWebhookSubscriptions({
      messageChannels,
      calendarChannels,
      workspaceId,
      nativeAccountIds: new Set(
        connectedAccounts.filter(isNativeMessengerAccount).map(({ id }) => id),
      ),
    });

    // Hooks may have refreshed tokens through getConnection and an overlapping delete may have removed rows
    const latestConnectedAccounts = await this.repository.find({
      where: { id: In(connectedAccountIds), workspaceId },
    });

    for (const latestConnectedAccount of latestConnectedAccounts) {
      if (!isNativeMessengerAccount(latestConnectedAccount)) {
        await this.appOAuthRevokeService.revokeIfApp(latestConnectedAccount);
      }
    }

    const deleted = await deleteConnectedAccountsWithAudit({
      dataSource: this.repository.manager.connection,
      workspaceId,
      accountIds: connectedAccountIds,
      operation,
      boundary: capturedBoundary,
    });

    try {
      this.workspaceEventEmitter.emitCustomBatchEvent<MessageChannelDeletedEvent>(
        MESSAGE_CHANNEL_DELETED_EVENT,
        deleted.messageChannelIds.map((messageChannelId) => ({
          messageChannelId,
        })),
        workspaceId,
      );

      this.workspaceEventEmitter.emitCustomBatchEvent<CalendarChannelDeletedEvent>(
        CALENDAR_CHANNEL_DELETED_EVENT,
        deleted.calendarChannelIds.map((calendarChannelId) => ({
          calendarChannelId,
        })),
        workspaceId,
      );

      this.workspaceEventEmitter.emitCustomBatchEvent<ConnectedAccountDeletedEvent>(
        CONNECTED_ACCOUNT_DELETED_EVENT,
        deleted.accounts.map(({ id, userWorkspaceId }) => ({
          connectedAccountId: id,
          userWorkspaceId,
        })),
        workspaceId,
      );
    } catch (error) {
      throw new CoreAuditPostCommitError(error);
    }
    return deleted;
  }

  private async captureDeletionAuditOperation(
    workspaceId: string,
  ): Promise<CrmAuditOperation> {
    if (this.repository.manager.queryRunner?.isTransactionActive)
      throw new Error('OMNI_METADATA_REQUIRES_FRESH_TRANSACTION');
    const identity = await captureCurrentCrmAuditIdentity(
      workspaceId,
      async (membershipId) => {
        const [member] = await this.repository.manager.query(
          'SELECT "userId" FROM core."userWorkspace" WHERE id=$1',
          [membershipId],
        );
        return member?.userId;
      },
    );
    const operation = membershipCleanupOperation(workspaceId, identity);
    if (!operation)
      throw new Error('Connected account deletion requires audit identity');
    return operation;
  }

  private captureAdministrativeDeletionBoundary(
    workspaceId: string,
    caller: { userWorkspaceId: string; applicationId?: string },
    emailGroup?: {
      channelId: string;
      accountId: string;
      expectedHandle: string;
    },
  ): ConnectedAccountDeletionBoundary {
    const capturedCaller = {
      userWorkspaceId: caller.userWorkspaceId,
      applicationId: caller.applicationId,
    };
    return captureAccountDeletionBoundary({
      ...capturedCaller,
      ...(emailGroup
        ? { kind: 'emailGroup' as const, ...emailGroup }
        : { kind: 'administration' as const }),
      authorize: async (account) => {
        const provider = Object.values(ConnectedAccountProvider).find(
          (value) => value === account.provider,
        );
        if (!provider) return false;
        return this.isAdministrableByCaller({
          connectedAccount: { ...account, provider },
          workspaceId,
          ...capturedCaller,
        });
      },
    });
  }

  private async assertOrdinaryAccounts(
    workspaceId: string,
    connectedAccountIds: string[],
    manager: EntityManager = this.repository.manager,
  ): Promise<void> {
    const ownedIds = await findOmniOwnedConnectedAccountIds(
      {
        executeRawQuery: (sql, parameters) => manager.query(sql, parameters),
      },
      workspaceId,
      connectedAccountIds,
    );

    if (ownedIds.size > 0) {
      throw new Error('OMNI_OWNED_ACCOUNT_REQUIRES_DOMAIN_LIFECYCLE');
    }
  }

  private async stopWebhookSubscriptions({
    messageChannels,
    calendarChannels,
    workspaceId,
    nativeAccountIds,
  }: {
    messageChannels: Pick<MessageChannelEntity, 'id' | 'connectedAccountId'>[];
    calendarChannels: Pick<
      CalendarChannelEntity,
      'id' | 'connectedAccountId'
    >[];
    workspaceId: string;
    nativeAccountIds: Set<string>;
  }): Promise<void> {
    await Promise.all([
      ...messageChannels
        .filter((channel) => !nativeAccountIds.has(channel.connectedAccountId))
        .map(({ id: messageChannelId }) =>
          this.messagingWebhookSubscriptionService.deleteSubscription(
            messageChannelId,
            workspaceId,
          ),
        ),
      ...calendarChannels
        .filter((channel) => !nativeAccountIds.has(channel.connectedAccountId))
        .map(({ id: calendarChannelId }) =>
          this.calendarWebhookSubscriptionService.deleteSubscription(
            calendarChannelId,
            workspaceId,
          ),
        ),
    ]);
  }
}
